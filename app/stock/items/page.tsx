import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import PageHeader from '@/components/ui/PageHeader';
import { ItemsPanel } from '@/components/stock/ItemsPanel';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { session } = await pageSession({ permission: 'stock.view' });
  if (!session) redirect('/');
  return (
    <div>
      <PageHeader eyebrow="Stock" title="Items" subtitle="Everything you stock, from the medicine list or your own. Pack sizes are fixed once added." />
      <div className="mt-6">
        <ItemsPanel canEdit={session.permissions.has('stock.items')} canAdjust={session.permissions.has('stock.adjust')} />
      </div>
    </div>
  );
}
