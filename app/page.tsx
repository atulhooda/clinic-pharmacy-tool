import Link from 'next/link';
import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { SignOutButton } from '@/components/auth/SignOutButton';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

/** Home: who is signed in. The stock screens arrive in later PRs. */
export default async function Home() {
  const { session, available } = await pageSession();
  const t = en.home;
  if (session?.mustChangePassword) redirect('/account/password');
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <p className="mb-2 text-micro font-semibold uppercase tracking-widest text-muted">{en.appName}</p>
      <div className="rounded-xl2 border border-hairline bg-surface p-6 shadow-card">
        {!available && <p className="text-body text-bad-ink">{en.signIn.unavailable}</p>}
        {available && !session && (
          <>
            <p className="text-body">{t.notSignedIn}</p>
            <p className="mt-2 font-mono text-small text-muted">{t.linkShape}</p>
          </>
        )}
        {session && (
          <div className="space-y-4">
            <p className="text-body">
              {t.signedInAs} <strong>{session.name}</strong> ({session.roleKey}) {t.at} <strong>{session.orgName}</strong>
            </p>
            <div>
              <p className="text-small font-semibold">{t.premises}</p>
              {session.premises.length === 0
                ? <p className="text-small text-muted">{t.noPremises}</p>
                : <ul className="list-disc pl-5 text-small">{session.premises.map((p) => <li key={p.id}>{p.name}</li>)}</ul>}
            </div>
            <div className="flex gap-3">
              <SignOutButton orgSlug={session.orgSlug} />
              <Link href="/account/password" className="min-h-tap inline-flex items-center rounded-xl2 px-4 text-small font-semibold text-brand hover:text-brand-hover">
                {t.changePassword}
              </Link>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
