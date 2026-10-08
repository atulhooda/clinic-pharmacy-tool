import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { OrgSettingsForm } from '@/components/settings/OrgSettingsForm';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { session } = await pageSession({ permission: 'org.settings' });
  if (!session) redirect('/settings');
  return (
    <div className="card p-6">
      <h1 className="text-h2 mb-4">{en.settings.organisation}</h1>
      <OrgSettingsForm orgId={session.orgId} />
    </div>
  );
}
