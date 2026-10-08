import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { DevicesPanel } from '@/components/devices/DevicesPanel';
import { ActivityTracker } from '@/components/auth/ActivityTracker';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

/** Settings → Trusted PCs (M-10, M-11). Owner by default (`devices.manage`). */
export default async function DevicesPage() {
  const { session } = await pageSession({ permission: 'devices.manage' });
  if (!session) redirect('/');
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      {session.lockMinutes !== null && <ActivityTracker lockMinutes={session.lockMinutes} />}
      <div className="rounded-xl2 border border-hairline bg-surface p-6 shadow-card">
        <h1 className="text-h2 mb-4">{en.devices.title}</h1>
        <DevicesPanel orgId={session.orgId} premises={session.premises} onDevice={session.deviceId !== null} />
      </div>
    </main>
  );
}
