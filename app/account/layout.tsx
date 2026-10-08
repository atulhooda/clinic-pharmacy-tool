import type { ReactNode } from 'react';
import { pageSession } from '@/lib/auth/page-session';
import { shellUser } from '@/lib/auth/shell-user';
import AppShell from '@/components/shell/AppShell';

export const dynamic = 'force-dynamic';

/**
 * My account. Inside the shell once the person may use the app; a one-time password or a
 * missing switch PIN on a trusted PC shows the page alone (nothing else is open yet).
 */
export default async function AccountLayout({ children }: { children: ReactNode }) {
  const { session } = await pageSession();
  if (!session || session.mustChangePassword || (session.deviceId && !session.hasSwitchPin)) return <>{children}</>;
  return <AppShell user={shellUser(session)}>{children}</AppShell>;
}
