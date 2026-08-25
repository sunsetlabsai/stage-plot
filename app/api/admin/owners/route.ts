import { NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { checkRateLimit, getIp } from '@/lib/admin-rate-limit';
import { requirePlatformAdmin } from '@/lib/admin-auth';

// GET /api/admin/owners — the /admin page's "Registered Owners" section.
// Auth: platform super-admin session (design-single-backend §3.3a, §3.3b).
//
// design-owner-onboarding.md §61 had this route validate its secret
// independently of KV so the owner list still rendered when settings 503'd on
// an unreachable store. That degradation path is GONE, deliberately: both
// routes now read the same environment and the same Postgres, so there is no
// partial-availability case left to preserve.
export async function GET(request: NextRequest) {
  const ip = getIp(request);
  if (!checkRateLimit(ip, 'owners')) {
    return Response.json({ error: 'Too many requests' }, { status: 429 });
  }

  const denied = await requirePlatformAdmin();
  if (denied) return denied;

  const admin = getSupabaseAdmin();

  // 1. Fetch all profiles
  const { data: profiles, error: profilesErr } = await admin
    .from('profiles')
    .select('id, owner_slug, display_name, created_at')
    .order('created_at', { ascending: false });

  if (profilesErr || !profiles) {
    return Response.json({ error: 'Failed to load profiles' }, { status: 500 });
  }

  // 2. Fetch show counts grouped by owner_id
  const { data: shows, error: showsErr } = await admin
    .from('shows')
    .select('owner_id');

  if (showsErr) {
    return Response.json({ error: 'Failed to load shows' }, { status: 500 });
  }

  const showCounts: Record<string, number> = {};
  for (const s of shows || []) {
    showCounts[s.owner_id] = (showCounts[s.owner_id] || 0) + 1;
  }

  // 3. Fetch emails via admin auth API (default is 50/page, request 1000)
  const emailMap: Record<string, string> = {};
  let warning: string | undefined;

  try {
    const { data, error: usersErr } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });

    if (usersErr || !data?.users) {
      warning = 'Could not load user emails';
    } else {
      for (const u of data.users) {
        emailMap[u.id] = u.email || '';
      }
    }
  } catch {
    warning = 'Could not load user emails';
  }

  // 4. Assemble
  const owners = profiles.map((p) => ({
    owner_slug: p.owner_slug,
    display_name: p.display_name,
    email: emailMap[p.id] || null,
    show_count: showCounts[p.id] || 0,
    created_at: p.created_at,
  }));

  return Response.json({ owners, ...(warning && { warning }) });
}
