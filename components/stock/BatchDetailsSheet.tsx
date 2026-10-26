'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Button from '@/components/ui/Button';
import Sheet from '@/components/ui/Sheet';
import { TextField, SelectField } from '@/components/ui/Field';
import { useGrant } from '@/components/settings/useGrant';
import { api, newIdempotencyKey } from '@/components/settings/client';
import { en } from '@/lib/i18n/en';
import { parseRupees, unitWord } from './format';

const t = en.stock.details;
type Unit = { id: string; name: string; baseUnitsPerUnit: number; isBase: boolean; active: boolean };
export type PendingStock = { itemId: string; itemName: string; baseUnit: string; premisesId: string; pendingBase: number; units: Unit[];
  /** D-60: editing a real batch: its id and current details. */
  from?: { batchId: string; batchNo: string; expiry: string; mrpPaise: number; mrpUnitId: string | null } };
const EXPIRY = /^(\d{1,2}\s*[/-]\s*(\d{2}|\d{4})|\d{4}-\d{2}-\d{2})$/;

/**
 * D-55: read the batch number, expiry and MRP off the pack for stock held as "details pending".
 * The quantity defaults to all of it; with several batches on the shelf, do one at a time.
 */
export function BatchDetailsSheet({ stock, onClose, onDone }: { stock: PendingStock | null; onClose: () => void; onDone: () => void }) {
  const { withGrant, dialog } = useGrant();
  const [f, setF] = useState({ batchNo: '', expiry: '', mrp: '', mrpUnitId: '', count: '', unitId: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);

  useEffect(() => {
    if (!stock) return;
    const units = stock.units.filter((u) => u.active);
    const pack = units.filter((u) => !u.isBase).sort((a, b) => b.baseUnitsPerUnit - a.baseUnitsPerUnit)[0];
    const base = units.find((u) => u.isBase);
    // Count in the pack when the pending stock is whole packs, else in the base unit.
    const countUnit = pack && stock.pendingBase % pack.baseUnitsPerUnit === 0 ? pack : base;
    setF({ batchNo: '', expiry: '', mrp: '', mrpUnitId: (pack ?? base)?.id ?? '', count: String(stock.pendingBase / (countUnit?.baseUnitsPerUnit ?? 1)), unitId: countUnit?.id ?? '' });
    setError(null); setKey(newIdempotencyKey());
    if (stock.from) {
      const e = stock.from.expiry;
      setF((cur) => ({ ...cur, batchNo: stock.from!.batchNo, expiry: `${e.slice(5, 7)}/${e.slice(0, 4)}`, mrp: (stock.from!.mrpPaise / 100).toFixed(2), mrpUnitId: stock.from!.mrpUnitId ?? cur.mrpUnitId }));
      return;
    }
    // Prefill from the newest bill of the item, when it has these details.
    void api<{ hint: { batchNo: string | null; expiry: string | null; mrpPaise: number | null; mrpUnitId: string | null } | null }>(
      `/api/dispensary/items/${stock.itemId}/batch-hint?premisesId=${stock.premisesId}`).then((r) => {
      const h = r.ok ? r.body.hint : null;
      if (h) setF((cur) => ({ ...cur, batchNo: h.batchNo ?? '', expiry: h.expiry ?? '', mrp: h.mrpPaise ? (h.mrpPaise / 100).toFixed(2) : '', mrpUnitId: h.mrpUnitId ?? cur.mrpUnitId }));
    });
  }, [stock]);
  if (!stock) return null;

  const units = stock.units.filter((u) => u.active);
  const factor = units.find((u) => u.id === f.unitId)?.baseUnitsPerUnit ?? 1;
  const qtyBase = /^\d+$/.test(f.count.trim()) ? Number(f.count.trim()) * factor : null;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const mrpPaise = parseRupees(f.mrp);
    const missing = [!f.batchNo.trim() && t.batchNo, !EXPIRY.test(f.expiry.trim()) && t.expiry, !mrpPaise && t.mrp, !qtyBase && t.qty].filter(Boolean);
    if (missing.length) return setError(`${t.missing} ${missing.join(', ')}.`);
    if (qtyBase! > stock!.pendingBase) return setError(t.tooMany);
    setBusy(true);
    try {
      const grant = await withGrant('stock.adjust', stock!.premisesId);
      if (!grant) return;
      const r = await api('/api/dispensary/adjustments/batch-details', { grant, idempotencyKey: key, body: {
        premisesId: stock!.premisesId, itemId: stock!.itemId, batchNo: f.batchNo, expiry: f.expiry, mrpPaise, mrpUnitId: f.mrpUnitId, qtyBase,
        fromBatchId: stock!.from?.batchId ?? null } });
      if (!r.ok) return setError(r.body.error ?? en.settings.failed);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={`${stock.from ? t.editTitle : t.title}: ${stock.itemName}`} description={stock.from ? t.editIntro : t.intro}>
      <form onSubmit={save} className="space-y-4" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <TextField label={t.batchNo} autoFocus value={f.batchNo} maxLength={40} onChange={(e) => setF({ ...f, batchNo: e.target.value })} />
          <TextField label={t.expiry} value={f.expiry} placeholder="MM/YYYY" maxLength={10} onChange={(e) => setF({ ...f, expiry: e.target.value })} />
          <TextField label={t.mrp} inputMode="decimal" value={f.mrp} onChange={(e) => setF({ ...f, mrp: e.target.value })} />
          <SelectField label={t.mrpPer} value={f.mrpUnitId} onChange={(e) => setF({ ...f, mrpUnitId: e.target.value })}>
            {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </SelectField>
          <TextField label={t.qty} inputMode="numeric" value={f.count} onChange={(e) => setF({ ...f, count: e.target.value.replace(/\D/g, '') })} />
          <SelectField label={t.countedIn} value={f.unitId} onChange={(e) => setF({ ...f, unitId: e.target.value })}>
            {units.map((u) => <option key={u.id} value={u.id}>{u.isBase ? u.name : `${u.name} (${u.baseUnitsPerUnit})`}</option>)}
          </SelectField>
        </div>
        <p className="text-small text-muted">{stock.from ? t.onBatch : t.pendingNow} {unitWord(stock.pendingBase, stock.baseUnit)}. {t.oneAtATime}</p>
        {error && <p role="alert" className="text-small text-bad">{error}</p>}
        <Button type="submit" variant="brutal-blue" disabled={busy}>{t.save}</Button>
      </form>
      {dialog}
    </Sheet>
  );
}
