import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { StaffPanel } from '@/components/settings/StaffPanel';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { session } = await pageSession({ permission: 'staff.manage' });
  if (!session) redirect('/settings');
  return (
    <div className="card p-6">
      <h1 className="text-h2 mb-4">{en.settings.staff}</h1>
      <StaffPanel orgId={session.orgId} isOwner={session.isOwner} premises={session.premises} />
    </div>
  );
}
