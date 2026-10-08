'use client';

import { useState, type FormEvent } from 'react';
import { en } from '@/lib/i18n/en';

const t = en.signIn;

export function SignInForm({ orgSlug, orgName }: { orgSlug: string; orgName: string }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgSlug, login, password }),
      });
      if (res.ok) {
        const body = (await res.json()) as { next: string };
        window.location.assign(body.next);
        return;
      }
      setPassword('');
      setError(res.status === 401 ? t.wrong : res.status === 429 ? t.tooMany : res.status === 503 ? t.unavailable : t.failed);
    } catch {
      setError(t.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <p className="text-small text-muted">{orgName}</p>
      <label className="block">
        <span className="text-small font-semibold">{t.login}</span>
        <input
          className="mt-1 block w-full min-h-tap rounded-xl2 border border-hairline-firm bg-surface px-3 text-body focus:outline-none focus:border-brand"
          name="login" autoComplete="username" autoCapitalize="none" spellCheck={false} required
          value={login} onChange={(e) => setLogin(e.target.value)}
        />
      </label>
      <label className="block">
        <span className="text-small font-semibold">{t.password}</span>
        <input
          className="mt-1 block w-full min-h-tap rounded-xl2 border border-hairline-firm bg-surface px-3 text-body focus:outline-none focus:border-brand"
          name="password" type="password" autoComplete="current-password" required
          value={password} onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && <p role="alert" className="rounded-xl2 bg-bad-wash px-3 py-2 text-small text-bad-ink">{error}</p>}
      <button
        type="submit" disabled={busy || !login || !password}
        className="w-full min-h-tap-lg rounded-xl2 bg-brand px-4 font-semibold text-white shadow-brutal-sm hover:bg-brand-hover disabled:bg-faint-line"
      >
        {busy ? t.working : t.submit}
      </button>
    </form>
  );
}
