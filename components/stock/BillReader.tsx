'use client';

import { useMemo, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import Banner from '@/components/ui/Banner';
import Button from '@/components/ui/Button';
import Combobox from '@/components/ui/Combobox';
import { TextField, SelectField } from '@/components/ui/Field';
import { en } from '@/lib/i18n/en';
import { fmtPaise } from '@/lib/money';
import { api } from '@/components/settings/client';
import { packSizes } from './format';
import { itemOption, useItems, usePremises, useSuppliers, type Unit } from './catalogue';

const t = en.receive;
type Candidate = { id: string; name: string; score: number };
type Line = { name: string; pack: string | null; batch: string | null; expiry: string | null; qty: number | null; free: number | null; mrpPaise: number | null;
  ratePaise: number | null; discountPaise: number | null; gstRateBp: number | null; flags: string[]; itemId: string | null; candidates: Candidate[]; purchaseUnitId: string | null };
type Proposal = { supplier: { name: string | null; gstin: string | null; matchId: string | null; candidates: Candidate[] }; invoice: { number: string | null; date: string | null };
  lines: Line[]; skipped: number };
type Row = Line & { include: boolean; qtyText: string };

/** Shrink a photo in the browser before it is sent (the long side to 2000 px, JPEG). PDFs go as they are. */
async function shrink(file: File): Promise<Blob> {
  if (file.type === 'application/pdf') return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? file), 'image/jpeg', 0.85));
}

/** D-51, E-51: read a supplier's bill, check the matches, then create a draft delivery (E-23). */
export function BillReader() {
  const router = useRouter();
  const { items } = useItems();
  const suppliers = useSuppliers();
  const premises = usePremises().filter((p) => p.settings);
  const [phase, setPhase] = useState<'pick' | 'reading' | 'review'>('pick');
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [head, setHead] = useState({ premisesId: '', supplierId: null as string | null, invoiceNo: '', invoiceDate: '', supplierRead: '' });
  const itemOpts = useMemo(() => items.map(itemOption), [items]);
  const supplierOpts = useMemo(() => suppliers.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name, sub: s.gstin ?? '' })), [suppliers]);

  async function read(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setPhase('reading');
    const form = new FormData();
    form.append('file', await shrink(file), file.name);
    const res = await fetch('/api/dispensary/goods-receipts/read-bill', { method: 'POST', body: form });
    const body = (await res.json().catch(() => ({}))) as Proposal & { code?: string; error?: string };
    if (!res.ok) {
      setPhase('pick');
      setError(body.code === 'BILL_READER_NOT_CONFIGURED' ? t.notConfigured : body.error ?? en.settings.failed);
      return;
    }
    setRows(body.lines.map((l) => ({ ...l, include: !!l.itemId && l.qty !== null, qtyText: l.qty === null ? '' : String(l.qty) })));
    setHead({ premisesId: premises[0]?.id ?? '', supplierId: body.supplier.matchId, invoiceNo: body.invoice.number ?? '', invoiceDate: body.invoice.date ?? '',
      supplierRead: [body.supplier.name, body.supplier.gstin].filter(Boolean).join(' · ') });
    setPhase('review');
  }

  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function unitFor(r: Row): Promise<string | null> {
    if (r.purchaseUnitId && r.itemId === r.candidates[0]?.id) return r.purchaseUnitId;
    const res = await api<{ units: Unit[] }>(`/api/dispensary/items/${r.itemId}`);
    const units = (res.ok ? res.body.units : []).filter((u) => u.active && u.purchasable).sort((a, b) => b.baseUnitsPerUnit - a.baseUnitsPerUnit);
    return (packSizes(r.pack).map((n) => units.find((u) => u.baseUnitsPerUnit === n)).find(Boolean) ?? units.find((u) => !u.isBase) ?? units[0])?.id ?? null;
  }

  async function create() {
    setError(null);
    if (!head.supplierId) return setError(t.readNoSupplier);
    if (!head.invoiceNo.trim() || !head.invoiceDate) return setError(`${t.invoiceNo} · ${t.invoiceDate}`);
    const chosen = rows.filter((r) => r.include);
    const lines = [];
    for (const r of chosen) {
      if (!r.itemId || !/^\d+$/.test(r.qtyText) || Number(r.qtyText) < 1) return setError(`${r.name}: ${!r.itemId ? t.item : t.needsQty}`);
      const unit = await unitFor(r);
      lines.push({ itemId: r.itemId, purchaseUnitId: unit, qty: Number(r.qtyText), freeQty: r.free ?? 0, batchNo: r.batch, expiry: r.expiry,
        mrpPaise: r.mrpPaise, mrpUnitId: r.mrpPaise ? unit : null, purchaseRatePaise: r.ratePaise ?? 0, discountPaise: r.discountPaise ?? 0, gstRateBp: r.gstRateBp });
    }
    const left = rows.filter((r) => !r.include).map((r) => r.name);
    const notes = `${t.fromPhotoNote}${left.length ? ` ${t.notAdded}: ${left.join(', ')}` : ''}`.slice(0, 500);
    const res = await api<{ id: string }>('/api/dispensary/goods-receipts', { body: { premisesId: head.premisesId, supplierId: head.supplierId,
      invoiceNo: head.invoiceNo.trim(), invoiceDate: head.invoiceDate, notes, lines } });
    if (!res.ok) return setError(res.body.error ?? en.settings.failed);
    router.push(`/stock/receive/${res.body.id}`);
  }

  if (phase !== 'review') {
    return (
      <div className="space-y-4">
        <p className="text-small text-muted">{t.readHint}</p>
        {error && <Banner tone="bad">{error}</Banner>}
        {phase === 'reading' ? <Banner tone="info">{t.reading}</Banner> : (
          <label className="inline-flex min-h-[44px] cursor-pointer items-center rounded-full bg-ink px-5 text-small font-semibold text-white">
            {t.choose}
            <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="sr-only" onChange={(e) => void read(e)} />
          </label>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {error && <Banner tone="bad">{error}</Banner>}
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <span className="block text-small font-medium text-ink-soft">{t.supplier}</span>
          <div className="mt-1"><Combobox items={supplierOpts} value={head.supplierId} onChange={(v) => setHead({ ...head, supplierId: v })} emptyText="—" /></div>
          <p className="mt-1 text-micro text-muted">{t.asPrinted}: {head.supplierRead || '—'}</p>
        </div>
        {premises.length > 1 && (
          <SelectField label={t.premises} value={head.premisesId} onChange={(e) => setHead({ ...head, premisesId: e.target.value })}>
            {premises.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </SelectField>
        )}
        <TextField label={t.invoiceNo} value={head.invoiceNo} maxLength={40} onChange={(e) => setHead({ ...head, invoiceNo: e.target.value })} />
        <TextField label={t.invoiceDate} type="date" value={head.invoiceDate} onChange={(e) => setHead({ ...head, invoiceDate: e.target.value })} />
      </div>
      <ul className="space-y-3">
        {rows.map((r, i) => (
          <li key={i} className="card space-y-2 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold text-ink">{r.name}</span>
              <label className="flex items-center gap-2 text-small"><input type="checkbox" checked={r.include} onChange={(e) => set(i, { include: e.target.checked })} /> {t.include}</label>
            </div>
            <p className="text-micro text-muted">
              {[r.pack, r.batch && `${t.batch} ${r.batch}`, r.expiry && `exp ${r.expiry}`, r.free ? `+${r.free} ${t.free.toLowerCase()}` : null,
                r.mrpPaise !== null && `${t.mrp.replace(' (₹)', '')} ${fmtPaise(r.mrpPaise)}`, r.ratePaise !== null && `rate ${fmtPaise(r.ratePaise)}`,
                r.gstRateBp !== null && `GST ${r.gstRateBp / 100}%`].filter(Boolean).join(' · ')}
              {r.flags.length > 0 && <span className="text-warn-ink"> · {t.unclear}: {r.flags.join(', ')}</span>}
            </p>
            <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_100px]">
              <Combobox items={itemOpts} value={r.itemId} onChange={(v) => set(i, { itemId: v, include: !!v && r.qtyText !== '' })} placeholder={t.pickItem} emptyText={t.noItem} />
              <TextField label={t.qty} inputMode="numeric" value={r.qtyText} onChange={(e) => set(i, { qtyText: e.target.value.replace(/\D/g, '') })} />
            </div>
            {!r.itemId && <p className="text-small text-warn-ink">{t.unmatched}</p>}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="brutal-blue" onClick={() => void create()}>{t.createFromPhoto}</Button>
        <Button variant="ghost" onClick={() => { setRows([]); setPhase('pick'); }}>{t.readAgain}</Button>
      </div>
    </div>
  );
}
