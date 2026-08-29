import { NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { validateRoadmapSpec } from '@/lib/roadmap-spec';

// GET /api/charts/roadmap/[chartId] — the source-spec read door for editing.
// The full RoadmapSpec is server-only (the song/show lists expose only is_builder
// + authored_key, not the whole spec), so the builder fetches it lazily on Edit.
//
// OWNER-ONLY by construction: we read the row with the admin client and assert
// owner_id === user.id ourselves, NOT through chart_library RLS — the
// "Collaborator read charts" policy grants collaborators select access, and an
// edit door must be the owner's alone. 404 covers both not-found and not-owned so
// it never leaks the existence of another owner's chart. 422 means the row exists
// but isn't editable-as-spec (no source_spec, or a corrupt/hand-edited one) —
// caught here at the read boundary rather than crashing specToView downstream.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ chartId: string }> },
) {
  const { chartId } = await params;

  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const admin = getSupabaseAdmin();
  const { data: row } = await admin
    .from('chart_library')
    .select('id, owner_id, role, song_title, song_key, updated_at, source_spec, source_prompt')
    .eq('id', chartId)
    .maybeSingle();

  // Not found OR not the caller's chart → 404 (don't reveal another owner's row).
  if (!row || row.owner_id !== user.id) {
    return Response.json({ error: 'Chart not found' }, { status: 404 });
  }

  // Exists but carries no spec (an uploaded/converted chart) → not editable here.
  if (row.source_spec == null) {
    return Response.json({ error: 'Chart is not a builder chart' }, { status: 422 });
  }

  // Validate before handing the spec to the client — the same gate the save route
  // runs server-side. Corrupt DB state fails clean at the door (422), never as a
  // downstream specToView crash.
  const validation = validateRoadmapSpec(row.source_spec);
  if (!validation.ok) {
    return Response.json(
      { error: 'Chart spec is invalid', details: validation.errors },
      { status: 422 },
    );
  }

  return Response.json({
    chart_id: row.id,
    role: row.role,
    song_title: row.song_title,
    song_key: row.song_key,
    updated_at: row.updated_at,
    source_spec: validation.spec,
    // The prompt that authored this chart (may be null: legacy/pre-016 rows, or a
    // chart that was de-buildered and re-built). The builder seeds its refine box
    // from it (?? '') so Regenerate works on a re-opened chart.
    source_prompt: typeof row.source_prompt === 'string' ? row.source_prompt : null,
  });
}
