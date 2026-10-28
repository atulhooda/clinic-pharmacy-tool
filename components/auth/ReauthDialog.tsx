'use client';

import { useState, type FormEvent } from 'react';
import { en } from '@/lib/i18n/en';

const t = en.reauth;
const field = 'field-input mt-1';

/**
 * Asks for the signing PIN (or the password) and returns a single-use grant (A-12, 06a §3.7).
 * The caller sends it in the Reauth-Grant header of the one request it confirms.
 */
export function ReauthDialog({ purpose, entityId, onGrant, onCancel, passwordOnly = false }: {
  purpose: string; entityId: string; onGrant: (grantId: string) => void; onCancel: () => void; passwordOnly?: boolean;
}) {
  // D-63: confirmations use the login password; the PIN option stays for callers that ask for it.
  const usePassword = true;
  void passwordOnly;
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch('/api/auth/reauth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(usePassword ? { password: secret, purpose, entityId } : { pin: secret, purpose, entityId }),
    });
    setBusy(false);
    setSecret('');
    if (res.ok) return onGrant(((await res.json()) as { grantId: string }).grantId);
    const body = (await res.json().catch(() => ({}))) as { code?: string; details?: { remaining?: number } };
    if (body.code === 'session_revoked' || body.code === 'device_locked') return window.location.assign('/');
    setError(body.code === 'wrong_secret' ? `${t.wrong} ${body.details?.remaining ?? ''} ${t.triesLeft}.`
      : body.code === 'signing_pin_not_set' ? t.notSet : t.failed);
  }

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-10 flex items-center justify-center bg-black/30 px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl2 border border-hairline bg-surface p-6 shadow-card" noValidate>
        <h2 className="text-h2">{t.title}</h2>
        <label className="block">
          <span className="text-small font-semibold">{usePassword ? t.password : t.pin}</span>
          <input autoFocus className={field} type="password" inputMode={usePassword ? 'text' : 'numeric'} autoComplete="off"
            value={secret} onChange={(e) => setSecret(usePassword ? e.target.value : e.target.value.replace(/\D/g, '').slice(0, 6))} />
        </label>
        {error && <p role="alert" className="rounded-xl2 bg-bad-wash px-3 py-2 text-small text-bad-ink">{error}</p>}
        <div className="flex gap-3">
          <button type="button" onClick={onCancel} className="min-h-tap rounded-xl2 px-4 text-small font-semibold text-muted">{t.cancel}</button>
          <button type="submit" disabled={busy || !secret}
            className="btn-brutal-blue flex-1 justify-center">
            {t.submit}
          </button>
        </div>
      </form>
    </div>
  );
}
