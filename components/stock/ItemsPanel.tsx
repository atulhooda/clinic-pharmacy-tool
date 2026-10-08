'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import DataList from '@/components/ui/DataList';
import Sheet from '@/components/ui/Sheet';
import { TextField, SelectField } from '@/components/ui/Field';
import { en } from '@/lib/i18n/en';
import { api } from '@/components/settings/client';

const t = en.stock;
type Unit = { id: string; name: string; baseUnitsPerUnit: number; isBase: boolean; dispensable: boolean; purchasable: boolean; active: boolean };
type Item = { id: string; displayName: string; category: string; baseUnit: string; scheduleFlags: string[]; extraScheduleFlags: string[];
  requiresPrescription: boolean; requiresPrescriptionImposed: boolean; reorderLevel: number | null; rackLocation: string | null; units?: Unit[] };
type Master = { id: string; brandName: string; dosageForm: string; suggestedBaseUnit: string | null; salts: { name: string }[] };
const CATEGORIES = ['MEDICINE', 'RETAIL_PRODUCT', 'INJECTABLE', 'CONSUMABLE'];
const BASE_UNITS = ['TABLET', 'CAPSULE', 'ML', 'G', 'VIAL', 'UNIT', 'PIECE'];
const FLAGS = ['H', 'H1', 'X', 'G', 'NDPS', 'H2'];

/** E-08 … E-17: the catalogue. Items come from the medicine list or are custom; pack units have fixed factors. */
export function ItemsPanel({ canEdit }: { canEdit: boolean }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [adding, setAdding] = useState(false);
  const [mq, setMq] = useState('');
  const [masters, setMasters] = useState<Master[]>([]);
  const [draft, setDraft] = useState({ masterId: null as string | null, displayName: '', category: 'MEDICINE', baseUnit: 'TABLET' });
  const [open, setOpen] = useState<Item | null>(null);
  const [unit, setUnit] = useState({ name: '', per: '' });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (text: string) => {
    const r = await api<{ items: Item[] }>(`/api/dispensary/items?limit=200${text ? `&q=${encodeURIComponent(text)}` : ''}`);
    if (r.ok) setItems(r.body.items);
  }, []);
  useEffect(() => { void load(''); }, [load]);
  const reopen = async (id: string) => { const r = await api<Item>(`/api/dispensary/items/${id}`); if (r.ok) setOpen(r.body); };

  async function searchMaster(e: FormEvent) {
    e.preventDefault();
    const r = await api<{ items: Master[] }>(`/api/dispensary/master?q=${encodeURIComponent(mq)}`);
    if (r.ok) setMasters(r.body.items);
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await api<Item>('/api/dispensary/items', { body: draft });
    if (!r.ok) return setError(r.body.error ?? en.settings.failed);
    setAdding(false);
    await load(q);
    setOpen(r.body);
  }
  async function patch(body: Record<string, unknown>) {
    if (!open) return;
    setError(null);
    const r = await api<Item>(`/api/dispensary/items/${open.id}`, { method: 'PATCH', body });
    if (!r.ok) return setError(r.body.error ?? en.settings.failed);
    setOpen(r.body);
    await load(q);
  }
  async function addUnit(e: FormEvent) {
    e.preventDefault();
    if (!open) return;
    const r = await api(`/api/dispensary/items/${open.id}/units`, { body: { name: unit.name, baseUnitsPerUnit: Number(unit.per) } });
    if (!r.ok) return setError(r.body.error ?? en.settings.failed);
    setUnit({ name: '', per: '' });
    await reopen(open.id);
  }
  async function unitFlag(u: Unit, body: Record<string, boolean>) {
    if (!open) return;
    const r = await api(`/api/dispensary/items/${open.id}/units/${u.id}`, { method: 'PATCH', body });
    if (!r.ok) return setError(r.body.error ?? en.settings.failed);
    await reopen(open.id);
  }

  return (
    <div className="space-y-4">
      <form onSubmit={(e) => { e.preventDefault(); void load(q); }} className="flex items-end gap-2">
        <TextField label={t.search} value={q} onChange={(e) => setQ(e.target.value)} className="flex-1" />
        <Button type="submit">→</Button>
        {canEdit && <Button variant="brutal" onClick={() => { setError(null); setAdding(true); setMasters([]); }}>{t.addItem}</Button>}
      </form>
      <DataList rows={items} rowKey={(i) => i.id} empty={en.settings.none} onRowClick={(i) => reopen(i.id)} columns={[
        { key: 'name', header: t.displayName, cell: (i) => i.displayName, primary: true },
        { key: 'cat', header: t.category, cell: (i) => i.category },
        { key: 'flags', header: t.scheduleFlags, cell: (i) => (
          <span className="flex gap-1">{i.scheduleFlags.map((f) => <Badge key={f} tone="neutral">{f}</Badge>)}{i.requiresPrescription && <Badge tone="bad">Rx</Badge>}</span>) },
      ]} />
      <Sheet open={adding} onOpenChange={setAdding} title={t.addItem} wide>
        <div className="space-y-4">
          <form onSubmit={searchMaster} className="flex items-end gap-2">
            <TextField label={t.fromMaster} value={mq} onChange={(e) => setMq(e.target.value)} className="flex-1" />
            <Button type="submit">→</Button>
          </form>
          <ul className="max-h-48 overflow-y-auto divide-y divide-hairline">
            {masters.map((m) => (
              <li key={m.id}>
                <button type="button" className={`w-full px-2 py-2 text-left text-small ${draft.masterId === m.id ? 'bg-brand-tint' : ''}`}
                  onClick={() => setDraft({ masterId: m.id, displayName: m.brandName, category: 'MEDICINE', baseUnit: m.suggestedBaseUnit ?? 'TABLET' })}>
                  {m.brandName} <span className="text-muted">· {m.dosageForm}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="text-micro text-muted">{t.custom}</p>
          <form onSubmit={create} className="space-y-3" noValidate>
            <TextField label={t.displayName} value={draft.displayName} maxLength={120} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
            <SelectField label={t.category} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </SelectField>
            <SelectField label={t.baseUnit} value={draft.baseUnit} onChange={(e) => setDraft({ ...draft, baseUnit: e.target.value })}>
              {BASE_UNITS.map((c) => <option key={c}>{c}</option>)}
            </SelectField>
            {error && <p role="alert" className="text-small text-bad">{error}</p>}
            <Button type="submit" variant="brutal">{en.settings.save}</Button>
          </form>
        </div>
      </Sheet>
      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpen(null)} title={open?.displayName ?? ''} wide>
        {open && (
          <div className="space-y-5">
            <p className="text-small text-muted">{open.category} · {open.baseUnit}</p>
            <label className="flex items-center gap-2 text-small">
              <input type="checkbox" checked={open.requiresPrescription} disabled={!canEdit || open.requiresPrescriptionImposed}
                onChange={(e) => patch({ requiresPrescription: e.target.checked })} /> {t.rxRequired}
              {open.requiresPrescriptionImposed && <span className="text-micro text-muted">({t.rxImposed})</span>}
            </label>
            <fieldset className="flex flex-wrap gap-3">
              <legend className="text-small font-medium text-ink-soft">{t.extraFlags}</legend>
              {FLAGS.map((f) => (
                <label key={f} className="flex items-center gap-1 text-small">
                  <input type="checkbox" disabled={!canEdit} checked={open.extraScheduleFlags.includes(f)}
                    onChange={(e) => patch({ extraScheduleFlags: e.target.checked ? [...open.extraScheduleFlags, f] : open.extraScheduleFlags.filter((x) => x !== f) })} /> {f}
                </label>
              ))}
            </fieldset>
            <div>
              <p className="text-small font-semibold">{t.units}</p>
              <ul className="divide-y divide-hairline">
                {(open.units ?? []).map((u) => (
                  <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-small">
                    <span>{u.name} = {u.baseUnitsPerUnit} {open.baseUnit.toLowerCase()}</span>
                    <span className="flex gap-3">
                      <label className="flex items-center gap-1"><input type="checkbox" disabled={!canEdit} checked={u.dispensable} onChange={(e) => unitFlag(u, { dispensable: e.target.checked })} /> {t.dispensable}</label>
                      <label className="flex items-center gap-1"><input type="checkbox" disabled={!canEdit} checked={u.purchasable} onChange={(e) => unitFlag(u, { purchasable: e.target.checked })} /> {t.purchasable}</label>
                    </span>
                  </li>
                ))}
              </ul>
              {canEdit && (
                <form onSubmit={addUnit} className="mt-2 flex flex-wrap items-end gap-2" noValidate>
                  <TextField label={t.unitName} value={unit.name} maxLength={40} onChange={(e) => setUnit({ ...unit, name: e.target.value })} />
                  <TextField label={t.perUnit} inputMode="numeric" value={unit.per} onChange={(e) => setUnit({ ...unit, per: e.target.value.replace(/\D/g, '') })} />
                  <Button type="submit">{t.addUnit}</Button>
                </form>
              )}
            </div>
            {error && <p role="alert" className="text-small text-bad">{error}</p>}
          </div>
        )}
      </Sheet>
    </div>
  );
}
