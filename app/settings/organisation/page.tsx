import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { OrgSettingsForm } from '@/components/settings/OrgSettingsForm';
import PageHeader from '@/components/ui/PageHeader';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { session } = await pageSession({ permission: 'org.settings' });
  if (!session) redirect('/settings');
  return (
    <div>
      <PageHeader eyebrow="Settings" title="Organisation" subtitle="When shared PCs lock, when the working day resets, and idle sign-out for other browsers." />
      <div className="card mt-6 max-w-xl p-6">
        <OrgSettingsForm orgId={session.orgId} />
      </div>
    </div>
  );
}
