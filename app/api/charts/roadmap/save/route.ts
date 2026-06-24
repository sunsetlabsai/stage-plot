import { NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { normalizeSongKey, canonicalizeRole } from '@/lib/normalize';
import { validateRoadmapSpec } from '@/lib/roadmap-spec';
import { renderRoadmap } from '@/lib/roadmap-render';
import { assertSpecCalibrationParity } from '@/lib/roadmap-save';
import { hashPdfBytes, isValidCalibration, canVerify } from '@/lib/chart-calibration';
import { schemaVersionToPersist } from '@/lib/chart-converter';

// pdf-lib + crypto.subtle run in the Node runtime; this route renders the PDF
// server-side (never trusting client bytes) so the persisted calibration is
// born from the SAME render that produced the stored PDF.
export const runtime = 'nodejs';

const MIME = 'application/pdf';

interface PostBody {
  spec?: unknown;
  song_title?: string;
  role?: string;
}

// POST /api/charts/roadmap/save — commit a builder chart. The client sends the
// AUTHORED RoadmapSpec (proposed by the AI parse step, possibly hand-edited);
// the SERVER re-validates, re-renders {pdfBytes, calibration}, asserts spec↔
// calibration parity (renderer-bug guard), gates on isValidCalibration/canVerify,
// stages the hash-addressed PDF, then commits both tables atomically via the
// save_builder_chart RPC. Source of truth is the spec; the PDF + calibration are
// derived artifacts re-rendered here, so a tampered client payload can't smuggle
// in a mismatched PDF/calibration. RBAC: authed owner only.
export async function POST(request: NextRequest) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const songTitle = typeof body.song_title === 'string' ? body.song_title.trim() : '';
  if (!songTitle) {
    return Response.json({ error: 'song_title is required' }, { status: 400 });
  }
  if (typeof body.role !== 'string' || !body.role.trim()) {
    return Response.json({ error: 'role is required' }, { status: 400 });
  }

  // Re-validate the spec server-side — the AI parse gate ran client-side, but the
  // save path never trusts the caller; a malformed/hallucinated spec dies here.
  const validation = validateRoadmapSpec(body.spec);
  if (!validation.ok) {
    return Response.json({ error: 'Invalid spec', details: validation.errors }, { status: 400 });
  }
  const spec = validation.spec;

  let songKey: string;
  try {
    songKey = normalizeSongKey(songTitle);
  } catch {
    return Response.json({ error: 'Invalid song title — cannot be empty or punctuation-only' }, { status: 400 });
  }
  const role = canonicalizeRole(body.role);

  // Render server-side: spec → {pdfBytes, born-verified calibration}.
  const { pdfBytes, calibration } = await renderRoadmap(spec, { songTitle });

  // Renderer-bug guard: prove the calibration faithfully describes the spec before
  // it is ever hashed or persisted (a renderer regression that drops/miscounts a
  // bar or marker is caught here → 5xx, persist nothing).
  const parity = assertSpecCalibrationParity(spec, calibration);
  if (!parity.ok) {
    return Response.json({ error: 'Render parity check failed', details: parity.errors }, { status: 500 });
  }

  // Shape + promotion gate: only a structurally-valid, resolvable calibration may
  // be stored as 'verified'.
  if (!isValidCalibration(calibration) || !canVerify(calibration)) {
    return Response.json({ error: 'Calibration failed verification gate' }, { status: 500 });
  }

  // Hash the exact bytes we are about to store — the de-facto chart version and
  // the calibration's address.
  const sourceHash = await hashPdfBytes(pdfBytes);

  // Stage at a HASH-ADDRESSED path (never the stable live path): a re-render with
  // a different hash writes a NEW object, so the previous artifact stays intact
  // until the DB commit lands and we reclaim it. Upsert is idempotent for retries
  // of the same hash.
  const storagePath = `${user.id}/${songKey}/${role}/${sourceHash}.pdf`;
  const admin = getSupabaseAdmin();
  const { error: uploadError } = await admin.storage
    .from('charts')
    .upload(storagePath, pdfBytes, { contentType: MIME, upsert: true });
  if (uploadError) {
    return Response.json({ error: uploadError.message }, { status: 500 });
  }

  // Commit both tables atomically. Called with the USER client so the RPC's
  // auth.uid() ownership guard sees the caller's identity.
  const { data: result, error: rpcError } = await supabase.rpc('save_builder_chart', {
    p_owner: user.id,
    p_song_key: songKey,
    p_song_title: songTitle,
    p_role: role,
    p_file_name: `${songKey}-${role}.pdf`,
    p_storage_path: storagePath,
    p_mime_type: MIME,
    p_file_size: pdfBytes.length,
    p_source_spec: spec,
    p_source_hash: sourceHash,
    p_schema_version: schemaVersionToPersist(calibration),
    p_status: calibration.status,
    p_calibration: {
      sections: calibration.sections,
      systems: calibration.systems,
      bars: calibration.bars,
      roadmap: calibration.roadmap,
    },
  });

  if (rpcError) {
    // Roll back the staged object — the commit didn't land.
    await admin.storage.from('charts').remove([storagePath]);
    return Response.json({ error: rpcError.message }, { status: 500 });
  }

  const { chart_id: chartId, old_storage_path: oldPath } =
    (result ?? {}) as { chart_id?: string; old_storage_path?: string | null };

  // Best-effort reclaim of the now-orphaned previous object (only if it moved).
  if (oldPath && oldPath !== storagePath) {
    await admin.storage.from('charts').remove([oldPath]);
  }

  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/charts/${storagePath}`;

  return Response.json(
    { chart_id: chartId, song_key: songKey, role, storage_path: storagePath, source_hash: sourceHash, url },
    { status: 201 },
  );
}
