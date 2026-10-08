'use client';

import { useCallback, useEffect, useState } from 'react';
import Button from '@/components/ui/Button';
import DataList from '@/components/ui/DataList';
import { TextField } from '@/components/ui/Field';
import { en } from '@/lib/i18n/en';
import { api } from './client';

const t = en.settings;
type Row = { id: string; at: string; actorLabel: string; actorRole: string; action: string; detail: Record<string, unknown> };
const ist = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

/** M-12: the audit log, newest first, with an action filter and keyset paging. */
export function AuditPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [action, setAction] = useState('');
  const load = useCallback(async (cursor: string | null, filter: string) => {
    const q = new URLSearchParams({ limit: '50' });
    if (filter) q.set('action', filter);
    if (cursor) q.set('cursor', cursor);
    const r = await api<{ items: Row[]; nextCursor: string | null }>(`/api/audit?${q}`);
    if (!r.ok) return;
    setRows((prev) => (cursor ? [...prev, ...r.body.items] : r.body.items));
    setNext(r.body.nextCursor);
  }, []);
  useEffect(() => { void load(null, ''); }, [load]);

  return (
    <div className="space-y-4">
      <form onSubmit={(e) => { e.preventDefault(); void load(null, action.trim()); }} className="flex items-end gap-2">
        <TextField label={t.filterAction} value={action} onChange={(e) => setAction(e.target.value)} className="flex-1" />
        <Button type="submit">→</Button>
      </form>
      <DataList rows={rows} rowKey={(r) => r.id} empty={t.none} columns={[
        { key: 'at', header: t.when, cell: (r) => <span className="tnum">{ist(r.at)}</span>, primary: true },
        { key: 'who', header: t.who, cell: (r) => `${r.actorLabel} (${r.actorRole})` },
        { key: 'what', header: t.what, cell: (r) => <span className="font-mono">{r.action}</span> },
        { key: 'detail', header: t.details, cell: (r) => <span className="font-mono text-micro">{JSON.stringify(r.detail)}</span>, phoneHidden: true },
      ]} />
      {next && <Button onClick={() => load(next, action.trim())}>{t.more}</Button>}
    </div>
  );
}
