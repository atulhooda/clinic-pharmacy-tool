import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { PremisesPanel } from '@/components/settings/PremisesPanel';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { session } = await pageSession();
  if (!session) redirect('/settings');
  return (
    <div className="card p-6">
      <h1 className="text-h2 mb-4">{en.settings.premises}</h1>
      <PremisesPanel orgId={session.orgId} canEdit={session.permissions.has('org.settings')} />
    </div>
  );
}
