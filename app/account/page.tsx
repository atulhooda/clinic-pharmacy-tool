import Link from 'next/link';
import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import PageHeader from '@/components/ui/PageHeader';
import { IconArrowRight } from '@/components/ui/icons';
import { EndAllSessionsButton } from '@/components/auth/EndAllSessionsButton';

export const dynamic = 'force-dynamic';

/** My account: password, PINs, and signing out everywhere (A-13 … A-16). */
export default async function AccountPage() {
  const { session } = await pageSession();
  if (!session) redirect('/');
  const rows = [
    { href: '/account/password', title: 'Password', body: 'Change the password you sign in with. Your other sessions end.' },
    { href: '/account/switch-pin', title: 'Switch PIN', body: 'The 6 digits you type on the lock screen of a shared PC.' },
    ...(session.hasSigningPin || session.needsSigningPin
      ? [{ href: '/account/signing-pin', title: 'Signing PIN', body: session.hasSigningPin ? 'Confirms consequential actions. Different from your switch PIN.' : 'Not set yet: some of your actions ask for it.' }]
      : []),
  ];
  return (
    <div>
      <PageHeader eyebrow="Account" title={session.name} subtitle={`${session.roleKey} · ${session.orgName}`} />
      <ul className="card mt-6 divide-y divide-hairline">
        {rows.map((r) => (
          <li key={r.href}>
            <Link href={r.href} className="flex items-center gap-4 px-5 py-4 hover:bg-surface-raise/50">
              <span className="flex-1">
                <span className="block font-semibold">{r.title}</span>
                <span className="block text-small text-muted">{r.body}</span>
              </span>
              <IconArrowRight className="h-4 w-4 text-faint" />
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-6"><EndAllSessionsButton slug={session.orgSlug} /></div>
    </div>
  );
}
