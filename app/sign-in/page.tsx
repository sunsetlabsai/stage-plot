'use client';

import { Suspense, useState } from 'react';
// No useRouter: every exit from this page must be a document load, because
// signing in changes the identity that middleware routes on. See below.
import { useSearchParams } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { LogoFull } from '@/components/Logo';

export default function SignInPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-zinc-950" />}>
      <SignInForm />
    </Suspense>
  );
}

function SignInForm() {
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'email' | 'otp'>('email');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const searchParams = useSearchParams();
  const rawRedirect = searchParams.get('redirect') || '/dashboard';
  // Prevent open redirect — only allow internal paths
  const redirect = rawRedirect.startsWith('/') && !rawRedirect.startsWith('//') ? rawRedirect : '/dashboard';

  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const supabase = getSupabaseBrowser();
    const { error: otpError } = await supabase.auth.signInWithOtp({ email });

    setLoading(false);
    if (otpError) {
      setError(otpError.message);
      return;
    }
    setStep('otp');
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const supabase = getSupabaseBrowser();
    const { error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token: otp,
      type: 'email',
    });

    if (verifyError) {
      setLoading(false);
      setError(verifyError.message);
      return;
    }

    // Activate any pending collaborator invites
    await fetch('/api/auth/activate-invites', { method: 'POST' });

    // A DOCUMENT LOAD, not router.push — same reason as app/claim/page.tsx.
    // verifyOtp has just changed who this browser is, and `redirect` is
    // usually /dashboard or /library, both gated by middleware.ts:62 on
    // exactly that answer. Any cached routing decision made under the previous
    // identity is now stale, and a client navigation would replay it. `redirect`
    // is already constrained to an internal path above, so this cannot be an
    // open redirect.
    window.location.assign(redirect);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <LogoFull className="w-24 h-24 mx-auto mb-4 rounded-3xl" />
          <h1 className="text-2xl font-bold text-white">ShowRunr</h1>
          <p className="text-zinc-400 mt-1">Sign in to manage your shows</p>
        </div>

        {step === 'email' ? (
          <form onSubmit={handleSendOtp} className="space-y-4">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              className="w-full px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Sending...' : 'Send Code'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerifyOtp} className="space-y-4">
            <p className="text-sm text-zinc-400 text-center">
              Enter the 6-digit code sent to <strong className="text-white">{email}</strong>
            </p>
            <input
              type="text"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              required
              maxLength={6}
              className="w-full px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-700 text-white text-center text-2xl tracking-[0.5em] font-mono placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={loading || otp.length !== 6}
              className="w-full py-3 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Verifying...' : 'Sign In'}
            </button>
            <button
              type="button"
              onClick={() => { setStep('email'); setOtp(''); }}
              className="w-full text-sm text-zinc-500 hover:text-zinc-300"
            >
              Use a different email
            </button>
          </form>
        )}

        {error && (
          <p className="text-sm text-red-400 text-center">{error}</p>
        )}
      </div>
    </div>
  );
}
