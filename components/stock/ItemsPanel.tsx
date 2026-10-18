'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import DataList from '@/components/ui/DataList';
import Sheet from '@/components/ui/Sheet';
import { TextField, SelectField } from '@/components/ui/Field';
import FilterPills from '@/components/ui/FilterPills';
import SearchField from '@/components/ui/SearchField';
import KpiCard from '@/components/ui/KpiCard';
import Combobox from '@/components/ui/Combobox';
import { IconPlus } from '@/components/ui/icons';
import { en } from '@/lib/i18n/en';
import { fmtPaise } from '@/lib/money';
import { api } from '@/components/settings/client';
import { dmy, istDateTime, movementLabel, packs, unitWord } from './format';
import { AdjustStockSheet } from './AdjustStockSheet';

const t = en.stock;
type Unit = { id: string; name: string; baseUnitsPerUnit: number; isBase: boolean; dispensable: boolean; purchasable: boolean; active: boolean };
type Stock = { onHandBase: number; dispensableBase: number; quarantinedBase: number; expiredBase: number; nearestExpiry: string | null;
  lowStock: boolean; nearExpiry: boolean };
type BatchRow = { id: string; premisesId: string; batchNo: string; expiryDate: string; expired: boolean; mrpPaise: number; mrpUnitName: string; onHandBase: number;
  locations: { locationId: string; name: string; kind: string; onHandBase: number }[] };
type Item = { id: string; masterId: string | null; displayName: string; category: string; baseUnit: string; trackBatches: boolean; scheduleFlags: string[]; extraScheduleFlags: string[];
  requiresPrescription: boolean; requiresPrescriptionImposed: boolean; reorderLevel: number | null; rackLocation: string | null; units?: Unit[];
  stock?: Stock & { batches?: BatchRow[]; untracked?: { premisesId: string; locationId: string; name: string; kind: string; onHandBase: number }[] } };
type Movement = { id: string; type: string; qtyDelta: number; locationName: string; batchNo: string | null; actorLabel: string; occurredAt: string; reasonCode: string | null };
type StockFilter = 'ALL' | 'LOW' | 'NEAR' | 'EXPIRED';
type Master = { id: string; brandName: string; dosageForm: string; suggestedBaseUnit: string | null; salts: { name: string }[] };
const CATEGORIES = ['MEDICINE', 'RETAIL_PRODUCT', 'INJECTABLE', 'CONSUMABLE'];
const BASE_UNITS = ['TABLET', 'CAPSULE', 'ML', 'G', 'VIAL', 'UNIT', 'PIECE'];
const FLAGS = ['H', 'H1', 'X', 'G', 'NDPS', 'H2'];

/** E-08 … E-17: the catalogue. Items come from the medicine list or are custom; pack units have fixed factors. */
export function ItemsPanel({ canEdit, canAdjust }: { canEdit: boolean; canAdjust: boolean }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<'ALL' | string>('ALL');
  const [items, setItems] = useState<Item[]>([]);
  const [adding, setAdding] = useState(false);
  const [masters, setMasters] = useState<Master[]>([]);
  const [draft, setDraft] = useState({ masterId: null as string | null, displayName: '', category: 'MEDICINE', baseUnit: 'TABLET' });
  const [open, setOpen] = useState<Item | null>(null);
  const [stockFilter, setStockFilter] = useState<StockFilter>('ALL');
  const [history, setHistory] = useState<{ items: Movement[]; next: string | null }>({ items: [], next: null });
  const [unit, setUnit] = useState({ name: '', per: '' });
  const [error, setError] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState<Item | null>(null);
  const load = useCallback(async (text: string) => {
    const r = await api<{ items: Item[] }>(`/api/dispensary/items?limit=200${text ? `&q=${encodeURIComponent(text)}` : ''}`);
    if (r.ok) setItems(r.body.items);
  }, []);
  useEffect(() => { void load(''); }, [load]);
  const loadHistory = async (id: string, cursor: string | null) => {
    const r = await api<{ items: Movement[]; nextCursor: string | null }>(`/api/dispensary/items/${id}/movements?limit=20${cursor ? `&cursor=${cursor}` : ''}`);
    if (r.ok) setHistory((h) => ({ items: cursor ? [...h.items, ...r.body.items] : r.body.items, next: r.body.nextCursor }));
  };
  const reopen = async (id: string) => {
    const r = await api<Item>(`/api/dispensary/items/${id}`);
    if (r.ok) setOpen(r.body);
    await loadHistory(id, null);
  };

  const startAdjust = async (id: string) => {
    const r = await api<Item>(`/api/dispensary/items/${id}`);
    if (r.ok) setAdjusting(r.body);
  };
  const adjusted = async () => {
    const id = adjusting?.id;
    setAdjusting(null);
    await load('');
    if (id && open?.id === id) await reopen(id);
  };

  /** Every medicine in one dropdown: the clinic's own items first, then the medicine list. */
  async function openAdd() {
    setError(null);
    setAdding(true);
    setDraft({ masterId: null, displayName: '', category: 'MEDICINE', baseUnit: 'TABLET' });
    const r = await api<{ items: Master[] }>('/api/dispensary/master?limit=200');
    if (r.ok) setMasters(r.body.items);
  }
  const linked = new Set(items.map((i) => i.masterId).filter(Boolean));
  const pickOpts = [
    ...items.map((i) => ({ value: `item:${i.id}`, label: i.displayName, sub: `${t.alreadyYours} · ${unitWord(i.stock?.onHandBase ?? 0, i.baseUnit)}` })),
    ...masters.filter((m) => !linked.has(m.id)).map((m) => ({ value: `master:${m.id}`, label: m.brandName, sub: `${t.medicineList} · ${m.dosageForm.toLowerCase()}` })),
  ];
  function pick(v: string | null) {
    if (!v) return;
    const [kind, id] = v.split(':');
    if (kind === 'item') { setAdding(false); void reopen(id); return; }
    const m = masters.find((x) => x.id === id);
    if (m) setDraft({ masterId: m.id, displayName: m.brandName, category: 'MEDICINE', baseUnit: m.suggestedBaseUnit ?? 'TABLET' });
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await api<Item>('/api/dispensary/items', { body: draft });
    if (!r.ok) return setError(r.body.error ?? en.settings.failed);
    setAdding(false);
    await load('');
    setOpen(r.body);
  }
  async function patch(body: Record<string, unknown>) {
    if (!open) return;
    setError(null);
    const r = await api<Item>(`/api/dispensary/items/${open.id}`, { method: 'PATCH', body });
    if (!r.ok) return setError(r.body.error ?? en.settings.failed);
    setOpen(r.body);
    await load('');
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

  const needle = q.trim().toLowerCase();
  const stockMatch = (i: Item) => stockFilter === 'ALL' || (stockFilter === 'LOW' && i.stock?.lowStock)
    || (stockFilter === 'NEAR' && i.stock?.nearExpiry) || (stockFilter === 'EXPIRED' && (i.stock?.expiredBase ?? 0) > 0);
  const shown = items.filter((i) => (cat === 'ALL' || i.category === cat) && stockMatch(i) && (!needle || i.displayName.toLowerCase().includes(needle)));
  const low = items.filter((i) => i.stock?.lowStock).length;
  const near = items.filter((i) => i.stock?.nearExpiry).length;
  const expired = items.filter((i) => (i.stock?.expiredBase ?? 0) > 0).length;
  const label = (c: string) => ({ MEDICINE: 'Medicine', RETAIL_PRODUCT: 'Retail', INJECTABLE: 'Injectable', CONSUMABLE: 'Consumable' } as Record<string, string>)[c] ?? c;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label={t.items} value={items.length} />
        <KpiCard label={t.lowStock} value={low} tone={low ? 'amber' : 'ink'} />
        <KpiCard label={t.nearExpiryBadge} value={near} tone={near ? 'amber' : 'ink'} />
        <KpiCard label={t.expiredBadge} value={expired} tone={expired ? 'red' : 'ink'} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SearchField value={q} onChange={setQ} placeholder="Search items by name…" className="w-full md:w-80" />
        <FilterPills value={cat} onChange={setCat} options={[
          { key: 'ALL', label: 'All', count: items.length },
          ...CATEGORIES.map((c) => ({ key: c, label: label(c), count: items.filter((i) => i.category === c).length })),
        ]} />
 <FilterPills value={stockFilter} onChange={setStockFilter} options={[
          { key: 'ALL', label: t.allStock },
          { key: 'LOW', label: t.lowStock, count: low },
          { key: 'NEAR', label: t.nearExpiryBadge, count: near },
          { key: 'EXPIRED', label: t.expiredBadge, count: expired },
        ]} />
        {canEdit && (
          <Button variant="brutal-blue" className="md:ml-auto" onClick={() => void openAdd()}>
            <IconPlus className="h-4 w-4" /> {t.addItem}
          </Button>
        )}
      </div>
      <div className="card overflow-hidden">
        <DataList rows={shown} rowKey={(i) => i.id} empty={items.length ? 'No item matches.' : 'No items yet. Add the first one.'} onRowClick={(i) => reopen(i.id)} columns={[
          { key: 'name', header: 'Item', primary: true, cell: (i) => (
            <span><span className="block font-semibold text-ink">{i.displayName}</span><span className="block text-micro text-muted">{label(i.category)} · {i.baseUnit.toLowerCase()}</span></span>) },
          { key: 'balance', header: t.balance, align: 'right', cell: (i) => (
            <span className="block text-right">
              <span className="block font-semibold tnum text-ink">{unitWord(i.stock?.onHandBase ?? 0, i.baseUnit)}</span>
              <span className="flex justify-end gap-1">
                {i.stock?.lowStock && <Badge tone="warn">{t.lowStock}</Badge>}
                {i.stock?.nearExpiry && <Badge tone="warn">{t.nearExpiryBadge}</Badge>}
                {(i.stock?.expiredBase ?? 0) > 0 && <Badge tone="bad">{t.expiredBadge}</Badge>}
              </span>
            </span>) },
          { key: 'flags', header: t.scheduleFlags, cell: (i) => (
            <span className="flex flex-wrap gap-1">{i.scheduleFlags.length ? i.scheduleFlags.map((f) => <Badge key={f} tone="warn">{f}</Badge>) : <span className="text-faint">—</span>}</span>) },
          { key: 'rx', header: 'Prescription', cell: (i) => (i.requiresPrescription ? <Badge tone="bad">● Required</Badge> : <span className="text-faint">—</span>) },
          { key: 'reorder', header: 'Reorder at', align: 'right', phoneHidden: true, cell: (i) => <span className="tnum">{i.reorderLevel ?? '—'}</span> },
          ...(canAdjust ? [{ key: 'adjust', header: '', align: 'right' as const, cell: (i: Item) => (
            <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
              <Button onClick={() => void startAdjust(i.id)}>{t.adjust.short}</Button>
            </span>) }] : []),
        ]} />
      </div>
      <Sheet open={adding} onOpenChange={setAdding} title={t.addItem} wide>
        <div className="space-y-4">
          <div>
            <span className="block text-small font-medium text-ink-soft">{t.allMedicines}</span>
            <div className="mt-1">
              <Combobox items={pickOpts} value={draft.masterId ? `master:${draft.masterId}` : null} onChange={pick} placeholder={t.pickMedicine} emptyText={t.noMatch} />
            </div>
            <p className="mt-1 text-micro text-muted">{t.pickHint}</p>
          </div>
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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-small text-muted">{open.category} · {open.baseUnit}</p>
              {canAdjust && <Button variant="brutal-blue" onClick={() => setAdjusting(open)}>{t.adjust.button}</Button>}
            </div>
            <section className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <KpiCard label={t.balance} value={packs(open.stock?.onHandBase ?? 0, open.baseUnit, open.units)} />
                <KpiCard label={t.dispensableNow} value={packs(open.stock?.dispensableBase ?? 0, open.baseUnit, open.units)}
                  tone={open.stock?.lowStock ? 'amber' : 'ink'} sub={open.stock?.nearestExpiry ? `${t.nearestExpiry}: ${dmy(open.stock.nearestExpiry)}` : undefined} />
              </div>
              {(open.stock?.batches?.length ?? 0) > 0 ? (
                <div className="card overflow-hidden">
                  <DataList rows={open.stock!.batches!} rowKey={(b) => b.id} empty={t.noStock} columns={[
                    { key: 'no', header: t.batchNo, primary: true, cell: (b) => <span className="font-semibold">{b.batchNo}</span> },
                    { key: 'exp', header: t.expiry, cell: (b) => (
                      <span className="flex items-center gap-1">{dmy(b.expiryDate)}{b.expired && <Badge tone="bad">{t.expiredBadge}</Badge>}</span>) },
                    { key: 'mrp', header: t.mrp, align: 'right', cell: (b) => <span className="tnum">{fmtPaise(b.mrpPaise)} / {b.mrpUnitName}</span> },
                    { key: 'on', header: t.onHand, align: 'right', cell: (b) => (
                      <span className="block text-right">
                        <span className="block tnum font-semibold">{packs(b.onHandBase, open.baseUnit, open.units)}</span>
                        <span className="block text-micro text-muted">{b.locations.map((l) => `${l.name} ${l.onHandBase}`).join(' · ')}</span>
                      </span>) },
                  ]} />
                </div>
              ) : (open.stock?.untracked?.length ?? 0) === 0 && <p className="text-small text-muted">{t.noStock}</p>}
            </section>
            <section>
              <p className="text-small font-semibold">{t.history}</p>
              {history.items.length === 0 ? <p className="text-small text-muted">{t.noHistory}</p> : (
                <ul className="divide-y divide-hairline">
                  {history.items.map((m) => (
                    <li key={m.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-small">
                      <span>
                        <span className="font-medium text-ink">{movementLabel(m.type)}</span>
                        <span className="text-muted"> · {m.batchNo ?? m.locationName} · {t.by} {m.actorLabel}</span>
                      </span>
                      <span className="flex items-baseline gap-3">
                        <span className={`tnum font-semibold ${m.qtyDelta < 0 ? 'text-bad' : 'text-ok'}`}>{m.qtyDelta > 0 ? '+' : ''}{m.qtyDelta}</span>
                        <span className="tnum text-micro text-muted">{istDateTime(m.occurredAt)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {history.next && <Button className="mt-2" onClick={() => loadHistory(open.id, history.next)}>{t.loadMore}</Button>}
            </section>
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
      <AdjustStockSheet item={adjusting} onClose={() => setAdjusting(null)} onDone={() => void adjusted()} />
    </div>
  );
}
