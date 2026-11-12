'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import DataList from '@/components/ui/DataList';
import { api, newIdempotencyKey } from '@/components/settings/client';
import { useGrant } from '@/components/settings/useGrant';
import { en } from '@/lib/i18n/en';
import { deskBillParty, unitName } from '@/lib/stock/display';

const t = en.deskSales;
type State = 'TAKEN' | 'PART_RETURNED' | 'RETURNED' | 'SHORT' | 'REJECTED' | 'CANCELLED';
type Credit = { serial: string | null; returnedBase: number; status: 'RETURNED' | 'NOTHING_TO_RETURN'; reason: string | null; receivedAt: string };
type Row = {
  id: string; premisesId: string; billSerial: string; lineKey: string; issuedAt: string; receivedAt: string; itemId: string | null; itemName: string | null;
  qtyBase: number; baseUnit: string | null; batches: string | null; returnedBase: number; status: 'POSTED' | 'SHORT' | 'REJECTED' | 'CANCELLED'; shortBase: number; reason: string | null;
  rxFlags: string[] | null; credits: Credit[]; state: State;
};
type Bill = { billId: string; billSerial: string; issuedAt: string; patientName: string | null; patientRef: string | null; patientHidden: boolean; doctorName: string | null; lines: Row[] };

/** D-67: the page reads again on its own this often while it is on screen, and whenever it comes back into view. */
const REFRESH_MS = 30_000;

const reasonText = (r: string | null) => (r ? (t.reasons as Record<string, string>)[r] ?? r : '');
const flagText = (f: string) => (t.flags as Record<string, string>)[f] ?? f;
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
const clock = (d: Date) => d.toLocaleTimeString('en-IN', { timeStyle: 'short', timeZone: 'Asia/Kolkata' });

/** D-57, D-62, D-67, E-55/E-56: every desk bill, who it was for, its lines as they stand now, and Retry for the ones that took no stock. */
export function DeskSalesPanel({ canResolve }: { canResolve: boolean }) {
  const [bills, setBills] = useState<Bill[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flagged, setFlagged] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const { withGrant, dialog } = useGrant();
  // A slower, older read never replaces a newer one.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const r = await api<{ bills: Bill[] }>(`/api/dispensary/desk-sales?status=${flagged ? 'flagged' : 'all'}`);
    if (mine !== seq.current) return;
    if (r.ok) { setBills(r.body.bills); setError(null); setUpdatedAt(new Date()); } else setError(r.body.error ?? t.failed);
  }, [flagged]);

  useEffect(() => {
    void load();
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = window.setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, [load]);

  const retry = async (row: Row) => {
    setNote(null);
    const grant = await withGrant('stock.adjust', row.premisesId);
    if (!grant) return;
    setBusy(row.id);
    const r = await api<Row>(`/api/dispensary/desk-sales/${row.id}/resolve`, { method: 'POST', body: {}, grant, idempotencyKey: newIdempotencyKey() });
    setBusy(null);
    if (!r.ok) { setError(r.body.error ?? t.failed); await load(); return; }
    setNote(r.body.status === 'POSTED' ? t.done : t.stillShort);
    await load();
  };

  const status = (r: Row) => {
    switch (r.state) {
      case 'TAKEN': return <Badge tone="ok" icon="●">{t.posted}</Badge>;
      case 'PART_RETURNED': return <Badge tone="ok" icon="◐">{t.partReturned(r.returnedBase)}</Badge>;
      case 'RETURNED': return <Badge tone="neutral" icon="↩">{t.returnedAll}</Badge>;
      case 'SHORT': return <Badge tone="warn" icon="⚠">{t.short} {r.shortBase}</Badge>;
      case 'CANCELLED': return <Badge tone="neutral" icon="○">{t.cancelled}</Badge>;
      default: return <Badge tone="bad" icon="✕">{t.rejected}</Badge>;
    }
  };

  const lines = bills.flatMap((b) => b.lines);
  const taken = lines.filter((r) => r.status === 'POSTED').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-small text-ink">
          <input type="checkbox" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} />
          {t.showFlagged}
        </label>
        <span className="flex items-center gap-3">
          {updatedAt && <span className="text-micro text-muted" role="status">{t.updated(clock(updatedAt))}</span>}
          <Button size="sm" onClick={() => void load()}>{t.refresh}</Button>
        </span>
      </div>
      {flagged && <p className="text-small text-muted">{t.flaggedHint}</p>}
      {lines.length > 0 && !flagged && <p className="text-small text-muted">{t.summary(taken, lines.length, bills.length)}</p>}
      {error && <p role="alert" className="text-small text-bad">{error}</p>}
      {note && <p role="status" className="text-small text-muted">{note}</p>}
      {bills.length === 0 && <div className="card px-5 py-10 text-center text-small text-muted">{flagged ? t.emptyFlagged : t.emptyAll}</div>}
      {bills.map((b) => { const party = deskBillParty(b); return (
        <section key={b.billId} className="card overflow-hidden" aria-label={`${t.bill} ${b.billSerial}`}>
          <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-hairline px-4 py-3">
            <span>
              <span className="block tnum font-semibold text-ink">{b.billSerial}</span>
              <span className="block text-micro text-muted">{when(b.issuedAt)} · {t.lines(b.lines.length)}</span>
            </span>
            <span className="text-small text-ink">
              {party.patient && <span className="block"><span className="text-muted">{t.patient}: </span>{party.patient}</span>}
              {party.doctor && <span className="block"><span className="text-muted">{t.doctor}: </span>{party.doctor}</span>}
              {party.note && <span className="block text-micro text-muted">{party.note === 'hidden' ? t.patientHidden : t.noParty}</span>}
            </span>
          </header>
          <DataList rows={b.lines} rowKey={(r) => r.id} empty={t.emptyAll} columns={[
            { key: 'item', header: t.item, primary: true, cell: (r) => (
              <span>
                <span className="block font-semibold text-ink">{r.itemName ?? t.unknownItem}</span>
                {r.reason && <span className="block text-micro text-muted">{reasonText(r.reason)}</span>}
                {r.credits.map((c, i) => (
                  <span key={i} className="block text-micro text-muted">
                    {c.returnedBase > 0 ? t.creditBack(c.serial, c.returnedBase) : t.creditNothing(c.serial)}
                    {c.reason && c.reason !== 'not_posted' ? ` (${reasonText(c.reason)})` : ''}
                  </span>))}
                {r.rxFlags && r.rxFlags.length > 0 && (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {r.rxFlags.map((f) => <Badge key={f} tone="warn" icon="⚑">{flagText(f)}</Badge>)}
                  </span>)}
              </span>) },
            { key: 'qty', header: t.qty, align: 'right', cell: (r) => (
              <span className="block text-right"><span className="block tnum">{r.qtyBase} {r.baseUnit ? unitName(r.baseUnit) : ''}</span>
                {r.returnedBase > 0 && <span className="block text-micro text-muted">{t.returned} {r.returnedBase}</span>}</span>) },
            { key: 'batch', header: t.batch, cell: (r) => <span className="text-small text-muted">{r.batches ?? '—'}</span> },
            { key: 'status', header: t.status, cell: status },
            { key: 'received', header: t.received, phoneHidden: true, cell: (r) => <span className="text-small text-muted">{when(r.receivedAt)}</span> },
            { key: 'action', header: '', align: 'right', cell: (r) => (canResolve && (r.status === 'SHORT' || r.status === 'REJECTED') && r.itemId
              ? <Button size="sm" busy={busy === r.id} onClick={() => void retry(r)}>{t.retry}</Button> : null) },
          ]} />
        </section>
      ); })}
      {dialog}
    </div>
  );
}
