'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import Combobox from '@/components/ui/Combobox';
import DataList from '@/components/ui/DataList';
import FilterPills from '@/components/ui/FilterPills';
import Sheet from '@/components/ui/Sheet';
import { TextField, SelectField } from '@/components/ui/Field';
import { IconPlus } from '@/components/ui/icons';
import { en } from '@/lib/i18n/en';
import { api } from '@/components/settings/client';
import { dmy } from './format';
import { usePremises, useSuppliers } from './catalogue';

const t = en.receive;
type Row = { id: string; status: 'DRAFT' | 'POSTED' | 'REVERSED' | 'DISCARDED'; premisesId: string; supplierName: string; invoiceNo: string; invoiceDate: string;
  lineCount: number; createdAt: string; postedAt: string | null };
const TONE = { DRAFT: 'brand', POSTED: 'ok', REVERSED: 'neutral', DISCARDED: 'neutral' } as const;
const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** E-23: the deliveries at the caller's premises; a new one starts as a draft. */
export function ReceivePanel({ canEdit }: { canEdit: boolean }) {
  const router = useRouter();
  const suppliers = useSuppliers();
  const premises = usePremises();
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState<'ALL' | 'DRAFT' | 'POSTED'>('ALL');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ premisesId: '', supplierId: null as string | null, invoiceNo: '', invoiceDate: todayIst() });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api<{ items: Row[] }>('/api/dispensary/goods-receipts').then((r) => r.ok && setRows(r.body.items)); }, []);
  const ready = premises.filter((p) => p.settings);
  useEffect(() => { if (!form.premisesId && ready[0]) setForm((f) => ({ ...f, premisesId: ready[0].id })); }, [ready, form.premisesId]);
  const supplierOpts = useMemo(() => suppliers.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name,
    sub: `${s.gstin ?? 'No GSTIN'} · licence ${s.licenceStatus.toLowerCase().replace('_', ' ')}` })), [suppliers]);
  const names = new Map(premises.map((p) => [p.id, p.name]));

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.supplierId) return setError(t.supplier);
    const r = await api<{ id: string }>('/api/dispensary/goods-receipts', { body: { premisesId: form.premisesId, supplierId: form.supplierId,
      invoiceNo: form.invoiceNo.trim(), invoiceDate: form.invoiceDate } });
    if (!r.ok) return setError(r.body.error ?? en.settings.failed);
    router.push(`/stock/receive/${r.body.id}`);
  }

  const shown = rows.filter((r) => filter === 'ALL' || r.status === filter);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <FilterPills value={filter} onChange={setFilter} options={[
          { key: 'ALL', label: 'All', count: rows.length },
          { key: 'DRAFT', label: t.status.DRAFT, count: rows.filter((r) => r.status === 'DRAFT').length },
          { key: 'POSTED', label: t.status.POSTED, count: rows.filter((r) => r.status === 'POSTED').length },
        ]} />
        {canEdit && (
          <Button variant="brutal-blue" className="md:ml-auto" onClick={() => { setError(null); setAdding(true); }}>
            <IconPlus className="h-4 w-4" /> {t.newDelivery}
          </Button>
        )}
      </div>
      <div className="card overflow-hidden">
        <DataList rows={shown} rowKey={(r) => r.id} empty={t.none} onRowClick={(r) => router.push(`/stock/receive/${r.id}`)} columns={[
          { key: 'supplier', header: t.supplier, primary: true, cell: (r) => (
            <span><span className="block font-semibold text-ink">{r.supplierName}</span><span className="block text-micro text-muted">{r.invoiceNo} · {dmy(r.invoiceDate)}</span></span>) },
          { key: 'status', header: 'Status', cell: (r) => <Badge tone={TONE[r.status]}>{t.status[r.status]}</Badge> },
          { key: 'lines', header: t.lines, align: 'right', cell: (r) => <span className="tnum">{r.lineCount}</span> },
          { key: 'premises', header: t.premises, phoneHidden: true, cell: (r) => <span className="text-muted">{names.get(r.premisesId) ?? ''}</span> },
        ]} />
      </div>
      <Sheet open={adding} onOpenChange={setAdding} title={t.newDelivery}>
        <form onSubmit={create} className="space-y-3" noValidate>
          {ready.length > 1 && (
            <SelectField label={t.premises} value={form.premisesId} onChange={(e) => setForm({ ...form, premisesId: e.target.value })}>
              {ready.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </SelectField>
          )}
          <div>
            <span className="block text-small font-medium text-ink-soft">{t.supplier}</span>
            <div className="mt-1"><Combobox items={supplierOpts} value={form.supplierId} onChange={(v) => setForm({ ...form, supplierId: v })} placeholder="…" emptyText="—" /></div>
          </div>
          <TextField label={t.invoiceNo} value={form.invoiceNo} maxLength={40} onChange={(e) => setForm({ ...form, invoiceNo: e.target.value })} />
          <TextField label={t.invoiceDate} type="date" value={form.invoiceDate} onChange={(e) => setForm({ ...form, invoiceDate: e.target.value })} />
          {error && <p role="alert" className="text-small text-bad">{error}</p>}
          <Button type="submit" variant="brutal">{t.create}</Button>
        </form>
      </Sheet>
    </div>
  );
}
