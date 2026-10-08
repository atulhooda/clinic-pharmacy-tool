import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { shellUser } from '@/lib/auth/shell-user';
import AppShell from '@/components/shell/AppShell';

export const dynamic = 'force-dynamic';

/** The settings area: signed in only; each page checks its own permission. */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const { session } = await pageSession();
  if (!session || session.mustChangePassword) redirect('/');
  return <AppShell user={shellUser(session)}>{children}</AppShell>;
}
