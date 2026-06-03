import { NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';

// PUT /api/shows/update — save show config (authenticated, RLS-enforced)
// Slugs are immutable after creation — only the display name changes.
export async function PUT(request: NextRequest) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { id, config, name, venue, show_date } = await request.json();

  if (!id || !config) {
    return Response.json({ error: 'id and config are required' }, { status: 400 });
  }

  const effectiveName = name || config.showInfo?.showName || config.showInfo?.bandName || 'Untitled';

  const updatePayload: Record<string, unknown> = {
    config,
    name: effectiveName,
    venue: venue || config.showInfo?.venue || null,
    show_date: show_date || config.showInfo?.eventDate || null,
  };

  const { data, error } = await supabase
    .from('shows')
    .update(updatePayload)
    .eq('id', id)
    .select('updated_at, slug')
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 403 });
  }

  return Response.json({ updated_at: data.updated_at, slug: data.slug });
}
