import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { RolesPanel } from '@/components/settings/RolesPanel';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { session } = await pageSession({ permission: 'roles.manage' });
  if (!session) redirect('/settings');
  return (
    <div className="card p-6">
      <h1 className="text-h2 mb-4">{en.settings.roles}</h1>
      <RolesPanel orgId={session.orgId} catalogue={Object.entries(PERMISSIONS).map(([key, d]) => ({ key, pinGated: d.pinGated }))} />
    </div>
  );
}
