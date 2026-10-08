import Link from 'next/link';
import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { SignOutButton } from '@/components/auth/SignOutButton';
import { SwitchPersonButton } from '@/components/auth/SwitchPersonButton';
import { ActivityTracker } from '@/components/auth/ActivityTracker';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

const link = 'min-h-tap inline-flex items-center rounded-xl2 px-3 text-small font-semibold text-brand hover:text-brand-hover';

/** Home: who is signed in, and where. The stock screens arrive in later PRs. */
export default async function Home() {
  const { session, available, code, onDevice } = await pageSession();
  const t = en.home;
  // A trusted PC with nobody active, or a stale tab after a switch, goes to the lock screen.
  if (available && !session && (code === 'device_locked' || onDevice)) redirect('/lock');
  if (session?.mustChangePassword) redirect('/account/password');
  if (session?.deviceId && !session.hasSwitchPin) redirect('/account/switch-pin');
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
            {session.lockMinutes !== null && <ActivityTracker lockMinutes={session.lockMinutes} />}
            <p className="text-body">
              {t.signedInAs} <strong>{session.name}</strong> ({session.roleKey}) {t.at} <strong>{session.orgName}</strong>
              {session.device && <> {t.onPc} <strong>{session.device.name}</strong></>}
            </p>
            {session.needsSigningPin && (
              <p className="rounded-xl2 bg-warn-wash px-3 py-2 text-small text-warn-ink">
                <Link href="/account/signing-pin" className="underline">{t.setSigningPin}</Link>
              </p>
            )}
            <div>
              <p className="text-small font-semibold">{t.premises}</p>
              {session.premises.length === 0
                ? <p className="text-small text-muted">{t.noPremises}</p>
                : <ul className="list-disc pl-5 text-small">{session.premises.map((p) => <li key={p.id}>{p.name}</li>)}</ul>}
            </div>
            <div className="flex flex-wrap gap-3">
              {session.deviceId && <SwitchPersonButton />}
              <SignOutButton orgSlug={session.orgSlug} />
            </div>
            <div className="flex flex-wrap gap-1">
              <Link href="/account/password" className={link}>{t.changePassword}</Link>
              <Link href="/account/switch-pin" className={link}>{t.switchPin}</Link>
              {(session.hasSigningPin || session.needsSigningPin) && <Link href="/account/signing-pin" className={link}>{t.signingPin}</Link>}
              {session.permissions.has('devices.manage') && <Link href="/settings/devices" className={link}>{t.devices}</Link>}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
