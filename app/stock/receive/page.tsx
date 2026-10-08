import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import PageHeader from '@/components/ui/PageHeader';
import { ReceivePanel } from '@/components/stock/ReceivePanel';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { session } = await pageSession({ permission: 'stock.view' });
  if (!session) redirect('/');
  return (
    <div>
      <PageHeader eyebrow="Stock" title={en.receive.title} subtitle={en.receive.subtitle} />
      <div className="mt-6"><ReceivePanel canEdit={session.permissions.has('stock.receive')} /></div>
    </div>
  );
}
