import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { shellUser } from '@/lib/auth/shell-user';
import AppShell from '@/components/shell/AppShell';

export const dynamic = 'force-dynamic';

/** The stock area (`stock.view`), inside the shell. */
export default async function StockLayout({ children }: { children: ReactNode }) {
  const { session } = await pageSession({ permission: 'stock.view' });
  if (!session || session.mustChangePassword) redirect('/');
  return <AppShell user={shellUser(session)}>{children}</AppShell>;
}
