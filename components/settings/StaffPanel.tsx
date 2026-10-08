'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Button from '@/components/ui/Button';
import { IconPlus } from '@/components/ui/icons';
import DataList from '@/components/ui/DataList';
import Sheet from '@/components/ui/Sheet';
import StatusPill from '@/components/ui/StatusPill';
import { TextField, SelectField } from '@/components/ui/Field';
import { en } from '@/lib/i18n/en';
import { api } from './client';
import { useGrant } from './useGrant';

const t = en.settings;
type Staff = { id: string; name: string; login: string; role: string; phone: string | null; active: boolean; premisesIds: string[]; openSessions: number };
type Role = { key: string; name: string };
type Premises = { id: string; name: string };

/** M-05 … M-08: people, their role and premises; create and reset show a one-time password once. */
export function StaffPanel({ orgId, isOwner, premises }: { orgId: string; isOwner: boolean; premises: Premises[] }) {
  const [rows, setRows] = useState<Staff[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [editing, setEditing] = useState<Staff | 'new' | null>(null);
  const [form, setForm] = useState({ name: '', login: '', role: 'reception', phone: '', premisesIds: [] as string[] });
  const [otp, setOtp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { withGrant, dialog } = useGrant();
  const load = useCallback(async () => {
    const [s, r] = await Promise.all([api<{ items: Staff[] }>('/api/staff'), api<{ items: Role[] }>('/api/roles')]);
    if (s.ok) setRows(s.body.items);
    if (r.ok) setRoles(r.body.items);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const roleOptions = roles.length ? roles : [{ key: 'owner', name: 'Owner' }, { key: 'doctor', name: 'Doctor' }, { key: 'reception', name: 'Reception' }];

  function open(s: Staff | 'new') {
    setError(null);
    setOtp(null);
    setEditing(s);
    setForm(s === 'new' ? { name: '', login: '', role: 'reception', phone: '', premisesIds: premises.slice(0, 1).map((p) => p.id) }
      : { name: s.name, login: s.login, role: s.role, phone: s.phone ?? '', premisesIds: s.premisesIds });
  }
  const explain = (code?: string, fallback?: string) => (code === 'last_owner' ? t.lastOwner : fallback ?? t.failed);

  async function save(e: FormEvent) {
    e.preventDefault();
    const isNew = editing === 'new';
    const grant = await withGrant('staff.manage', isNew ? orgId : (editing as Staff).id);
    if (!grant) return;
    const common = { name: form.name, role: form.role, premisesIds: form.premisesIds, phone: form.phone || null };
    const r = isNew
      ? await api<{ oneTimePassword: string }>('/api/staff', { body: { ...common, login: form.login }, grant })
      : await api(`/api/staff/${(editing as Staff).id}`, { method: 'PATCH', body: common, grant });
    if (!r.ok) return setError(explain(r.body.code, r.body.error));
    await load();
    if (isNew) setOtp((r.body as { oneTimePassword: string }).oneTimePassword); else setEditing(null);
  }
  async function act(kind: 'reset' | 'sessions' | 'active') {
    const s = editing as Staff;
    if (kind === 'reset' && !window.confirm(t.confirmReset)) return;
    const grant = kind === 'sessions' ? null : await withGrant('staff.manage', s.id);
    if (kind !== 'sessions' && !grant) return;
    const r = kind === 'reset' ? await api<{ oneTimePassword: string }>(`/api/staff/${s.id}/reset`, { body: {}, grant })
      : kind === 'sessions' ? await api(`/api/staff/${s.id}/sessions/revoke`, { body: {} })
      : await api(`/api/staff/${s.id}`, { method: 'PATCH', body: { active: !s.active }, grant });
    if (!r.ok) return setError(explain(r.body.code, r.body.error));
    await load();
    if (kind === 'reset') setOtp((r.body as { oneTimePassword: string }).oneTimePassword); else setEditing(null);
  }

  return (
    <div className="space-y-4">
      <Button variant="brutal-blue" onClick={() => open('new')}><IconPlus className="h-4 w-4" /> {t.addStaff}</Button>
      <div className="card overflow-hidden">
      <DataList rows={rows} rowKey={(s) => s.id} empty={t.none} onRowClick={open} columns={[
        { key: 'name', header: t.name, cell: (s) => s.name, primary: true },
        { key: 'login', header: t.login, cell: (s) => <span className="font-mono">{s.login}</span> },
        { key: 'role', header: t.role, cell: (s) => s.role },
        { key: 'active', header: t.active, cell: (s) => <StatusPill status={s.active ? 'active' : 'inactive'} /> },
      ]} />
      </div>
      <Sheet open={editing !== null} onOpenChange={(o) => { if (!o) { setEditing(null); setOtp(null); } }} title={editing === 'new' ? t.addStaff : t.edit}>
        {otp ? (
          <div className="space-y-3">
            <p className="text-small">{t.oneTimePassword}</p>
            <p className="rounded-xl2 bg-surface-raise px-3 py-2 font-mono text-h3 tracking-wider">{otp}</p>
            <Button variant="brutal" onClick={() => { setEditing(null); setOtp(null); }}>{t.cancel}</Button>
          </div>
        ) : (
          <form onSubmit={save} className="space-y-4" noValidate>
            <TextField label={t.name} value={form.name} maxLength={64} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            {editing === 'new' && <TextField label={t.login} value={form.login} maxLength={32} autoCapitalize="none"
              onChange={(e) => setForm({ ...form, login: e.target.value.toLowerCase() })} />}
            <SelectField label={t.role} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {roleOptions.filter((r) => isOwner || r.key !== 'owner' || form.role === 'owner').map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
            </SelectField>
            <TextField label={t.phone} type="tel" value={form.phone} placeholder="+91…" onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <fieldset className="space-y-1">
              <legend className="text-small font-medium text-ink-soft">{t.memberships}</legend>
              {premises.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-small">
                  <input type="checkbox" checked={form.premisesIds.includes(p.id)} onChange={(e) => setForm({ ...form,
                    premisesIds: e.target.checked ? [...form.premisesIds, p.id] : form.premisesIds.filter((x) => x !== p.id) })} /> {p.name}
                </label>
              ))}
            </fieldset>
            {error && <p role="alert" className="text-small text-bad">{error}</p>}
            <Button type="submit" variant="brutal">{t.save}</Button>
            {editing !== 'new' && editing && (
              <div className="flex flex-wrap gap-2 border-t border-hairline pt-4">
                <Button onClick={() => act('reset')}>{t.reset}</Button>
                <Button onClick={() => act('sessions')}>{t.endSessions}</Button>
                <Button variant="danger" onClick={() => act('active')}>{editing.active ? t.deactivate : t.reactivate}</Button>
              </div>
            )}
          </form>
        )}
      </Sheet>
      {dialog}
    </div>
  );
}
