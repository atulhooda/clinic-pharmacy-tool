import { notFound, redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import PageHeader from '@/components/ui/PageHeader';
import { GrnEditor } from '@/components/stock/GrnEditor';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: { id: string } }) {
  const { session } = await pageSession({ permission: 'stock.view' });
  if (!session) redirect('/');
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) notFound();
  return (
    <div>
      <PageHeader eyebrow="Stock" title={en.receive.title} />
      <div className="mt-6"><GrnEditor id={params.id.toLowerCase()} canEdit={session.permissions.has('stock.receive')} /></div>
    </div>
  );
}
