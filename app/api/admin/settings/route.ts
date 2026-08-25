import { NextRequest } from 'next/server';
import { getAllAdminConfig } from '@/lib/admin-config';
import { checkRateLimit, getIp } from '@/lib/admin-rate-limit';
import { requirePlatformAdmin } from '@/lib/admin-auth';

// GET /api/admin/settings — read-only config status for the /admin page.
// Auth: platform super-admin session (design-single-backend §3.3a, §3.3b).
//
// PUT was DELETED here. Its only body was setAdminConfig(), a Redis write, and
// §3 rules there is no store: config resolves from process.env alone and the
// try-it key changes via Vercel env + redeploy. Re-authing a verb with nothing
// left to write would have shipped a permanently dead endpoint — the §2.1
// pattern this design exists to end. The masked values below are the whole
// remaining surface.
export async function GET(request: NextRequest) {
  const ip = getIp(request);
  if (!checkRateLimit(ip, 'settings')) {
    return Response.json({ error: 'Too many requests' }, { status: 429 });
  }

  const denied = await requirePlatformAdmin();
  if (denied) return denied;

  const config = await getAllAdminConfig();
  return Response.json({ config });
}
