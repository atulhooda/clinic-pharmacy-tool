import Link from 'next/link';
import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { shellUser } from '@/lib/auth/shell-user';
import { todaySummary } from '@/lib/stock/summary';
import { listAudit } from '@/lib/admin/audit-view';
import AppShell from '@/components/shell/AppShell';
import PageHeader from '@/components/ui/PageHeader';
import KpiCard from '@/components/ui/KpiCard';
import MonoLabel from '@/components/ui/MonoLabel';
import Brand from '@/components/ui/Brand';
import { IconCheck, IconArrowRight } from '@/components/ui/icons';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

const ist = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
const today = () => new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });
/** An audit action as words: "staff.password_reset" → "Staff · password reset". */
const words = (a: string) => { const [head, ...rest] = a.split('.'); return `${head[0].toUpperCase()}${head.slice(1)} · ${rest.join(' ').replace(/_/g, ' ')}`; };

/** Today: where the dispensary stands, what to do next, and what just happened. */
export default async function Home() {
  const { session, available, code, onDevice } = await pageSession();
  // A trusted PC with nobody active, or a stale tab after a switch, goes to the lock screen.
  if (available && !session && (code === 'device_locked' || onDevice)) redirect('/lock');
  if (session?.mustChangePassword) redirect('/account/password');
  if (session?.deviceId && !session.hasSwitchPin) redirect('/account/switch-pin');
  if (!session) return <SignedOut available={available} />;

  const [sum, recent] = await Promise.all([
    todaySummary(session),
    session.permissions.has('audit.view') ? listAudit(session, new URLSearchParams({ limit: '6' })).then((r) => r.items) : Promise.resolve(null),
  ]);
  const steps = [
    { done: sum.dispensaryReady, label: 'Set up the dispensary', href: '/stock/setup' },
    { done: sum.premises > 0 && sum.premisesReady === sum.premises, label: `Choose each premises' dispensing mode (${sum.premisesReady} of ${sum.premises})`, href: '/stock/setup' },
    { done: (sum.items ?? 0) > 0, label: 'Add the items you stock', href: '/stock/items' },
    { done: (sum.suppliers ?? 0) > 0, label: 'Add your suppliers', href: '/stock/suppliers' },
    { done: session.hasSigningPin || !session.needsSigningPin, label: 'Set your signing PIN', href: '/account/signing-pin' },
  ];
  const left = steps.filter((x) => !x.done).length;

  return (
    <AppShell user={shellUser(session)}>
      <PageHeader eyebrow="Live" dot="green" title="Today" accent
        subtitle={<>{today()} · {session.premises.map((p) => p.name).join(', ') || 'no premises yet'}</>} />

      <div className="mt-6 grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
        <KpiCard label="Items" value={sum.items ?? '—'} sub={sum.rxItems === null ? 'stock not visible to you' : `${sum.rxItems} need a prescription`} />
        <KpiCard label="Suppliers" value={sum.suppliers ?? '—'} tone={(sum.supplierIssues ?? 0) > 0 ? 'amber' : 'ink'}
          sub={sum.supplierIssues === null ? 'stock not visible to you' : sum.supplierIssues ? `${sum.supplierIssues} licence missing or expired` : 'every licence in date'} />
        <KpiCard label="Premises ready" value={sum.premisesReady} unit={`/${sum.premises}`} tone={sum.premises > 0 && sum.premisesReady === sum.premises ? 'green' : 'brand'}
          sub={sum.dispensaryReady ? 'dispensing mode chosen' : 'dispensary not set up'} />
        <KpiCard label="Staff" value={sum.staff ?? '—'} tone="brand" sub={sum.signedIn === null ? `you are ${session.roleKey}` : `${sum.signedIn} signed in today`} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <section className="card lg:col-span-2">
          <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
            <MonoLabel>{left ? 'Getting started' : 'All set'}</MonoLabel>
            <span className="text-small text-muted">{left ? `${left} of ${steps.length} to do` : 'stock movements arrive with the next release'}</span>
          </div>
          <ul className="divide-y divide-hairline">
            {steps.map((x) => (
              <li key={x.label}>
                <Link href={x.href} className="flex items-center gap-4 px-5 py-4 hover:bg-surface-raise/50">
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${x.done ? 'bg-ok-wash text-ok-ink' : 'border border-hairline-firm text-faint'}`}>
                    {x.done ? <IconCheck className="h-4 w-4" /> : null}
                  </span>
                  <span className={`flex-1 ${x.done ? 'text-muted line-through decoration-hairline-firm' : 'font-medium text-ink'}`}>{x.label}</span>
                  {!x.done && <IconArrowRight className="h-4 w-4 text-faint" />}
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <div className="space-y-4">
          <section className="card p-5">
            <MonoLabel>Signed in</MonoLabel>
            <dl className="mt-3 space-y-2 text-body">
              <div className="flex justify-between"><dt className="text-muted">you</dt><dd className="font-semibold">{session.name}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">role</dt><dd className="font-semibold">{session.roleKey}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">this PC</dt><dd className="font-semibold">{session.device?.name ?? 'not trusted'}</dd></div>
            </dl>
          </section>
          {recent && (
            <section className="card p-5">
              <MonoLabel>Recent</MonoLabel>
              {recent.length === 0 ? <p className="mt-3 text-muted">No actions yet today.</p> : (
                <ul className="mt-3 space-y-2.5">
                  {recent.map((r) => (
                    <li key={r.id} className="flex items-baseline justify-between gap-3 text-small">
                      <span className="truncate"><span className="font-semibold">{r.actorLabel}</span> <span className="text-muted">{words(r.action)}</span></span>
                      <span className="tnum shrink-0 font-mono text-micro text-faint">{ist(r.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function SignedOut({ available }: { available: boolean }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <Brand />
      <div className="card mt-6 p-6">
        {!available ? <p className="text-body text-bad-ink">{en.signIn.unavailable}</p> : (
          <>
            <MonoLabel dot="blue">Clinic Pharmacy</MonoLabel>
            <h1 className="mt-2 text-h1">Sign in<span className="accent-serif">.</span></h1>
            <p className="mt-2 text-muted">{en.home.notSignedIn}</p>
            <p className="mt-3 rounded-lg bg-surface-raise px-3 py-2 font-mono text-small text-ink-soft">{en.home.linkShape}</p>
          </>
        )}
      </div>
    </main>
  );
}
