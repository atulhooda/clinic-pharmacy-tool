import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { RolesPanel } from '@/components/settings/RolesPanel';
import { PERMISSIONS } from '@/lib/auth/permissions';
import PageHeader from '@/components/ui/PageHeader';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { session } = await pageSession({ permission: 'roles.manage' });
  if (!session) redirect('/settings');
  return (
    <div>
      <PageHeader eyebrow="Settings" title="Roles and permissions" subtitle="Built-in roles keep their defaults; overrides and custom roles are yours. Every change is audited." />
      <div className="mt-6">
        <RolesPanel orgId={session.orgId} catalogue={Object.entries(PERMISSIONS).map(([key, d]) => ({ key, pinGated: d.pinGated }))} />
      </div>
    </div>
  );
}
