'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import Sheet from '@/components/ui/Sheet';
import { TextField } from '@/components/ui/Field';
import { en } from '@/lib/i18n/en';
import { api } from './client';
import { useGrant } from './useGrant';

const t = en.settings;
type Role = { key: string; name: string; builtin: boolean; members: number; permissions: string[] };

/** M-09: roles and their permissions. Changes are signed with a `roles.manage` grant and audited. */
export function RolesPanel({ orgId, catalogue }: { orgId: string; catalogue: { key: string; pinGated: boolean }[] }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [perms, setPerms] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const { withGrant, dialog } = useGrant();
  const load = useCallback(async () => { const r = await api<{ items: Role[] }>('/api/roles'); if (r.ok) setRoles(r.body.items); }, []);
  useEffect(() => { void load(); }, [load]);

  function open(r: Role | 'new') {
    setError(null);
    setEditing(r);
    setName(r === 'new' ? '' : r.name);
    setKey('');
    setPerms(new Set(r === 'new' ? [] : r.permissions));
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    const grant = await withGrant('roles.manage', orgId);
    if (!grant) return;
    let r;
    if (editing === 'new') {
      r = await api('/api/roles', { body: { key, name, grants: Object.fromEntries([...perms].map((p) => [p, true])) }, grant });
    } else {
      const role = editing as Role;
      const grants = Object.fromEntries(catalogue.map((c) => [c.key, perms.has(c.key)]).filter(([k, v]) => role.permissions.includes(k as string) !== v));
      r = await api(`/api/roles/${role.key}`, { method: 'PATCH', body: { ...(role.builtin ? {} : { name }), grants }, grant });
    }
    if (r.ok) { setEditing(null); await load(); }
    else setError(r.body.code === 'OWNER_GRANT_LOCKED' ? t.ownerLocked : r.body.error ?? t.failed);
  }

  return (
    <div className="space-y-4">
      <Button variant="brutal" onClick={() => open('new')}>{t.addRole}</Button>
      <ul className="divide-y divide-hairline rounded-xl2 border border-hairline bg-surface">
        {roles.map((r) => (
          <li key={r.key}>
            <button type="button" onClick={() => open(r)} className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-surface-raise/50">
              <span><span className="font-semibold">{r.name}</span> <span className="font-mono text-micro text-muted">{r.key}</span>
                {r.builtin && <Badge tone="neutral" className="ml-2">{t.builtin}</Badge>}</span>
              <span className="text-micro text-muted">{r.members} {t.members} · {r.permissions.length}</span>
            </button>
          </li>
        ))}
      </ul>
      <Sheet open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} title={editing === 'new' ? t.addRole : (editing as Role | null)?.name ?? ''} wide>
        <form onSubmit={save} className="space-y-4" noValidate>
          {editing === 'new' && <TextField label={t.roleKey} value={key} maxLength={32} onChange={(e) => setKey(e.target.value.toLowerCase())} />}
          {(editing === 'new' || (editing && !editing.builtin)) && <TextField label={t.name} value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />}
          <fieldset className="grid gap-1 sm:grid-cols-2">
            {catalogue.map((c) => (
              <label key={c.key} className="flex items-center gap-2 text-small">
                <input type="checkbox" checked={perms.has(c.key)}
                  onChange={(e) => { const n = new Set(perms); if (e.target.checked) n.add(c.key); else n.delete(c.key); setPerms(n); }} />
                <span className="font-mono">{c.key}</span>{c.pinGated && <span className="text-micro text-muted">PIN</span>}
              </label>
            ))}
          </fieldset>
          {error && <p role="alert" className="text-small text-bad">{error}</p>}
          <Button type="submit" variant="brutal">{t.save}</Button>
        </form>
      </Sheet>
      {dialog}
    </div>
  );
}
