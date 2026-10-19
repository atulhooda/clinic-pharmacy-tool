'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Button from '@/components/ui/Button';
import Sheet from '@/components/ui/Sheet';
import { TextField, SelectField, TextareaField } from '@/components/ui/Field';
import { useGrant } from '@/components/settings/useGrant';
import { api, newIdempotencyKey } from '@/components/settings/client';
import { en } from '@/lib/i18n/en';
import { fmtPaise } from '@/lib/money';
import { dmy, packs, parseRupees, unitWord } from './format';

const t = en.stock.adjust;
type Unit = { id: string; name: string; baseUnitsPerUnit: number; isBase: boolean; active: boolean };
type Batch = { id: string; premisesId: string; batchNo: string; expiryDate: string; expired: boolean; mrpPaise: number; mrpUnitName: string; onHandBase: number;
  locations: { kind: string; onHandBase: number }[] };
export type AdjustItem = { id: string; displayName: string; baseUnit: string; trackBatches: boolean; units?: Unit[];
  stock?: { batches?: Batch[]; untracked?: { premisesId: string; kind: string; onHandBase: number }[] } };
type Premises = { id: string; name: string; settings: unknown | null };
const NEW = 'new';

/**
 * E-34 (D-53): count what is on the shelf for one batch, and record the difference. A batch with no
 * history here becomes opening stock; otherwise a count correction with a reason. Signed.
 */
export function AdjustStockSheet({ item, onClose, onDone }: { item: AdjustItem | null; onClose: () => void; onDone: () => void }) {
  const { withGrant, dialog } = useGrant();
  const [premises, setPremises] = useState<Premises[]>([]);
  const [premisesId, setPremisesId] = useState('');
  const [batchId, setBatchId] = useState('');
  const [nb, setNb] = useState({ batchNo: '', expiry: '', mrp: '', mrpUnitId: '' });
  const [count, setCount] = useState('');
  const [unitId, setUnitId] = useState('');
  const [reason, setReason] = useState('COUNT_CORRECTION');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);

  useEffect(() => {
    if (!item) return;
    setError(null); setCount(''); setNote(''); setReason('COUNT_CORRECTION'); setKey(newIdempotencyKey());
    setNb({ batchNo: '', expiry: '', mrp: '', mrpUnitId: (item.units ?? []).find((u) => !u.isBase && u.active)?.id ?? (item.units ?? []).find((u) => u.isBase)?.id ?? '' });
    setUnitId((item.units ?? []).find((u) => u.isBase)?.id ?? '');
    void api<{ items: Premises[] }>('/api/dispensary/premises').then((r) => {
      const ready = r.ok ? r.body.items.filter((p) => p.settings) : [];
      setPremises(ready);
      setPremisesId((cur) => (ready.some((p) => p.id === cur) ? cur : ready[0]?.id ?? ''));
    });
  }, [item]);

  const tracked = item?.trackBatches ?? true;
  const batches = (item?.stock?.batches ?? []).filter((b) => b.premisesId === premisesId);
  useEffect(() => { setBatchId(batches[0]?.id ?? NEW); }, [premisesId, item]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!item) return null;

  const units = (item.units ?? []).filter((u) => u.active);
  const factor = units.find((u) => u.id === unitId)?.baseUnitsPerUnit ?? 1;
  const n = /^\d+$/.test(count.trim()) ? Number(count.trim()) : null;
  const countedBase = n === null ? null : n * factor;
  const batch = batches.find((b) => b.id === batchId);
  // What the count replaces: the batch at the store, or in quarantine once it has expired (where the server counts it).
  const recorded = tracked ? (batch?.locations ?? []).filter((l) => (l.kind === 'QUARANTINE') === !!batch?.expired).reduce((a, l) => a + l.onHandBase, 0)
    : (item.stock?.untracked ?? []).filter((u) => u.premisesId === premisesId && u.kind !== 'QUARANTINE').reduce((a, u) => a + u.onHandBase, 0);
  const isNew = tracked && batchId === NEW;
  // A new batch, or an untracked item with nothing yet, has no history: opening stock, no reason.
  const opening = isNew || (!tracked && recorded === 0 && !(item.stock?.untracked ?? []).some((u) => u.premisesId === premisesId));
  const delta = countedBase === null ? null : countedBase - recorded;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (countedBase === null) return setError(t.needCount);
    if (!opening && reason === 'OTHER' && !note.trim()) return setError(t.noteRequired);
    const line: Record<string, unknown> = { itemId: item!.id, countedBase };
    if (tracked && isNew) {
      const mrpPaise = parseRupees(nb.mrp);
      // Name every box that is missing, not "try again": a new batch needs all three (they are on the pack).
      const missing = [!nb.batchNo.trim() && t.batchNo, !/^\d{1,2}\s*[/-]\s*(\d{2}|\d{4})$/.test(nb.expiry.trim()) && t.expiry, !mrpPaise && t.mrp].filter(Boolean);
      if (missing.length) return setError(`${t.needBatch} ${missing.join(', ')}.`);
      line.newBatch = { batchNo: nb.batchNo, expiry: nb.expiry, mrpPaise, mrpUnitId: nb.mrpUnitId };
    } else if (tracked) {
      line.batchId = batchId;
    }
    setBusy(true);
    try {
      const grant = await withGrant('stock.adjust', premisesId);
      if (!grant) return;
      const r = await api('/api/dispensary/adjustments', { grant, idempotencyKey: key,
        body: { premisesId, reasonCode: opening ? null : reason, note: note.trim() || null, lines: [line] } });
      if (!r.ok) return setError(r.body.error ?? en.settings.failed);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={`${t.title}: ${item.displayName}`} description={t.intro}>
      <form onSubmit={save} className="space-y-3" noValidate>
        {premises.length > 1 && (
          <SelectField label={t.premises} value={premisesId} onChange={(e) => setPremisesId(e.target.value)}>
            {premises.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </SelectField>
        )}
        {tracked && (
          <SelectField label={t.batch} value={batchId} onChange={(e) => setBatchId(e.target.value)}>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.batchNo} · {dmy(b.expiryDate)} · {fmtPaise(b.mrpPaise)}/{b.mrpUnitName} · {packs(b.onHandBase, item.baseUnit, item.units)}
              </option>
            ))}
            <option value={NEW}>{t.newBatch}</option>
          </SelectField>
        )}
        {isNew && (
          <div className="grid grid-cols-2 gap-3">
            <TextField label={t.batchNo} value={nb.batchNo} maxLength={40} onChange={(e) => setNb({ ...nb, batchNo: e.target.value })} />
            <TextField label={t.expiry} value={nb.expiry} placeholder="MM/YYYY" maxLength={10} onChange={(e) => setNb({ ...nb, expiry: e.target.value })} />
            <TextField label={t.mrp} inputMode="decimal" value={nb.mrp} onChange={(e) => setNb({ ...nb, mrp: e.target.value })} />
            <SelectField label={t.mrpPer} value={nb.mrpUnitId} onChange={(e) => setNb({ ...nb, mrpUnitId: e.target.value })}>
              {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </SelectField>
          </div>
        )}
        {batch?.expired && <p className="text-small text-warn">{t.expiredToQuarantine}</p>}
        <div className="grid grid-cols-2 gap-3">
          <TextField label={t.counted} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ''))} />
          <SelectField label={t.countedIn} value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            {units.map((u) => <option key={u.id} value={u.id}>{u.isBase ? u.name : `${u.name} (${u.baseUnitsPerUnit})`}</option>)}
          </SelectField>
        </div>
        <dl className="grid grid-cols-2 gap-2 text-small">
          <dt className="text-muted">{t.recorded}</dt><dd className="tnum text-right">{unitWord(recorded, item.baseUnit)}</dd>
          {delta !== null && (<>
            <dt className="text-muted">{t.change}</dt>
            <dd className={`tnum text-right font-semibold ${delta < 0 ? 'text-bad' : delta > 0 ? 'text-ok' : ''}`}>
              {delta === 0 ? t.nothing : `${delta > 0 ? '+' : ''}${unitWord(delta, item.baseUnit)}`}
            </dd>
          </>)}
        </dl>
        {opening ? <p className="text-micro text-muted">{t.opening}</p> : (
          <SelectField label={t.reason} value={reason} onChange={(e) => setReason(e.target.value)}>
            {Object.entries(t.reasons).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </SelectField>
        )}
        <TextareaField label={t.note} value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} />
        {error && <p role="alert" className="text-small text-bad">{error}</p>}
        <Button type="submit" variant="brutal-blue" disabled={busy || delta === null || delta === 0 || !premisesId}>{t.save}</Button>
      </form>
      {dialog}
    </Sheet>
  );
}
