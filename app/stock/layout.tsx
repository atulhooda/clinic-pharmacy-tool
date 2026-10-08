import Link from 'next/link';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { ActivityTracker } from '@/components/auth/ActivityTracker';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

/** The stock area (`stock.view`). */
export default async function StockLayout({ children }: { children: ReactNode }) {
  const { session } = await pageSession({ permission: 'stock.view' });
  if (!session || session.mustChangePassword) redirect('/');
  const t = en.stock;
  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      {session.lockMinutes !== null && <ActivityTracker lockMinutes={session.lockMinutes} />}
      <nav className="mb-4 flex flex-wrap gap-4 text-small">
        <Link href="/" className="text-muted">{session.orgName}</Link>
        <Link href="/stock/items" className="text-brand">{t.items}</Link>
        <Link href="/stock/suppliers" className="text-brand">{t.suppliers}</Link>
        <Link href="/stock/setup" className="text-brand">{t.setup}</Link>
      </nav>
      {children}
    </main>
  );
}
