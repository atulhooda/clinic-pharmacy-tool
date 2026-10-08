'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { en } from '@/lib/i18n/en';

const t = en.lock;
type Person = { sessionId: string; name: string; role: string };
type Screen = { org: { slug: string; displayName: string }; device: { name: string }; people: Person[] };

/** The "Who's working?" lock screen (06a §3.5): pick your name, type your switch PIN. */
export function LockScreen() {
  const [screen, setScreen] = useState<Screen | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'untrusted'>('loading');
  const [picked, setPicked] = useState<Person | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await fetch('/api/auth/device/people').catch(() => null);
    if (!res || !res.ok) {
      setState('untrusted');
      return;
    }
    setScreen((await res.json()) as Screen);
    setState('ready');
  }
  useEffect(() => { void load(); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!picked) return;
    setBusy(true);
    setError(null);
    const res = await fetch('/api/auth/device/switch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: picked.sessionId, pin }),
    });
    setBusy(false);
    setPin('');
    if (res.ok) {
      window.location.assign('/');
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { code?: string; details?: { remaining?: number } };
    if (body.code === 'wrong_secret') setError(`${t.wrong} ${body.details?.remaining ?? ''} ${t.triesLeft}.`);
    else if (body.code === 'switch_pin_blocked') setError(t.blocked);
    else if (body.code === 'session_expired') setError(t.expired);
    else if (body.code === 'SESSION_NOT_FOUND') { setError(t.gone); setPicked(null); void load(); }
    else setError(t.failed);
  }

  if (state === 'loading') return null;
  if (state === 'untrusted' || !screen) {
    return <p className="text-body">{t.notTrusted}</p>;
  }
  const signInHref = `/${screen.org.slug}/sign-in`;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-h1">{t.title}</h1>
        <p className="text-small text-muted">{screen.org.displayName} · {screen.device.name}</p>
      </div>
      {!picked && (
        <ul className="space-y-2">
          {screen.people.length === 0 && <li className="text-small text-muted">{t.nobody}</li>}
          {screen.people.map((p) => (
            <li key={p.sessionId}>
              <button type="button" onClick={() => { setPicked(p); setError(null); }}
                className="flex w-full min-h-tap-lg items-center justify-between rounded-xl2 border border-hairline-firm bg-surface px-4 text-left transition-shadow hover:border-ink hover:shadow-brutal-sm">
                <span className="font-semibold">{p.name}</span> <span className="text-small text-muted">({p.role})</span>
              </button>
            </li>
          ))}
          <li>
            <a href={signInHref} className="block w-full min-h-tap-lg rounded-xl2 px-4 py-3 text-left text-brand hover:text-brand-hover">{t.someoneElse}</a>
          </li>
        </ul>
      )}
      {picked && (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <p className="font-semibold">{picked.name}</p>
          <label className="block">
            <span className="text-small font-semibold">{t.enterPin}</span>
            <input autoFocus inputMode="numeric" autoComplete="off" maxLength={6} type="password" value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              className="field-input mt-1 tracking-widest" />
          </label>
          {error && <p role="alert" className="rounded-xl2 bg-bad-wash px-3 py-2 text-small text-bad-ink">{error}</p>}
          <div className="flex gap-3">
            <button type="button" onClick={() => { setPicked(null); setPin(''); setError(null); }}
              className="min-h-tap rounded-xl2 px-4 text-small font-semibold text-muted">{t.back}</button>
            <button type="submit" disabled={busy || pin.length !== 6}
              className="btn-brutal-blue flex-1 justify-center">
              {t.submit}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
