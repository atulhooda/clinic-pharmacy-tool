import { notFound } from 'next/navigation';
import { resolveOrgBySlug } from '@/lib/db/orgs';
import { getSchemaStatus } from '@/lib/db/selfcheck';
import { SignInForm } from '@/components/auth/SignInForm';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

/** The organisation's sign-in link (06a §2.4, §16): /{orgSlug}/sign-in. */
export default async function SignInPage({ params }: { params: { org: string } }) {
  if (!(await getSchemaStatus()).ok) {
    return <Shell><p className="text-body text-bad-ink">{en.signIn.unavailable}</p></Shell>;
  }
  const org = await resolveOrgBySlug(params.org);
  if (!org) notFound();
  return (
    <Shell>
      <h1 className="text-h1 mb-6">{en.signIn.title}</h1>
      <SignInForm orgSlug={org.slug} orgName={org.displayName} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <p className="mb-2 text-micro font-semibold uppercase tracking-widest text-muted">{en.appName}</p>
      <div className="rounded-xl2 border border-hairline bg-surface p-6 shadow-card">{children}</div>
    </main>
  );
}
