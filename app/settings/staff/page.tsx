import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { StaffPanel } from '@/components/settings/StaffPanel';
import PageHeader from '@/components/ui/PageHeader';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { session } = await pageSession({ permission: 'staff.manage' });
  if (!session) redirect('/settings');
  return (
    <div>
      <PageHeader eyebrow="Settings" title="Staff" subtitle="Each person signs in with their own login. A new person gets a one-time password, shown once." />
      <div className="mt-6">
        <StaffPanel orgId={session.orgId} isOwner={session.isOwner} premises={session.premises} />
      </div>
    </div>
  );
}
