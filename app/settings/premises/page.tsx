import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { PremisesPanel } from '@/components/settings/PremisesPanel';
import PageHeader from '@/components/ui/PageHeader';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { session } = await pageSession();
  if (!session) redirect('/settings');
  return (
    <div>
      <PageHeader eyebrow="Settings" title="Premises" subtitle="Your branches. Legal settings (mode, licences, registers) live under Dispensary." />
      <div className="mt-6">
        <PremisesPanel orgId={session.orgId} canEdit={session.permissions.has('org.settings')} />
      </div>
    </div>
  );
}
