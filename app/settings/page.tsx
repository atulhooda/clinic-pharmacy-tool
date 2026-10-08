import Link from 'next/link';
import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import type { Permission } from '@/lib/auth/permissions';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';
const t = en.settings;

const SECTIONS: { href: string; label: string; permission: Permission | null }[] = [
  { href: '/settings/organisation', label: t.organisation, permission: 'org.settings' },
  { href: '/settings/premises', label: t.premises, permission: null },
  { href: '/settings/staff', label: t.staff, permission: 'staff.manage' },
  { href: '/settings/roles', label: t.roles, permission: 'roles.manage' },
  { href: '/settings/devices', label: t.devices, permission: 'devices.manage' },
  { href: '/settings/audit', label: t.audit, permission: 'audit.view' },
];

export default async function SettingsHome() {
  const { session } = await pageSession();
  if (!session) redirect('/');
  const visible = SECTIONS.filter((s) => !s.permission || session.permissions.has(s.permission));
  return (
    <div className="card p-6">
      <h1 className="text-h1 mb-4">{t.title}</h1>
      <ul className="grid gap-2 sm:grid-cols-2">
        {visible.map((s) => (
          <li key={s.href}><Link href={s.href} className="block rounded-xl2 border border-hairline-firm px-4 py-3 font-semibold hover:border-brand">{s.label}</Link></li>
        ))}
      </ul>
    </div>
  );
}
