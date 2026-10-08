'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { en } from '@/lib/i18n/en';
import { ReauthDialog } from '@/components/auth/ReauthDialog';

const t = en.devices;
const field = 'field-input mt-1';
type Device = { id: string; name: string; premisesName: string; lastSeenAt: string | null; revokedAt: string | null; thisDevice: boolean };

/** M-10 / M-11: list, trust this PC (signed with a `devices.register` grant), revoke. */
export function DevicesPanel({ orgId, premises, onDevice }: { orgId: string; premises: { id: string; name: string }[]; onDevice: boolean }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [name, setName] = useState('');
  const [premisesId, setPremisesId] = useState(premises[0]?.id ?? '');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/devices');
    if (res.ok) setDevices(((await res.json()) as { items: Device[] }).items);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function trust(grantId: string) {
    setAsking(false);
    const res = await fetch('/api/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'reauth-grant': grantId },
      body: JSON.stringify({ name, premisesId }),
    });
    if (res.ok) return window.location.assign('/');
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    setError(body.code === 'DEVICE_NAME_TAKEN' ? t.nameTaken : body.code === 'ALREADY_TRUSTED' ? t.alreadyTrusted : t.failed);
  }

  async function revoke(id: string) {
    if (!window.confirm(t.confirmRevoke)) return;
    const res = await fetch(`/api/devices/${id}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!res.ok) setError(t.failed);
    await load();
  }

  return (
    <div className="space-y-6">
      <p className="text-small text-muted">{t.intro}</p>
      <ul className="divide-y divide-hairline">
        {devices.length === 0 && <li className="py-2 text-small text-muted">{t.none}</li>}
        {devices.map((d) => (
          <li key={d.id} className="flex items-center justify-between py-2">
            <span>
              <span className="font-semibold">{d.name}</span> <span className="text-small text-muted">· {d.premisesName}</span>
              {d.thisDevice && <span className="text-small text-brand"> · {t.thisPc}</span>}
              {d.revokedAt && <span className="text-small text-bad-ink"> · {t.revoked}</span>}
            </span>
            {!d.revokedAt && (
              <button type="button" onClick={() => revoke(d.id)} className="min-h-tap px-3 text-small font-semibold text-bad-ink">{t.revoke}</button>
            )}
          </li>
        ))}
      </ul>
      {!onDevice && (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); setError(null); setAsking(true); }} className="space-y-4" noValidate>
          <h2 className="text-h2">{t.trustThis}</h2>
          <label className="block">
            <span className="text-small font-semibold">{t.name}</span>
            <input className={field} value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <span className="text-small font-semibold">{t.premises}</span>
            <select className={field} value={premisesId} onChange={(e) => setPremisesId(e.target.value)}>
              {premises.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <button type="submit" disabled={!name.trim() || !premisesId}
            className="btn-brutal-blue w-full justify-center">
            {t.trustThis}
          </button>
        </form>
      )}
      {error && <p role="alert" className="rounded-xl2 bg-bad-wash px-3 py-2 text-small text-bad-ink">{error}</p>}
      {asking && <ReauthDialog purpose="devices.register" entityId={orgId} onGrant={trust} onCancel={() => setAsking(false)} />}
    </div>
  );
}
