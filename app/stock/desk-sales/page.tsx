import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import PageHeader from '@/components/ui/PageHeader';
import { DeskSalesPanel } from '@/components/stock/DeskSalesPanel';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

/** D-57: the desk's sale lines that did not take their stock, for a person to fix and retry. */
export default async function Page() {
  const { session } = await pageSession({ permission: 'stock.view' });
  if (!session) redirect('/');
  return (
    <div>
      <PageHeader eyebrow="Stock" title={en.deskSales.title} subtitle={en.deskSales.subtitle} />
      <div className="mt-6"><DeskSalesPanel canResolve={session.permissions.has('stock.adjust')} /></div>
    </div>
  );
}
