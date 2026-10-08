'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Button from '@/components/ui/Button';
import DataList from '@/components/ui/DataList';
import Sheet from '@/components/ui/Sheet';
import StatusPill from '@/components/ui/StatusPill';
import { TextField } from '@/components/ui/Field';
import { en } from '@/lib/i18n/en';
import { api } from './client';
import { useGrant } from './useGrant';

const t = en.settings;
type P = { id: string; name: string; address: string; stateCode: string; gstin: string | null; legalName: string | null; active: boolean };
const blank = { name: '', address: '', stateCode: '', gstin: '', legalName: '', active: true };

/** M-02 … M-04: premises; creating and editing are signed with an `org.settings` grant. */
export function PremisesPanel({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const [rows, setRows] = useState<P[]>([]);
  const [editing, setEditing] = useState<P | 'new' | null>(null);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const { withGrant, dialog } = useGrant();
  const load = useCallback(async () => { const r = await api<{ items: P[] }>('/api/premises'); if (r.ok) setRows(r.body.items); }, []);
  useEffect(() => { void load(); }, [load]);

  function open(p: P | 'new') {
    setError(null);
    setEditing(p);
    setForm(p === 'new' ? blank : { ...p, gstin: p.gstin ?? '', legalName: p.legalName ?? '' });
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    const grant = await withGrant('org.settings', orgId);
    if (!grant) return;
    const body = { name: form.name, address: form.address, stateCode: form.stateCode, gstin: form.gstin || null, legalName: form.legalName || null };
    const r = editing === 'new'
      ? await api('/api/premises', { body, grant })
      : await api(`/api/premises/${(editing as P).id}`, { method: 'PATCH', body: { ...body, active: form.active }, grant });
    if (r.ok) { setEditing(null); await load(); } else setError(r.body.error ?? t.failed);
  }

  return (
    <div className="space-y-4">
      {canEdit && <Button variant="brutal" onClick={() => open('new')}>{t.addPremises}</Button>}
      <DataList rows={rows} rowKey={(p) => p.id} empty={t.none} onRowClick={canEdit ? open : undefined} columns={[
        { key: 'name', header: t.name, cell: (p) => p.name, primary: true },
        { key: 'state', header: t.stateCode, cell: (p) => p.stateCode },
        { key: 'gstin', header: t.gstin, cell: (p) => p.gstin ?? '—', phoneHidden: true },
        { key: 'active', header: t.active, cell: (p) => <StatusPill status={p.active ? 'active' : 'inactive'} /> },
      ]} />
      <Sheet open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} title={editing === 'new' ? t.addPremises : t.edit}>
        <form onSubmit={save} className="space-y-4" noValidate>
          <TextField label={t.name} value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <TextField label={t.address} value={form.address} maxLength={500} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          <TextField label={t.stateCode} inputMode="numeric" maxLength={2} value={form.stateCode} onChange={(e) => setForm({ ...form, stateCode: e.target.value.replace(/\D/g, '') })} />
          <TextField label={t.gstin} maxLength={15} value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} />
          <TextField label={t.legalName} maxLength={200} value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} />
          {editing !== 'new' && (
            <label className="flex items-center gap-2 text-small">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> {t.active}
            </label>
          )}
          {error && <p role="alert" className="text-small text-bad">{error}</p>}
          <Button type="submit" variant="brutal">{t.save}</Button>
        </form>
      </Sheet>
      {dialog}
    </div>
  );
}
