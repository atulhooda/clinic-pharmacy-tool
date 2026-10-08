'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import DataList from '@/components/ui/DataList';
import Sheet from '@/components/ui/Sheet';
import { TextField } from '@/components/ui/Field';
import FilterPills from '@/components/ui/FilterPills';
import SearchField from '@/components/ui/SearchField';
import { IconPlus } from '@/components/ui/icons';
import { en } from '@/lib/i18n/en';
import { api } from '@/components/settings/client';

const t = en.stock;
type Supplier = { id: string; name: string; gstin: string | null; drugLicenceNumbers: string[]; licenceValidTill: string | null; licenceStatus: string;
  address: string | null; contactName: string | null; contactPhone: string | null; contactEmail: string | null; active: boolean };
const blank = { name: '', gstin: '', licences: '', till: '', address: '', contactName: '', contactPhone: '', contactEmail: '' };
const TONE: Record<string, 'ok' | 'bad' | 'neutral'> = { VALID: 'ok', EXPIRED: 'bad', MISSING: 'bad', VALIDITY_UNKNOWN: 'neutral' };

/** E-20 / E-21: suppliers and their licence status (derived as of today, IST). */
export function SuppliersPanel({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<Supplier[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string>('ALL');
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { const r = await api<{ items: Supplier[] }>('/api/dispensary/suppliers'); if (r.ok) setRows(r.body.items); }, []);
  useEffect(() => { void load(); }, [load]);

  function open(s: Supplier | 'new') {
    setError(null);
    setEditing(s);
    setForm(s === 'new' ? blank : { name: s.name, gstin: s.gstin ?? '', licences: s.drugLicenceNumbers.join(', '), till: s.licenceValidTill ?? '',
      address: s.address ?? '', contactName: s.contactName ?? '', contactPhone: s.contactPhone ?? '', contactEmail: s.contactEmail ?? '' });
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    const body = { name: form.name, gstin: form.gstin || null, drugLicenceNumbers: form.licences.split(',').map((x) => x.trim()).filter(Boolean),
      licenceValidTill: form.till || null, address: form.address || null, contactName: form.contactName || null,
      contactPhone: form.contactPhone || null, contactEmail: form.contactEmail || null };
    const r = editing === 'new' ? await api('/api/dispensary/suppliers', { body })
      : await api(`/api/dispensary/suppliers/${(editing as Supplier).id}`, { method: 'PATCH', body });
    if (!r.ok) return setError(r.body.error ?? en.settings.failed);
    setEditing(null);
    await load();
  }
  const field = (k: keyof typeof blank, label: string, extra: Record<string, unknown> = {}) =>
    <TextField label={label} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} {...extra} />;

  const needle = q.trim().toLowerCase();
  const shown = rows.filter((s) => (status === 'ALL' || s.licenceStatus === status) && (!needle || s.name.toLowerCase().includes(needle)));
  const LABEL: Record<string, string> = { VALID: 'Valid', EXPIRED: 'Expired', MISSING: 'No licence', VALIDITY_UNKNOWN: 'No expiry date' };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SearchField value={q} onChange={setQ} placeholder="Search suppliers…" className="w-full md:w-80" />
        <FilterPills value={status} onChange={setStatus} options={[
          { key: 'ALL', label: 'All', count: rows.length },
          ...['VALID', 'EXPIRED', 'MISSING', 'VALIDITY_UNKNOWN'].map((k) => ({ key: k, label: LABEL[k], count: rows.filter((r) => r.licenceStatus === k).length })),
        ]} />
        {canEdit && <Button variant="brutal-blue" className="md:ml-auto" onClick={() => open('new')}><IconPlus className="h-4 w-4" /> {t.addSupplier}</Button>}
      </div>
      <div className="card overflow-hidden">
        <DataList rows={shown} rowKey={(s) => s.id} empty={rows.length ? 'No supplier matches.' : 'No suppliers yet.'} onRowClick={canEdit ? open : undefined} columns={[
          { key: 'name', header: 'Supplier', primary: true, cell: (s) => (
            <span><span className="block font-semibold text-ink">{s.name}</span><span className="block text-micro text-muted">{s.drugLicenceNumbers.join(' · ') || 'no licence number'}</span></span>) },
          { key: 'gstin', header: t.gstin, phoneHidden: true, cell: (s) => <span className="font-mono text-small">{s.gstin ?? '—'}</span> },
          { key: 'lic', header: t.licenceStatus, cell: (s) => <Badge tone={TONE[s.licenceStatus] ?? 'neutral'}>● {LABEL[s.licenceStatus] ?? s.licenceStatus}</Badge> },
          { key: 'till', header: 'Valid till', align: 'right', phoneHidden: true, cell: (s) => <span className="tnum">{s.licenceValidTill ?? '—'}</span> },
        ]} />
      </div>
      <Sheet open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} title={editing === 'new' ? t.addSupplier : en.settings.edit}>
        <form onSubmit={save} className="space-y-3" noValidate>
          {field('name', t.displayName, { maxLength: 120 })}
          {field('gstin', t.gstin, { maxLength: 15 })}
          {field('licences', t.licences)}
          {field('till', t.validTill, { type: 'date' })}
          {field('address', t.address)}
          {field('contactName', t.contactName)}
          {field('contactPhone', t.contactPhone, { type: 'tel', placeholder: '+91…' })}
          {field('contactEmail', t.contactEmail, { type: 'email' })}
          {error && <p role="alert" className="text-small text-bad">{error}</p>}
          <Button type="submit" variant="brutal">{en.settings.save}</Button>
        </form>
      </Sheet>
    </div>
  );
}
