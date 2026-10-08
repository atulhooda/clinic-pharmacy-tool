import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { DevicesPanel } from '@/components/devices/DevicesPanel';
import PageHeader from '@/components/ui/PageHeader';

export const dynamic = 'force-dynamic';

/** Settings → Trusted PCs (M-10, M-11). Owner by default (`devices.manage`). */
export default async function DevicesPage() {
  const { session } = await pageSession({ permission: 'devices.manage' });
  if (!session) redirect('/');
  return (
    <div>
      <PageHeader eyebrow="Settings" title="Trusted PCs" subtitle="A trusted PC keeps several people signed in and switches between them with a switch PIN. It locks itself after a few minutes without input." />
      <div className="card mt-6 p-6">
        <DevicesPanel orgId={session.orgId} premises={session.premises} onDevice={session.deviceId !== null} />
      </div>
    </div>
  );
}
