import { LockScreen } from '@/components/auth/LockScreen';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

/** The "Who's working?" lock screen of a trusted PC (06a §3.5). It needs no session. */
export default function LockPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <p className="mb-2 text-micro font-semibold uppercase tracking-widest text-muted">{en.appName}</p>
      <div className="rounded-xl2 border border-hairline bg-surface p-6 shadow-card">
        <LockScreen />
      </div>
    </main>
  );
}
