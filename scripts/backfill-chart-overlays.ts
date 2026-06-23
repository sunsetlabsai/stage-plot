/**
 * A2 backfill: one-time auto-overlay generation over the existing chart library.
 *
 * Mirrors the /api/charts/convert route's per-chart logic (download authoritative
 * bytes → magic-byte sniff → size cap → hash → existence pre-check → vision →
 * map → insert-on-conflict) but iterates EVERY chart with the service-role client.
 *
 * Idempotent + edit-safe by construction: it skips any (chart, hash) that already
 * has a calibration row and only ever INSERTs … ON CONFLICT DO NOTHING, so it
 * never clobbers a human-verified or draft overlay. Safe to re-run.
 *
 * Run with: npx tsx scripts/backfill-chart-overlays.ts
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, and the Anthropic
 * key resolved the same way the convert route resolves it: REDIS_URL with
 * admin:claude_tryit_key set, or a CLAUDE_TRYIT_KEY env var.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getAdminConfig } from '../lib/admin-config';
import { hashPdfBytes } from '../lib/chart-calibration';
import {
  MAX_PDF_BYTES,
  buildCalibrationFromVision,
  schemaVersionToPersist,
  sniffPdf,
} from '../lib/chart-converter';
import { extractChartVision, VISION_TIMEOUT_MS } from '../lib/chart-vision';

type Outcome =
  | { kind: 'generated' }
  | { kind: 'skipped'; reason: 'exists' | 'unsupported_type' | 'too_large' }
  | { kind: 'failed'; reason: string };

interface ChartRow {
  id: string;
  song_title: string;
  role: string;
  storage_path: string;
}

async function convertOne(
  admin: SupabaseClient,
  apiKey: string,
  chart: ChartRow,
): Promise<Outcome> {
  // 1. Fetch bytes from the authoritative storage object (parity with the viewer hash).
  const { data: blob, error: dlError } = await admin.storage.from('charts').download(chart.storage_path);
  if (dlError || !blob) {
    return { kind: 'failed', reason: `download error: ${dlError?.message ?? 'no object'}` };
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());

  // 2. Classify by magic bytes (v1 is PDF-only) and cap size before any vision call.
  if (!sniffPdf(bytes)) return { kind: 'skipped', reason: 'unsupported_type' };
  if (bytes.length > MAX_PDF_BYTES) return { kind: 'skipped', reason: 'too_large' };

  // 3. Hash, then pre-check: a row for this (chart, hash) already exists → no-op.
  const sourceHash = await hashPdfBytes(bytes);
  const { data: existing } = await admin
    .from('chart_calibration')
    .select('chart_id')
    .eq('chart_id', chart.id)
    .eq('source_hash', sourceHash)
    .maybeSingle();
  if (existing) return { kind: 'skipped', reason: 'exists' };

  // 4. Vision extract, aborted comfortably under the route's production ceiling.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  let vision;
  try {
    vision = await extractChartVision(bytes, apiKey, controller.signal);
  } catch (err) {
    if (err instanceof Anthropic.BadRequestError) return { kind: 'skipped', reason: 'too_large' };
    return { kind: 'failed', reason: err instanceof Error ? err.message : 'vision error' };
  } finally {
    clearTimeout(timer);
  }

  // 5. Map + validate. null = nothing usable → leave to the manual rail.
  if (!vision) return { kind: 'failed', reason: 'no structure extracted' };
  const calibration = buildCalibrationFromVision(vision);
  if (!calibration) return { kind: 'failed', reason: 'unmappable extraction' };

  // 6. Persist (the real guard): INSERT … ON CONFLICT (chart_id, source_hash) DO
  //    NOTHING RETURNING *. Empty RETURNING ⟹ a row already existed (race / re-run).
  const { data: inserted, error: insertError } = await admin
    .from('chart_calibration')
    .upsert(
      {
        chart_id: chart.id,
        source_hash: sourceHash,
        schema_version: schemaVersionToPersist(calibration),
        status: calibration.status,
        graph: {
          sections: calibration.sections,
          systems: calibration.systems,
          bars: calibration.bars,
          roadmap: calibration.roadmap,
        },
      },
      { onConflict: 'chart_id,source_hash', ignoreDuplicates: true },
    )
    .select('chart_id');
  if (insertError) return { kind: 'failed', reason: insertError.message };
  if (!inserted || inserted.length === 0) return { kind: 'skipped', reason: 'exists' };

  return { kind: 'generated' };
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  // Resolve the Anthropic key from the SAME source as the convert route. No key
  // ⟹ nothing can be generated, so abort rather than logging N failures.
  const apiKey = await getAdminConfig('claude_tryit_key');
  if (!apiKey) {
    console.error('No Anthropic key (admin:claude_tryit_key / CLAUDE_TRYIT_KEY) — nothing to do.');
    process.exit(1);
  }

  const admin = createClient(url, serviceKey);

  const { data: charts, error } = await admin
    .from('chart_library')
    .select('id, song_title, role, storage_path')
    .order('created_at', { ascending: true });
  if (error) {
    console.error('Could not read chart_library:', error.message);
    process.exit(1);
  }
  if (!charts || charts.length === 0) {
    console.log('No charts in the library — nothing to backfill.');
    return;
  }

  console.log(`Backfilling overlays for ${charts.length} chart(s)…\n`);
  const tally = { generated: 0, skipped: 0, failed: 0 };

  for (const chart of charts as ChartRow[]) {
    const label = `${chart.song_title} [${chart.role}]`;
    const outcome = await convertOne(admin, apiKey, chart);
    if (outcome.kind === 'generated') {
      tally.generated++;
      console.log(`  ✓ generated  ${label}`);
    } else if (outcome.kind === 'skipped') {
      tally.skipped++;
      console.log(`  – skipped    ${label} (${outcome.reason})`);
    } else {
      tally.failed++;
      console.log(`  ✗ failed     ${label} (${outcome.reason})`);
    }
  }

  console.log(
    `\nDone. ${tally.generated} generated, ${tally.skipped} skipped, ${tally.failed} failed.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
