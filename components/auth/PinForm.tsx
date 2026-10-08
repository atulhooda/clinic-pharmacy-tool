'use client';

import { useState, type FormEvent } from 'react';
import { en } from '@/lib/i18n/en';

const t = en.pins;
const field = 'mt-1 block w-full min-h-tap rounded-xl2 border border-hairline-firm bg-surface px-3 text-body focus:outline-none focus:border-brand';

/** A-14 (switch PIN) and A-15 (signing PIN, with the password in the same request). */
export function PinForm({ kind }: { kind: 'switch' | 'signing' }) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pin !== confirm) {
      setError(t.mismatch);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch(kind === 'switch' ? '/api/account/switch-pin' : '/api/account/signing-pin', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(kind === 'switch' ? { pin } : { pin, password }),
    });
    setBusy(false);
    if (res.ok) {
      window.location.assign('/');
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    if (body.code === 'session_revoked') return window.location.assign('/');
    setError(body.code === 'PIN_FORMAT' ? t.format : body.code === 'PIN_SAME_AS_OTHER' ? t.same
      : body.code === 'wrong_secret' ? t.wrongPassword : body.code === 'signing_pin_not_applicable' ? t.notApplicable : t.failed);
  }

  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6);
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <p className="text-small text-muted">{kind === 'switch' ? t.switchWhy : t.signingWhy}</p>
      <label className="block">
        <span className="text-small font-semibold">{t.pin}</span>
        <input className={field} type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(digits(e.target.value))} />
      </label>
      <label className="block">
        <span className="text-small font-semibold">{t.confirm}</span>
        <input className={field} type="password" inputMode="numeric" autoComplete="off" value={confirm} onChange={(e) => setConfirm(digits(e.target.value))} />
      </label>
      {kind === 'signing' && (
        <label className="block">
          <span className="text-small font-semibold">{t.password}</span>
          <input className={field} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
      )}
      <p className="text-micro text-muted">{t.rules}</p>
      {error && <p role="alert" className="rounded-xl2 bg-bad-wash px-3 py-2 text-small text-bad-ink">{error}</p>}
      <button type="submit" disabled={busy || pin.length !== 6 || (kind === 'signing' && !password)}
        className="w-full min-h-tap-lg rounded-xl2 bg-brand px-4 font-semibold text-white shadow-brutal-sm hover:bg-brand-hover disabled:bg-faint-line">
        {t.submit}
      </button>
    </form>
  );
}
