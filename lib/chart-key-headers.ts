import { getSupabaseBrowser } from './supabase-browser';
import { deviceKeyHeaders } from './byoa-key-storage';

/**
 * Browser half of `deviceKeyHeaders`: reads the live session and the DOM stores.
 * Never throws — an unreadable session or blocked storage sends no device key,
 * which the server answers with the account key or try-it, never someone else's.
 */
export async function chartKeyHeaders(): Promise<Record<string, string>> {
  try {
    const { data: { session } } = await getSupabaseBrowser().auth.getSession();
    return deviceKeyHeaders(localStorage, sessionStorage, session?.user?.id ?? '');
  } catch {
    return {};
  }
}
