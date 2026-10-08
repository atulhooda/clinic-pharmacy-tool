import Link from 'next/link';
import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import type { Permission } from '@/lib/auth/permissions';
import PageHeader from '@/components/ui/PageHeader';
import MonoLabel from '@/components/ui/MonoLabel';
import { IconArrowRight } from '@/components/ui/icons';

export const dynamic = 'force-dynamic';

const SECTIONS: { href: string; label: string; body: string; permission: Permission | null }[] = [
  { href: '/settings/organisation', label: 'Organisation', body: 'When shared PCs lock, when the day resets, idle sign-out.', permission: 'org.settings' },
  { href: '/settings/premises', label: 'Premises', body: 'Your branches: address, state, GSTIN.', permission: null },
  { href: '/settings/staff', label: 'Staff', body: 'People, their role and premises, resets.', permission: 'staff.manage' },
  { href: '/settings/roles', label: 'Roles and permissions', body: 'Custom roles and what each role may do.', permission: 'roles.manage' },
  { href: '/settings/devices', label: 'Trusted PCs', body: 'Front-desk PCs that switch between people with a PIN.', permission: 'devices.manage' },
  { href: '/settings/audit', label: 'Audit log', body: 'Who did what, and when.', permission: 'audit.view' },
  { href: '/account', label: 'My account', body: 'Your password, PINs, and signing out everywhere.', permission: null },
];

export default async function SettingsHome() {
  const { session } = await pageSession();
  if (!session) redirect('/');
  const visible = SECTIONS.filter((s) => !s.permission || session.permissions.has(s.permission));
  return (
    <div>
      <PageHeader eyebrow="Settings" title="Settings" subtitle={`${session.orgName}: how the pharmacy is set up, and who can do what.`} />
      <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((s) => (
          <li key={s.href}>
            <Link href={s.href} className="card group flex h-full flex-col p-5 transition-shadow hover:shadow-brutal-sm">
              <MonoLabel>{s.label}</MonoLabel>
              <span className="mt-2 flex-1 text-small text-muted">{s.body}</span>
              <IconArrowRight className="mt-4 h-4 w-4 text-faint transition-colors group-hover:text-brand" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
