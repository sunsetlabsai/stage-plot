import { NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { normalizeSongKey, canonicalizeRole } from '@/lib/normalize';
import { sniffPdf, PDF_MIME } from '@/lib/chart-converter';

// POST /api/charts/upload — upload a chart to owner's library
export async function POST(request: NextRequest) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  const songTitle = formData.get('song_title') as string | null;
  const rawRole = formData.get('role') as string | null;

  if (!file || !songTitle || !rawRole) {
    return Response.json(
      { error: 'file, song_title, and role are required' },
      { status: 400 },
    );
  }

  // Normalize and canonicalize
  let songKey: string;
  try {
    songKey = normalizeSongKey(songTitle);
  } catch {
    return Response.json({ error: 'Invalid song title — cannot be empty or punctuation-only' }, { status: 400 });
  }

  // §1.2 part 2: the picker's `accept` is a HINT; this is the boundary. Classify
  // by the leading bytes, never by `file.type` — that is caller-controlled and
  // can be empty or spoofed, so a MIME check would let PNG bytes labelled
  // application/pdf through and strand every performer on a blank canvas.
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!sniffPdf(bytes)) {
    return Response.json(
      { error: 'Charts must be PDF files — this file is not a PDF.' },
      { status: 400 },
    );
  }

  const role = canonicalizeRole(rawRole);
  // §1.2 part 2b: the sniff is the authority, so the stored EXTENSION follows it
  // too — a real PDF named "chart.png" must not be stored at a `.png` path while
  // its contentType says application/pdf. Every disagreement between what we
  // stored and what we say we stored is a future viewer bug.
  const storagePath = `${user.id}/${songKey}/${role}.pdf`;

  const admin = getSupabaseAdmin();

  // Check for existing chart with different extension (orphan risk)
  const { data: existing } = await supabase
    .from('chart_library')
    .select('storage_path')
    .eq('owner_id', user.id)
    .eq('song_key', songKey)
    .eq('role', role)
    .single();

  const oldPath = existing?.storage_path !== storagePath ? existing?.storage_path : null;

  // Upload new blob FIRST (before deleting old — safe on failure)
  const { error: uploadError } = await admin.storage
    .from('charts')
    .upload(storagePath, bytes, {
      // §1.2 part 2b: normalize — persist what the sniff determined, never what
      // the caller claimed. A browser mislabelling a real PDF (empty type, or
      // image/png from a bad OS guess) is exactly the case the sniff exists to
      // rescue; storing that claim would hand the viewer a lie about its own file.
      contentType: PDF_MIME,
      upsert: true,
    });

  if (uploadError) {
    return Response.json({ error: uploadError.message }, { status: 500 });
  }

  // Only delete old blob AFTER new upload succeeds (no data loss on failure)
  if (oldPath) {
    await admin.storage.from('charts').remove([oldPath]);
  }

  // Upsert chart metadata. A regular upload is NOT a builder chart, so clear any
  // source_spec the slot may carry — replacing a builder chart with an ordinary
  // PDF/image in the same (owner, song, role) must not leave the old authored
  // spec behind (otherwise both routes would still classify it as is_builder).
  const { data: chart, error: dbError } = await supabase
    .from('chart_library')
    .upsert(
      {
        owner_id: user.id,
        song_key: songKey,
        song_title: songTitle,
        role,
        file_name: file.name,
        storage_path: storagePath,
        mime_type: PDF_MIME, // §1.2 part 2b — normalized, not `file.type`
        file_size: file.size,
        source_spec: null,
      },
      { onConflict: 'owner_id,song_key,role' },
    )
    .select('id, song_key, role, file_name, storage_path, mime_type, file_size, updated_at')
    .single();

  if (dbError) {
    await admin.storage.from('charts').remove([storagePath]);
    return Response.json({ error: dbError.message }, { status: 500 });
  }

  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/charts/${storagePath}`;

  // Explicit re-key contract: an upload is never a builder chart.
  return Response.json({ ...chart, url, is_builder: false, authored_key: null, charted_key: null }, { status: 201 });
}
