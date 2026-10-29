'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import Banner from '@/components/ui/Banner';
import Combobox from '@/components/ui/Combobox';
import ConfirmDialog from '@/components/ui/Dialog';
import DataList from '@/components/ui/DataList';
import { TextField, SelectField } from '@/components/ui/Field';
import { IconPlus } from '@/components/ui/icons';
import { en } from '@/lib/i18n/en';
import { fmtPaise } from '@/lib/money';
import { api, newIdempotencyKey } from '@/components/settings/client';
import { dmy, istDateTime, parseRupees, unitWord } from './format';
import { itemOption, rupeesText, useItems, useSuppliers, type Unit } from './catalogue';

const t = en.receive;
type Problem = { code: string; lineNo?: number };
type ApiLine = { itemId: string; purchaseUnitId: string; qty: number; freeQty: number; batchNo: string | null; expiry: string | null; mrpPaise: number | null;
  mrpUnitId: string | null; purchaseRatePaise: number; discountPaise: number; gstRateBp: number | null; manufacturerName: string | null; manufacturerAddress: string | null;
  lineNo: number; itemName: string; baseUnit: string; purchaseUnitName: string; receivedBase: number; valuePaise: number; gstPaise: number };
type Grn = { id: string; status: 'DRAFT' | 'POSTED' | 'REVERSED' | 'DISCARDED'; supplierId: string; supplierName: string; supplierLicenceStatus: string;
  invoiceNo: string; invoiceDate: string; invoiceTotalPaise: number | null; notes: string | null; postedAt: string | null; lines: ApiLine[];
  valuePaise: number; gstPaise: number; totalPaise: number; checks: { errors: Problem[]; warnings: Problem[] } | null };
type Form = { key: string; itemId: string | null; purchaseUnitId: string | null; qty: string; freeQty: string; batchNo: string; expiry: string; mrp: string;
  mrpUnitId: string | null; rate: string; discount: string; gst: string; mfrName: string; mfrAddress: string };

const GST = ['', '0', '5', '12', '18', '28'];
const newKey = () => Math.random().toString(36).slice(2);
const blankLine = (): Form => ({ key: newKey(), itemId: null, purchaseUnitId: null, qty: '', freeQty: '', batchNo: '', expiry: '', mrp: '', mrpUnitId: null,
  rate: '', discount: '', gst: '', mfrName: '', mfrAddress: '' });
const fromApi = (l: ApiLine): Form => ({ key: newKey(), itemId: l.itemId, purchaseUnitId: l.purchaseUnitId, qty: String(l.qty), freeQty: l.freeQty ? String(l.freeQty) : '',
  batchNo: l.batchNo ?? '', expiry: l.expiry ?? '', mrp: rupeesText(l.mrpPaise), mrpUnitId: l.mrpUnitId, rate: l.purchaseRatePaise ? rupeesText(l.purchaseRatePaise) : '',
  discount: l.discountPaise ? rupeesText(l.discountPaise) : '', gst: l.gstRateBp === null ? '' : String(l.gstRateBp / 100), mfrName: l.manufacturerName ?? '', mfrAddress: l.manufacturerAddress ?? '' });
const problemText = (p: Problem) => `${p.lineNo ? `${t.line} ${p.lineNo}: ` : ''}${(t.problems as Record<string, string>)[p.code] ?? p.code}`;

/** E-24 … E-26: one delivery. A draft is edited and checked; a posted one is read-only. */
export function GrnEditor({ id, canEdit }: { id: string; canEdit: boolean }) {
  const { items, reload: reloadItems } = useItems();
  // "+ New medicine" on a line: add one that is not in the list yet, then pick it (founder, 2026-10-30).
  const [adding, setAdding] = useState<{ key: string; name: string; category: string; baseUnit: string; pack: string; per: string; busy: boolean } | null>(null);
  const suppliers = useSuppliers();
  const [grn, setGrn] = useState<Grn | null>(null);
  const [head, setHead] = useState({ supplierId: '', invoiceNo: '', invoiceDate: '', total: '', notes: '' });
  const [lines, setLines] = useState<Form[]>([]);
  const [units, setUnits] = useState<Record<string, Unit[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | { kind: 'post' | 'discard'; key: string }>(null);

  const loadUnits = useCallback(async (itemId: string) => {
    if (units[itemId]) return units[itemId];
    const r = await api<{ units: Unit[] }>(`/api/dispensary/items/${itemId}`);
    const us = r.ok ? r.body.units : [];
    setUnits((u) => ({ ...u, [itemId]: us }));
    return us;
  }, [units]);

  const show = useCallback((g: Grn) => {
    setGrn(g);
    setHead({ supplierId: g.supplierId, invoiceNo: g.invoiceNo, invoiceDate: g.invoiceDate, total: rupeesText(g.invoiceTotalPaise), notes: g.notes ?? '' });
    setLines(g.lines.map(fromApi));
    for (const l of g.lines) void loadUnits(l.itemId);
  }, [loadUnits]);

  useEffect(() => { void api<Grn>(`/api/dispensary/goods-receipts/${id}`).then((r) => r.ok && show(r.body)); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Removed items (Delete / Remove) are not offered for new deliveries.
  const itemOpts = useMemo(() => items.filter((i) => i.active).map(itemOption), [items]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const supplierOpts = useMemo(() => suppliers.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name,
    sub: `${s.gstin ?? 'No GSTIN'} · licence ${s.licenceStatus.toLowerCase().replace('_', ' ')}` })), [suppliers]);

  const set = (key: string, patch: Partial<Form>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  async function pickItem(key: string, itemId: string | null) {
    if (!itemId) return set(key, { itemId: null, purchaseUnitId: null, mrpUnitId: null });
    const us = await loadUnits(itemId);
    const buy = us.filter((u) => u.purchasable && u.active).sort((a, b) => b.baseUnitsPerUnit - a.baseUnitsPerUnit)[0] ?? us[0];
    set(key, { itemId, purchaseUnitId: buy?.id ?? null, mrpUnitId: buy?.id ?? null });
  }

  async function addItem() {
    if (!adding) return;
    setError(null);
    if (!adding.name.trim()) return setError(t.newItemName);
    const per = adding.pack.trim() ? Number(adding.per) : 0;
    if (adding.pack.trim() && !(Number.isInteger(per) && per > 1)) return setError(t.newItemPer);
    setAdding({ ...adding, busy: true });
    const r = await api<{ id: string }>('/api/dispensary/items', { body: { displayName: adding.name.trim(), category: adding.category, baseUnit: adding.baseUnit,
      useFor: adding.category === 'CONSUMABLE' ? 'IN_CLINIC' : 'PATIENTS' } });
    if (!r.ok) { setAdding({ ...adding, busy: false }); return setError(r.body.error ?? en.settings.failed); }
    if (adding.pack.trim()) {
      const u = await api(`/api/dispensary/items/${r.body.id}/units`, { body: { name: adding.pack.trim().toLowerCase(), baseUnitsPerUnit: per } });
      if (!u.ok) setError(u.body.error ?? en.settings.failed);
    }
    await reloadItems();
    setUnits((x) => { const { [r.body.id]: _drop, ...rest } = x; void _drop; return rest; });
    const key = adding.key;
    setAdding(null);
    await pickItem(key, r.body.id);
  }

  /** The form as the API's lines, or the first problem a person must fix. */
  function toApi(): { lines: Record<string, unknown>[] } | { error: string } {
    const out: Record<string, unknown>[] = [];
    for (const [i, l] of lines.entries()) {
      const n = `${t.line} ${i + 1}`;
      if (!l.itemId || !l.purchaseUnitId) return { error: `${n}: ${t.item}?` };
      if (!/^\d+$/.test(l.qty) || Number(l.qty) < 1) return { error: `${n}: ${t.qty}?` };
      if (l.freeQty && !/^\d+$/.test(l.freeQty)) return { error: `${n}: ${t.free}?` };
      const mrp = l.mrp ? parseRupees(l.mrp) : null;
      const rate = l.rate ? parseRupees(l.rate) : 0;
      const disc = l.discount ? parseRupees(l.discount) : 0;
      if ((l.mrp && mrp === null) || (l.mrp && mrp === 0)) return { error: `${n}: ${t.mrp}?` };
      if (rate === null) return { error: `${n}: ${t.rate}?` };
      if (disc === null) return { error: `${n}: ${t.discount}?` };
      out.push({ itemId: l.itemId, purchaseUnitId: l.purchaseUnitId, qty: Number(l.qty), freeQty: l.freeQty ? Number(l.freeQty) : 0,
        batchNo: l.batchNo.trim() || null, expiry: l.expiry.trim() || null, mrpPaise: mrp, mrpUnitId: mrp ? (l.mrpUnitId ?? l.purchaseUnitId) : null,
        purchaseRatePaise: rate, discountPaise: disc, gstRateBp: l.gst === '' ? null : Number(l.gst) * 100,
        manufacturerName: l.mfrName.trim() || null, manufacturerAddress: l.mfrAddress.trim() || null });
    }
    return { lines: out };
  }

  async function save(): Promise<boolean> {
    setError(null);
    setNotice(null);
    const body = toApi();
    if ('error' in body) { setError(body.error); return false; }
    const total = head.total ? parseRupees(head.total) : null;
    if (head.total && total === null) { setError(t.invoiceTotal); return false; }
    setBusy(true);
    const r = await api<Grn>(`/api/dispensary/goods-receipts/${id}`, { method: 'PATCH',
      body: { supplierId: head.supplierId, invoiceNo: head.invoiceNo.trim(), invoiceDate: head.invoiceDate, invoiceTotalPaise: total, notes: head.notes.trim() || null, lines: body.lines } });
    setBusy(false);
    if (!r.ok) { setError(r.body.error ?? en.settings.failed); return false; }
    show(r.body);
    setNotice(t.saved);
    return true;
  }

  async function post(key: string) {
    if (!(await save())) { setConfirm(null); return; }
    setBusy(true);
    const r = await api<{ grn: Grn; warnings: Problem[] | null }>(`/api/dispensary/goods-receipts/${id}/post`, { body: {}, idempotencyKey: key });
    setBusy(false);
    setConfirm(null);
    if (!r.ok) {
      const ps = (r.body as { details?: { problems?: Problem[] } }).details?.problems;
      setError(ps?.length ? ps.map(problemText).join(' · ') : r.body.error ?? en.settings.failed);
      return;
    }
    show(r.body.grn);
    setNotice(t.posted);
  }

  async function discard(key: string) {
    setBusy(true);
    const r = await api<Grn>(`/api/dispensary/goods-receipts/${id}/discard`, { body: {}, idempotencyKey: key });
    setBusy(false);
    setConfirm(null);
    if (r.ok) show(r.body);
    else setError(r.body.error ?? en.settings.failed);
  }

  if (!grn) return <p className="text-small text-muted">…</p>;
  const editable = canEdit && grn.status === 'DRAFT';
  const errors = grn.checks?.errors ?? [];
  const warnings = grn.checks?.warnings ?? [];
  const lineProblems = (n: number) => [...errors, ...warnings].filter((p) => p.lineNo === n);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={grn.status === 'POSTED' ? 'ok' : grn.status === 'DRAFT' ? 'brand' : 'neutral'}>{t.status[grn.status]}</Badge>
        {grn.postedAt && <span className="text-small text-muted">{t.received} {istDateTime(grn.postedAt)}</span>}
        <Link href="/stock/receive" className="ml-auto text-small font-semibold text-brand">← {t.title}</Link>
      </div>
      {notice && <Banner tone="info">{notice}</Banner>}
      {error && <Banner tone="bad">{error}</Banner>}

      <div className="card grid gap-3 p-4 md:grid-cols-2">
        {editable ? (
          <>
            <div>
              <span className="block text-small font-medium text-ink-soft">{t.supplier}</span>
              <div className="mt-1"><Combobox items={supplierOpts} value={head.supplierId} onChange={(v) => v && setHead({ ...head, supplierId: v })} emptyText="—" /></div>
            </div>
            <TextField label={t.invoiceNo} value={head.invoiceNo} maxLength={40} onChange={(e) => setHead({ ...head, invoiceNo: e.target.value })} />
            <TextField label={t.invoiceDate} type="date" value={head.invoiceDate} onChange={(e) => setHead({ ...head, invoiceDate: e.target.value })} />
            <TextField label={t.invoiceTotal} inputMode="decimal" value={head.total} onChange={(e) => setHead({ ...head, total: e.target.value })} />
          </>
        ) : (
          <div className="md:col-span-2 text-small">
            <span className="font-semibold text-ink">{grn.supplierName}</span> · {grn.invoiceNo} · {dmy(grn.invoiceDate)}
          </div>
        )}
      </div>

      {editable ? (
        <div className="space-y-3">
          {lines.map((l, i) => {
            const item = l.itemId ? itemById.get(l.itemId) : undefined;
            const us = (l.itemId && units[l.itemId]) || [];
            const needsMaker = item && (item.category === 'MEDICINE' || item.category === 'INJECTABLE');
            return (
              <div key={l.key} className="card space-y-3 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-micro font-semibold uppercase tracking-wide text-faint">{t.line} {i + 1}</span>
                  <Button size="sm" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>{t.remove}</Button>
                </div>
                {adding?.key === l.key && (
                  <div className="space-y-3 rounded-xl2 border border-hairline p-3">
                    <p className="text-small font-semibold">{t.newItemTitle}</p>
                    <TextField label={t.newItemName} value={adding.name} maxLength={120} autoFocus onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
                    <div className="grid grid-cols-2 gap-3">
                      <SelectField label={t.newItemType} value={adding.category} onChange={(e) => {
                        const c = e.target.value; setAdding({ ...adding, category: c, ...(c === 'MEDICINE' ? { baseUnit: 'TABLET', pack: 'strip', per: '10' } : { baseUnit: 'PIECE', pack: '', per: '' }) });
                      }}>
                        <option value="MEDICINE">{t.typeMedicine}</option>
                        <option value="RETAIL_PRODUCT">{t.typeRetail}</option>
                        <option value="INJECTABLE">{t.typeInjectable}</option>
                        <option value="CONSUMABLE">{t.typeConsumable}</option>
                      </SelectField>
                      <SelectField label={t.newItemUnit} value={adding.baseUnit} onChange={(e) => setAdding({ ...adding, baseUnit: e.target.value })}>
                        {['TABLET', 'CAPSULE', 'PIECE', 'ML', 'G', 'VIAL', 'UNIT'].map((u) => <option key={u} value={u}>{u.toLowerCase()}</option>)}
                      </SelectField>
                      <TextField label={t.newItemPack} placeholder="strip, box, bottle…" value={adding.pack} maxLength={40} onChange={(e) => setAdding({ ...adding, pack: e.target.value })} />
                      <TextField label={t.newItemPer} inputMode="numeric" value={adding.per} onChange={(e) => setAdding({ ...adding, per: e.target.value.replace(/\D/g, '') })} />
                    </div>
                    <p className="text-micro text-muted">{t.newItemHint}</p>
                    <span className="flex gap-2">
                      <Button type="button" variant="brutal-blue" disabled={adding.busy} onClick={() => void addItem()}>{t.newItemSave}</Button>
                      <Button type="button" onClick={() => setAdding(null)}>{en.reauth.cancel}</Button>
                    </span>
                  </div>
                )}
                <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_90px_90px]">
                  <div>
                    <span className="block text-small font-medium text-ink-soft">{t.item}</span>
                    <div className="mt-1"><Combobox items={itemOpts} value={l.itemId} onChange={(v) => void pickItem(l.key, v)} placeholder={t.pickItem} emptyText={t.noItem} /></div>
                    {adding?.key !== l.key && (
                      <button type="button" className="mt-1 text-small font-semibold text-brand"
                        onClick={() => setAdding({ key: l.key, name: '', category: 'MEDICINE', baseUnit: 'TABLET', pack: 'strip', per: '10', busy: false })}>{t.newItem}</button>
                    )}
                  </div>
                  <SelectField label={t.pack} value={l.purchaseUnitId ?? ''} onChange={(e) => set(l.key, { purchaseUnitId: e.target.value })}>
                    {us.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.isBase ? u.name : `${u.name} of ${u.baseUnitsPerUnit}`}</option>)}
                  </SelectField>
                  <TextField label={t.qty} inputMode="numeric" value={l.qty} onChange={(e) => set(l.key, { qty: e.target.value.replace(/\D/g, '') })} />
                  <TextField label={t.free} inputMode="numeric" value={l.freeQty} onChange={(e) => set(l.key, { freeQty: e.target.value.replace(/\D/g, '') })} />
                </div>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-7">
                  <TextField label={t.batch} value={l.batchNo} maxLength={40} onChange={(e) => set(l.key, { batchNo: e.target.value })} />
                  <TextField label={t.expiry} value={l.expiry} placeholder="MM/YYYY" maxLength={10} onChange={(e) => set(l.key, { expiry: e.target.value })} />
                  <TextField label={t.mrp} inputMode="decimal" value={l.mrp} onChange={(e) => set(l.key, { mrp: e.target.value })} />
                  <SelectField label={t.mrpPer} value={l.mrpUnitId ?? l.purchaseUnitId ?? ''} onChange={(e) => set(l.key, { mrpUnitId: e.target.value })}>
                    {us.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </SelectField>
                  <TextField label={t.rate} inputMode="decimal" value={l.rate} onChange={(e) => set(l.key, { rate: e.target.value })} />
                  <TextField label={t.discount} inputMode="decimal" value={l.discount} onChange={(e) => set(l.key, { discount: e.target.value })} />
                  <SelectField label={t.gst} value={l.gst} onChange={(e) => set(l.key, { gst: e.target.value })}>
                    {GST.map((g) => <option key={g} value={g}>{g === '' ? '—' : `${g}%`}</option>)}
                  </SelectField>
                </div>
                {needsMaker && (
                  <div className="grid gap-3 md:grid-cols-2">
                    <TextField label={t.manufacturer} hint={t.manufacturerHint} value={l.mfrName} maxLength={200} onChange={(e) => set(l.key, { mfrName: e.target.value })} />
                    <TextField label={t.manufacturerAddress} value={l.mfrAddress} maxLength={500} onChange={(e) => set(l.key, { mfrAddress: e.target.value })} />
                  </div>
                )}
                {lineProblems(i + 1).map((p) => (
                  <p key={p.code} className={`text-small ${errors.includes(p) ? 'text-bad' : 'text-warn-ink'}`}>{problemText({ code: p.code })}</p>
                ))}
              </div>
            );
          })}
          <Button onClick={() => setLines((ls) => [...ls, blankLine()])}><IconPlus className="h-4 w-4" /> {t.addLine}</Button>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <DataList rows={grn.lines} rowKey={(l) => String(l.lineNo)} empty="—" columns={[
            { key: 'item', header: t.item, primary: true, cell: (l) => <span className="font-semibold">{l.itemName}</span> },
            { key: 'qty', header: t.qty, cell: (l) => <span className="tnum">{l.qty} {l.purchaseUnitName}{l.freeQty ? ` + ${l.freeQty} ${t.free.toLowerCase()}` : ''}</span> },
            { key: 'batch', header: t.batch, cell: (l) => <span>{l.batchNo ?? '—'}{l.expiry ? ` · ${l.expiry}` : ''}</span> },
            { key: 'received', header: t.received, align: 'right', cell: (l) => <span className="tnum font-semibold">{unitWord(l.receivedBase, l.baseUnit)}</span> },
            { key: 'mrp', header: t.mrp, align: 'right', phoneHidden: true, cell: (l) => <span className="tnum">{l.mrpPaise ? fmtPaise(l.mrpPaise) : '—'}</span> },
            { key: 'value', header: t.value, align: 'right', cell: (l) => <span className="tnum">{fmtPaise(l.valuePaise)}</span> },
          ]} />
        </div>
      )}

      <div className="card flex flex-wrap items-center gap-4 p-4 text-small">
        <span>{t.value}: <b className="tnum">{fmtPaise(grn.valuePaise)}</b></span>
        <span>{t.gstTotal}: <b className="tnum">{fmtPaise(grn.gstPaise)}</b></span>
        <span>{t.total}: <b className="tnum">{fmtPaise(grn.totalPaise)}</b></span>
        {grn.invoiceTotalPaise !== null && <span className="text-muted">({t.invoiceTotal.replace(' (₹, optional)', '')}: {fmtPaise(grn.invoiceTotalPaise)})</span>}
      </div>

      {editable && (
        <>
          {errors.length > 0 ? (
            <Banner tone="bad"><b>{t.mustFix}:</b> {errors.map(problemText).join(' · ')}</Banner>
          ) : <Banner tone="info">{t.readyToPost}{warnings.length ? ` ${t.toCheck}: ${warnings.map(problemText).join(' · ')}` : ''}</Banner>}
          <div className="flex flex-wrap gap-2">
            <Button variant="brutal" busy={busy} onClick={() => void save()}>{t.save}</Button>
            <Button variant="brutal-blue" busy={busy} onClick={() => setConfirm({ kind: 'post', key: newIdempotencyKey() })}>{t.post}</Button>
            <Button variant="ghost" className="ml-auto" onClick={() => setConfirm({ kind: 'discard', key: newIdempotencyKey() })}>{t.discard}</Button>
          </div>
        </>
      )}
      <ConfirmDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)} busy={busy}
        title={confirm?.kind === 'discard' ? t.confirmDiscard : t.confirmPost} body={confirm?.kind === 'post' ? t.confirmPostBody : undefined}
        confirmLabel={confirm?.kind === 'discard' ? t.discard : t.post} cancelLabel={t.cancel} danger={confirm?.kind === 'discard'}
        onConfirm={() => (confirm?.kind === 'discard' ? discard(confirm.key) : post(confirm!.key))} />
    </div>
  );
}
