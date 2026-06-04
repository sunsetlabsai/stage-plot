import { NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

// DELETE /api/songs/delete — delete a song (owner-only)
export async function DELETE(request: NextRequest) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { id } = await request.json();

  if (!id) {
    return Response.json({ error: 'Song id is required' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  const { data, error } = await admin.rpc('rpc_delete_song', {
    p_song_id: id,
    p_owner_id: user.id,
  });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  // Delete storage blobs for removed charts
  const storagePaths = data?.storage_paths || [];
  if (storagePaths.length > 0) {
    await admin.storage.from('charts').remove(storagePaths);
  }

  return Response.json({
    deleted: true,
    affected_shows: data?.affected_shows || [],
  });
}
