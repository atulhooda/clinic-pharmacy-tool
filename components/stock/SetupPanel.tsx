'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Button from '@/components/ui/Button';
import { TextField, SelectField } from '@/components/ui/Field';
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
  return (
    <div className="space-y-6">
      {!configured && (
        <div className="space-y-3">
          <p className="text-body">{t.notConfigured}</p>
          {canEdit && <Button variant="brutal" onClick={setUp}>{t.setUpDispensary}</Button>}
        </div>
      )}
      {configured && (
        <ul className="divide-y divide-hairline rounded-xl2 border border-hairline">
          {premises.map((p) => (
            <li key={p.id} className="space-y-2 px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{p.name}</span>
                {p.settings ? <span className="text-small text-ok-ink">{t.configured} · {p.settings.dispensingMode}</span>
                  : canEdit && <Button size="sm" onClick={() => { setError(null); setOpen(p.id); }}>{t.premisesSetup}</Button>}
              </div>
              {p.locations.length > 0 && <p className="text-micro text-muted">{t.locations}: {p.locations.map((l) => l.name).join(', ')}</p>}
              {open === p.id && (
                <form onSubmit={save} className="space-y-3 pt-2" noValidate>
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
                          onChange={(e) => setForm({ ...form, h1: e.target.checked ? [...form.h1, f] : form.h1.filter((x) => x !== f) })} /> {f}
                      </label>
                    ))}
                  </fieldset>
                  <TextField label={t.rxMaxAge} inputMode="numeric" value={form.age} onChange={(e) => setForm({ ...form, age: e.target.value.replace(/\D/g, '') })} />
                  <Button type="submit" variant="brutal">{en.settings.save}</Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="text-small text-bad">{error}</p>}
      {dialog}
    </div>
  );
}
