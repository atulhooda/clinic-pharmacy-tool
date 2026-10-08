import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import PageHeader from '@/components/ui/PageHeader';
import { SuppliersPanel } from '@/components/stock/SuppliersPanel';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { session } = await pageSession({ permission: 'stock.view' });
  if (!session) redirect('/');
  return (
    <div>
      <PageHeader eyebrow="Stock" title="Suppliers" subtitle="Who you buy from, and whether their drug licence is in date today." />
      <div className="mt-6">
        <SuppliersPanel canEdit={session.permissions.has('stock.items')} />
      </div>
    </div>
  );
}
