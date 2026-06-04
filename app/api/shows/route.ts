import { NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';

const RESERVED_SLUGS = new Set([
  'dashboard', 'sign-in', 'sign-out', 'api', 'admin',
  'settings', 'new', 'import', 'export', 'about', 'help',
  'pricing', 'terms', 'privacy', 'favicon.ico', 'robots.txt',
]);

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// GET /api/shows — list authenticated user's shows
export async function GET() {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // Get user's profile for owner_slug
  const { data: profile } = await supabase
    .from('profiles')
    .select('owner_slug')
    .eq('id', user.id)
    .single();

  const ownerSlug = profile?.owner_slug || '';

  // Get owned shows
  const { data: owned } = await supabase
    .from('shows')
    .select('id, slug, name, venue, show_date, updated_at')
    .eq('owner_id', user.id)
    .order('updated_at', { ascending: false });

  // Get shows user collaborates on (include owner's profile for URL)
  const { data: collabs } = await supabase
    .from('show_collaborators')
    .select('show_id, role, shows(id, slug, name, venue, show_date, updated_at, owner_id)')
    .eq('user_id', user.id);

  // Resolve owner slugs for collaborated shows
  const collabOwnerIds = [...new Set(
    (collabs || [])
      .map((c) => (c.shows as unknown as { owner_id: string })?.owner_id)
      .filter(Boolean),
  )];

  let ownerSlugsMap: Record<string, string> = {};
  if (collabOwnerIds.length > 0) {
    const { data: ownerProfiles } = await supabase
      .from('profiles')
      .select('id, owner_slug')
      .in('id', collabOwnerIds);

    ownerSlugsMap = Object.fromEntries(
      (ownerProfiles || []).map((p) => [p.id, p.owner_slug]),
    );
  }

  return Response.json({
    owner_slug: ownerSlug,
    owned: (owned || []).map((s) => ({ ...s, owner_slug: ownerSlug })),
    collaborating: (collabs || []).map((c) => {
      const show = c.shows as unknown as Record<string, unknown>;
      return {
        ...show,
        role: c.role,
        owner_slug: ownerSlugsMap[show.owner_id as string] || '',
      };
    }),
  });
}

// POST /api/shows — create a new show
export async function POST(request: NextRequest) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const body = await request.json();
  const { config, venue, show_date } = body;
  let { name } = body;

  if (!config) {
    return Response.json({ error: 'config is required' }, { status: 400 });
  }
  if (typeof name !== 'string' || !name) {
    return Response.json({ error: 'name must be a non-empty string' }, { status: 400 });
  }

  name = name.trim().slice(0, 100);
  if (!name) {
    return Response.json({ error: 'Name is required' }, { status: 400 });
  }

  // Generate slug with collision handling
  const baseSlug = slugify(name);
  if (!baseSlug) {
    return Response.json({ error: 'Name must contain at least one letter or number' }, { status: 400 });
  }
  let slug = baseSlug;

  if (RESERVED_SLUGS.has(slug)) {
    slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    // Validate date format — Postgres date column rejects invalid strings
    const validDate = show_date && /^\d{4}-\d{2}-\d{2}$/.test(show_date) ? show_date : null;

    const { data, error } = await supabase
      .from('shows')
      .insert({
        slug,
        owner_id: user.id,
        config,
        name,
        venue: venue || null,
        show_date: validDate,
      })
      .select('id, slug, updated_at')
      .single();

    if (!error && data) {
      return Response.json(data, { status: 201 });
    }

    // Unique constraint violation — try with suffix
    if (error?.code === '23505') {
      slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
      continue;
    }

    return Response.json({ error: error?.message || 'Failed to create show', code: error?.code }, { status: 500 });
  }

  return Response.json({ error: 'Could not generate unique slug' }, { status: 409 });
}
