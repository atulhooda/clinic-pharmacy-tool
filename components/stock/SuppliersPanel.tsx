'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import DataList from '@/components/ui/DataList';
import Sheet from '@/components/ui/Sheet';
import { TextField } from '@/components/ui/Field';
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

  return (
    <div className="space-y-4">
      {canEdit && <Button variant="brutal" onClick={() => open('new')}>{t.addSupplier}</Button>}
      <DataList rows={rows} rowKey={(s) => s.id} empty={en.settings.none} onRowClick={canEdit ? open : undefined} columns={[
        { key: 'name', header: t.displayName, cell: (s) => s.name, primary: true },
        { key: 'gstin', header: t.gstin, cell: (s) => s.gstin ?? '—', phoneHidden: true },
        { key: 'lic', header: t.licenceStatus, cell: (s) => <Badge tone={TONE[s.licenceStatus] ?? 'neutral'}>{s.licenceStatus}</Badge> },
      ]} />
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
