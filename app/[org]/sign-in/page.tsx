import { notFound } from 'next/navigation';
import { resolveOrgBySlug } from '@/lib/db/orgs';
import { getSchemaStatus } from '@/lib/db/selfcheck';
import { SignInForm } from '@/components/auth/SignInForm';
import Brand from '@/components/ui/Brand';
import MonoLabel from '@/components/ui/MonoLabel';
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
      <MonoLabel dot="blue">{org.displayName}</MonoLabel>
      <h1 className="mb-6 mt-2 text-h1">{en.signIn.title}<span className="accent-serif">.</span></h1>
      <SignInForm orgSlug={org.slug} orgName={org.displayName} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <Brand />
      <div className="card mt-6 p-6 md:p-8">{children}</div>
      <p className="mt-6 text-center"><MonoLabel dot="blue">Powered by Engageo</MonoLabel></p>
    </main>
  );
}
