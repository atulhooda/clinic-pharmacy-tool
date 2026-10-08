import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { AuditPanel } from '@/components/settings/AuditPanel';
import PageHeader from '@/components/ui/PageHeader';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { session } = await pageSession({ permission: 'audit.view' });
  if (!session) redirect('/settings');
  return (
    <div>
      <PageHeader eyebrow="Settings" title="Audit log" subtitle="Every security and settings change, newest first." />
      <div className="mt-6">
        <AuditPanel />
      </div>
    </div>
  );
}
