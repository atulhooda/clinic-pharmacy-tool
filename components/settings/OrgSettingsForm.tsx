'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Button from '@/components/ui/Button';
import { TextField } from '@/components/ui/Field';
import { en } from '@/lib/i18n/en';
import { api } from './client';
import { useGrant } from './useGrant';

const t = en.settings;
type S = { deviceLockMinutes: number; dayResetTimeIst: string; untrustedIdleMinutes: number | null; version: number };

/** M-01: the organisation's security settings, saved with If-Match and an `org.settings` grant. */
export function OrgSettingsForm({ orgId }: { orgId: string }) {
  const [s, setS] = useState<S | null>(null);
  const [lock, setLock] = useState('3');
  const [reset, setReset] = useState('04:00');
  const [idle, setIdle] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { withGrant, dialog } = useGrant();

  async function load() {
    const r = await api<S>('/api/org/settings');
    if (!r.ok) return;
    setS(r.body);
    setLock(String(r.body.deviceLockMinutes));
    setReset(r.body.dayResetTimeIst);
    setIdle(r.body.untrustedIdleMinutes === null ? '' : String(r.body.untrustedIdleMinutes));
  }
  useEffect(() => { void load(); }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!s) return;
    setMsg(null);
    const grant = await withGrant('org.settings', orgId);
    if (!grant) return;
    const r = await api<S>('/api/org/settings', { method: 'PUT', grant, ifMatch: `"${s.version}"`,
      body: { deviceLockMinutes: Number(lock), dayResetTimeIst: reset, untrustedIdleMinutes: idle.trim() === '' ? null : Number(idle) } });
    if (r.ok) { setMsg({ ok: true, text: t.saved }); await load(); }
    else setMsg({ ok: false, text: r.status === 412 ? t.conflict : t.failed });
  }

  if (!s) return null;
  return (
    <form onSubmit={save} className="space-y-4" noValidate>
      <TextField label={t.lockMinutes} hint={t.lockHint} inputMode="numeric" value={lock} onChange={(e) => setLock(e.target.value.replace(/\D/g, ''))} />
      <TextField label={t.dayReset} hint={t.dayResetHint} type="time" value={reset} onChange={(e) => setReset(e.target.value)} />
      <TextField label={t.untrustedIdle} hint={t.untrustedIdleHint} inputMode="numeric" value={idle} onChange={(e) => setIdle(e.target.value.replace(/\D/g, ''))} />
      {msg && <p role="status" className={`rounded-xl2 px-3 py-2 text-small ${msg.ok ? 'bg-ok-wash text-ok-ink' : 'bg-bad-wash text-bad-ink'}`}>{msg.text}</p>}
      <Button type="submit" variant="brutal">{t.save}</Button>
      {dialog}
    </form>
  );
}
