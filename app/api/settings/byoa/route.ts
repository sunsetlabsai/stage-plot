import { NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { normalizeKey, keyFormatMessage } from '@/lib/byoa-key-format';

// The account-stored half of BYOA (§4.5's "Save to my account").
// The other half — "Remember on this device" — never reaches the server at all;
// it lives in lib/byoa-key-storage.ts and stays in the browser.
//
// §4.6.1 is the invariant that shapes this whole file: NO route returns a
// stored key. GET returns a masked hint read from a plain column, so the
// success path here never decrypts anything and never holds plaintext.

/**
 * Errors from the write path are deliberately NOT passed through (§4.6.3).
 *
 * The key is an RPC argument, and a database error — a constraint violation, a
 * type error, a statement logged by a future extension — can carry its
 * arguments in the message. Forwarding `error.message` to the client, or into a
 * Vercel log, is the single likeliest way this credential escapes. §4.6.3 says
 * it plainly: a key in a log is a far likelier leak than a database breach, and
 * it is the one that gets forgotten.
 *
 * So the caller gets a fixed string, and the server logs a code with no detail.
 */
function opaqueWriteFailure(operation: string): Response {
  console.error(`[settings/byoa] ${operation} failed`);
  return Response.json({ error: 'Could not save your key. Try again.' }, { status: 500 });
}

async function requireUser() {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// GET /api/settings/byoa — does this account have a key, and what does it end in?
export async function GET() {
  const user = await requireUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('user_secrets')
    .select('key_hint, updated_at')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    // Safe to surface: this path reads only the hint column, never the key.
    console.error('[settings/byoa] read failed:', error.message);
    return Response.json({ error: 'Could not load your settings.' }, { status: 500 });
  }

  return Response.json({
    hasKey: Boolean(data?.key_hint),
    hint: data?.key_hint ?? null,
    updatedAt: data?.updated_at ?? null,
  });
}

// PUT /api/settings/byoa — save or replace this account's key.
export async function PUT(request: NextRequest) {
  const user = await requireUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: { apiKey?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  if (typeof body.apiKey !== 'string') {
    return Response.json({ error: 'Paste your Anthropic API key.' }, { status: 400 });
  }

  // Validated server-side as well as in the UI: the route is reachable without
  // the page, and the whitespace rule in particular is what stops a pasted
  // carriage return becoming an unexplainable 401 later.
  const parsed = normalizeKey(body.apiKey);
  if (!parsed.ok) {
    return Response.json({ error: keyFormatMessage(parsed.reason) }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin.rpc('set_user_secret', {
    p_user_id: user.id,
    p_key: parsed.key,
  });

  if (error) return opaqueWriteFailure('set_user_secret');

  // `data` is the hint the DATABASE computed, not one we built here — so what
  // the user is shown is derived from what was actually stored.
  return Response.json({ hasKey: true, hint: data as string });
}

// DELETE /api/settings/byoa — remove it. The migration's trigger deletes the
// Vault secret itself, so this cannot leave an orphaned credential behind.
export async function DELETE() {
  const user = await requireUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin.rpc('delete_user_secret', {
    p_user_id: user.id,
  });

  if (error) {
    console.error('[settings/byoa] delete_user_secret failed:', error.message);
    return Response.json({ error: 'Could not remove your key. Try again.' }, { status: 500 });
  }

  return Response.json({ hasKey: false, removed: Boolean(data) });
}
