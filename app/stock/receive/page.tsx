import { redirect } from 'next/navigation';
import Link from 'next/link';
import { pageSession } from '@/lib/auth/page-session';
import PageHeader from '@/components/ui/PageHeader';
import { ReceivePanel } from '@/components/stock/ReceivePanel';
import { SuppliersPanel } from '@/components/stock/SuppliersPanel';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

const TABS = [{ key: 'deliveries', label: en.receive.tabDeliveries }, { key: 'suppliers', label: en.receive.tabSuppliers }] as const;

/** Receiving and the suppliers deliveries come from, in one place: `?tab=suppliers` shows the suppliers. */
export default async function Page({ searchParams }: { searchParams: { tab?: string } }) {
  const { session } = await pageSession({ permission: 'stock.view' });
  if (!session) redirect('/');
  const tab = searchParams.tab === 'suppliers' ? 'suppliers' : 'deliveries';
  return (
    <div>
      <PageHeader eyebrow="Stock" title={en.receive.title} subtitle={tab === 'suppliers' ? en.receive.suppliersSubtitle : en.receive.subtitle} />
      <div className="mt-4 flex flex-wrap gap-2" role="tablist">
        {TABS.map((t) => {
          const on = t.key === tab;
          return (
            <Link key={t.key} href={t.key === 'deliveries' ? '/stock/receive' : '/stock/receive?tab=suppliers'} role="tab" aria-selected={on}
              className={`inline-flex min-h-[40px] items-center rounded-full border px-4 text-small font-semibold transition-colors ${
                on ? 'border-ink bg-ink text-white' : 'border-hairline-firm bg-surface text-ink-soft hover:border-ink'}`}>
              {t.label}
            </Link>
          );
        })}
      </div>
      <div className="mt-6">
        {tab === 'suppliers'
          ? <SuppliersPanel canEdit={session.permissions.has('stock.items')} />
          : <ReceivePanel canEdit={session.permissions.has('stock.receive')} />}
      </div>
    </div>
  );
}
