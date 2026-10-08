'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Button from '@/components/ui/Button';
import { TextField, SelectField } from '@/components/ui/Field';
import Badge from '@/components/ui/Badge';
import MonoLabel from '@/components/ui/MonoLabel';
import Sheet from '@/components/ui/Sheet';
import { en } from '@/lib/i18n/en';
import { api } from '@/components/settings/client';
import { useGrant } from '@/components/settings/useGrant';

const t = en.stock;
type Loc = { id: string; name: string; kind: string; isDefault: boolean };
type PremisesRow = { id: string; name: string; settings: { dispensingMode: string; version: number } | null; locations: Loc[] };
const H1 = ['PATIENT_ADDRESS', 'PATIENT_AGE', 'PATIENT_DOB', 'PRESCRIPTION_DATE'];

/** E-01 … E-06: the organisation's dispensary, then each premises' legal settings (signed). */
export function SetupPanel({ canEdit }: { canEdit: boolean }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [premises, setPremises] = useState<PremisesRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ mode: 'RMP_OWN_PATIENTS', ndps: '', ndpsTill: '', x: '', xTill: '', h1: ['PATIENT_ADDRESS'] as string[], age: '' });
  const [error, setError] = useState<string | null>(null);
  const { withGrant, dialog } = useGrant();
  const load = useCallback(async () => {
    const s = await api('/api/dispensary/settings');
    setConfigured(s.ok);
    const p = await api<{ items: PremisesRow[] }>('/api/dispensary/premises');
    if (p.ok) setPremises(p.body.items);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function setUp() {
    const r = await api('/api/dispensary/setup', { body: {} });
    if (!r.ok) setError(r.body.error ?? en.settings.failed);
    await load();
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!open) return;
    const grant = await withGrant('premises.legal_settings', open);
    if (!grant) return;
    const r = await api(`/api/dispensary/premises/${open}/setup`, { grant, body: {
      dispensingMode: form.mode, ndpsLicenceNo: form.ndps || null, ndpsLicenceValidTill: form.ndpsTill || null,
      scheduleXLicenceNo: form.x || null, scheduleXLicenceValidTill: form.xTill || null, h1RegisterExtraFields: form.h1,
      prescriptionMaxAgeDays: form.age ? Number(form.age) : null } });
    if (!r.ok) return setError(r.body.error ?? en.settings.failed);
    setOpen(null);
    await load();
  }

  if (configured === null) return null;
  const openPremises = premises.find((p) => p.id === open);
  return (
    <div className="space-y-4">
      <section className="card flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <MonoLabel dot={configured ? 'green' : 'amber'}>Dispensary</MonoLabel>
          <p className="mt-2 text-h3">{configured ? 'Set up' : t.notConfigured}</p>
          <p className="text-small text-muted">{configured ? 'Near-expiry windows, the reversal window and the entry lags use their defaults; they can be tuned later.' : 'One step for the organisation, then one per premises.'}</p>
        </div>
        {!configured && canEdit && <Button variant="brutal-blue" onClick={setUp}>{t.setUpDispensary}</Button>}
      </section>

      {configured && (
        <section className="card overflow-hidden">
          <div className="border-b border-hairline px-5 py-4"><MonoLabel>Premises</MonoLabel></div>
          <ul className="divide-y divide-hairline">
            {premises.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div className="min-w-0">
                  <p className="font-semibold">{p.name}</p>
                  <p className="text-micro text-muted">{p.locations.length ? `${t.locations}: ${p.locations.map((l) => l.name).join(', ')}` : 'no locations yet'}</p>
                </div>
                {p.settings ? <Badge tone="ok">● {p.settings.dispensingMode.replace(/_/g, ' ').toLowerCase()}</Badge>
                  : canEdit ? <Button size="sm" variant="brutal" onClick={() => { setError(null); setOpen(p.id); }}>{t.premisesSetup}</Button>
                  : <Badge tone="warn">not set up</Badge>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {error && !open && <p role="alert" className="text-small text-bad">{error}</p>}

      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpen(null)} title={openPremises ? `${t.premisesSetup}: ${openPremises.name}` : t.premisesSetup}>
        <form onSubmit={save} className="space-y-3" noValidate>
          <SelectField label={t.mode} value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
            {Object.entries(t.modes).map(([k, v]) => <option key={k} value={k} disabled={k !== 'RMP_OWN_PATIENTS'}>{v}</option>)}
          </SelectField>
          <TextField label={t.ndpsLicence} value={form.ndps} onChange={(e) => setForm({ ...form, ndps: e.target.value })} />
          <TextField label={t.validTill} type="date" value={form.ndpsTill} onChange={(e) => setForm({ ...form, ndpsTill: e.target.value })} />
          <TextField label={t.scheduleXLicence} value={form.x} onChange={(e) => setForm({ ...form, x: e.target.value })} />
          <TextField label={t.validTill} type="date" value={form.xTill} onChange={(e) => setForm({ ...form, xTill: e.target.value })} />
          <fieldset className="space-y-1">
            <legend className="text-small font-medium text-ink-soft">{t.h1Fields}</legend>
            {H1.map((f) => (
              <label key={f} className="flex items-center gap-2 text-small">
                <input type="checkbox" checked={form.h1.includes(f)}
                  onChange={(e) => setForm({ ...form, h1: e.target.checked ? [...form.h1, f] : form.h1.filter((x) => x !== f) })} /> {f.replace(/_/g, ' ').toLowerCase()}
              </label>
            ))}
          </fieldset>
          <TextField label={t.rxMaxAge} inputMode="numeric" value={form.age} onChange={(e) => setForm({ ...form, age: e.target.value.replace(/\D/g, '') })} />
          {error && <p role="alert" className="text-small text-bad">{error}</p>}
          <Button type="submit" variant="brutal-blue">{en.settings.save}</Button>
        </form>
      </Sheet>
      {dialog}
    </div>
  );
}
