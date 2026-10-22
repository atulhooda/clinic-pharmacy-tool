'use client';

import { useCallback, useEffect, useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import DataList from '@/components/ui/DataList';
import FilterPills from '@/components/ui/FilterPills';
import { api, newIdempotencyKey } from '@/components/settings/client';
import { useGrant } from '@/components/settings/useGrant';
import { en } from '@/lib/i18n/en';

const t = en.deskSales;
type Row = {
  id: string; premisesId: string; billSerial: string; lineKey: string; issuedAt: string; receivedAt: string; itemId: string | null; itemName: string | null;
  qtyBase: number; baseUnit: string | null; status: 'POSTED' | 'SHORT' | 'REJECTED' | 'CANCELLED'; shortBase: number; reason: string | null;
};
type Filter = 'open' | 'all';

const reasonText = (r: string | null) => (r ? (t.reasons as Record<string, string>)[r] ?? r : '');
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

/** D-57, E-55/E-56: desk sale lines that took no stock (short or not sellable here), and Retry. */
export function DeskSalesPanel({ canResolve }: { canResolve: boolean }) {
  const [filter, setFilter] = useState<Filter>('open');
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { withGrant, dialog } = useGrant();

  const load = useCallback(async () => {
    const r = await api<{ items: Row[] }>(`/api/dispensary/desk-sales?status=${filter}`);
    if (r.ok) { setRows(r.body.items); setError(null); } else setError(r.body.error ?? t.failed);
  }, [filter]);
  useEffect(() => { void load(); }, [load]);

  const retry = async (row: Row) => {
    setNote(null);
    const grant = await withGrant('stock.adjust', row.premisesId);
    if (!grant) return;
    setBusy(row.id);
    const r = await api<Row>(`/api/dispensary/desk-sales/${row.id}/resolve`, { method: 'POST', body: {}, grant, idempotencyKey: newIdempotencyKey() });
    setBusy(null);
    if (!r.ok) { setError(r.body.error ?? t.failed); return; }
    setNote(r.body.status === 'POSTED' ? t.done : t.stillShort);
    await load();
  };

  const status = (r: Row) => r.status === 'POSTED'
    ? <Badge tone="ok" icon="●">{t.posted}</Badge>
    : r.status === 'SHORT'
      ? <Badge tone="warn" icon="⚠">{t.short} {r.shortBase}</Badge>
      : r.status === 'CANCELLED'
        ? <Badge tone="neutral" icon="○">{t.cancelled}</Badge>
        : <Badge tone="bad" icon="✕">{t.rejected}</Badge>;

  return (
    <div className="space-y-4">
      <FilterPills value={filter} onChange={setFilter} options={[{ key: 'open', label: t.open }, { key: 'all', label: t.all }]} />
      {error && <p role="alert" className="text-small text-bad">{error}</p>}
      {note && <p role="status" className="text-small text-muted">{note}</p>}
      <div className="card overflow-hidden">
        <DataList rows={rows} rowKey={(r) => r.id} empty={filter === 'open' ? t.empty : t.emptyAll} columns={[
          { key: 'item', header: t.item, primary: true, cell: (r) => (
            <span>
              <span className="block font-semibold text-ink">{r.itemName ?? t.unknownItem}</span>
              {r.reason && <span className="block text-micro text-muted">{reasonText(r.reason)}</span>}
            </span>) },
          { key: 'bill', header: t.bill, cell: (r) => <span className="tnum">{r.billSerial}</span> },
          { key: 'qty', header: t.qty, align: 'right', cell: (r) => <span className="tnum">{r.qtyBase} {r.baseUnit?.toLowerCase() ?? ''}</span> },
          { key: 'status', header: t.status, cell: status },
          { key: 'received', header: t.received, phoneHidden: true, cell: (r) => <span className="text-small text-muted">{when(r.receivedAt)}</span> },
          { key: 'action', header: '', align: 'right', cell: (r) => (canResolve && (r.status === 'SHORT' || r.status === 'REJECTED') && r.itemId
            ? <Button size="sm" busy={busy === r.id} onClick={() => void retry(r)}>{t.retry}</Button> : null) },
        ]} />
      </div>
      {dialog}
    </div>
  );
}
