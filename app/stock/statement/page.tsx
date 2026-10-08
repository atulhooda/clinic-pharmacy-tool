import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import PageHeader from '@/components/ui/PageHeader';
import { StatementPanel } from '@/components/stock/StatementPanel';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { session } = await pageSession({ permission: 'stock.view' });
  if (!session) redirect('/');
  return (
    <div>
      <PageHeader eyebrow="Stock" title={en.statement.title} subtitle={en.statement.subtitle} />
      <div className="mt-6"><StatementPanel /></div>
    </div>
  );
}
