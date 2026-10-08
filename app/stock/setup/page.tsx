import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import PageHeader from '@/components/ui/PageHeader';
import { SetupPanel } from '@/components/stock/SetupPanel';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { session } = await pageSession({ permission: 'stock.view' });
  if (!session) redirect('/');
  return (
    <div>
      <PageHeader eyebrow="Dispensary" title="Setup" subtitle="The dispensary's settings, and each premises' dispensing mode, licences and register fields." />
      <div className="mt-6">
        <SetupPanel canEdit={session.permissions.has('stock.settings')} />
      </div>
    </div>
  );
}
