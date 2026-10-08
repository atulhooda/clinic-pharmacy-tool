'use client';

import { useState, type FormEvent } from 'react';
import { en } from '@/lib/i18n/en';

const t = en.password;
const field = 'mt-1 block w-full min-h-tap rounded-xl2 border border-hairline-firm bg-surface px-3 text-body focus:outline-none focus:border-brand';

export function ChangePasswordForm({ mustChange }: { mustChange: boolean }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      setMessage({ ok: false, text: t.mismatch });
      return;
    }
    setBusy(true);
    setMessage(null);
    const res = await fetch('/api/account/password', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ current, next }),
    });
    setBusy(false);
    if (res.ok) {
      window.location.assign('/');
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    if (body.code === 'session_revoked') {
      window.location.assign('/');
      return;
    }
    setMessage({ ok: false, text: body.code === 'wrong_secret' ? t.wrongCurrent : body.code === 'PASSWORD_POLICY' ? t.policy : t.policy });
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {mustChange && <p className="rounded-xl2 bg-warn-wash px-3 py-2 text-small text-warn-ink">{t.mustChange}</p>}
      <label className="block">
        <span className="text-small font-semibold">{t.current}</span>
        <input className={field} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label className="block">
        <span className="text-small font-semibold">{t.next}</span>
        <input className={field} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </label>
      <label className="block">
        <span className="text-small font-semibold">{t.confirm}</span>
        <input className={field} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </label>
      <p className="text-micro text-muted">{t.rules}</p>
      {message && <p role="alert" className="rounded-xl2 bg-bad-wash px-3 py-2 text-small text-bad-ink">{message.text}</p>}
      <button type="submit" disabled={busy || !current || !next}
        className="w-full min-h-tap-lg rounded-xl2 bg-brand px-4 font-semibold text-white shadow-brutal-sm hover:bg-brand-hover disabled:bg-faint-line">
        {t.submit}
      </button>
    </form>
  );
}
