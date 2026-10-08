import Link from 'next/link';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { ActivityTracker } from '@/components/auth/ActivityTracker';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

/** The settings area: signed in only; each page checks its own permission. */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const { session } = await pageSession();
  if (!session || session.mustChangePassword) redirect('/');
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      {session.lockMinutes !== null && <ActivityTracker lockMinutes={session.lockMinutes} />}
      <p className="mb-4 text-small"><Link href="/settings" className="text-brand">{en.settings.title}</Link> · <Link href="/" className="text-muted">{session.orgName}</Link></p>
      {children}
    </main>
  );
}
