import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { ItemsPanel } from '@/components/stock/ItemsPanel';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { session } = await pageSession({ permission: 'stock.view' });
  if (!session) redirect('/');
  return (
    <div className="card p-6">
      <h1 className="text-h2 mb-4">{en.stock.items}</h1>
      <ItemsPanel canEdit={session.permissions.has('stock.items')} />
    </div>
  );
}
