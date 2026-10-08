import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { AuditPanel } from '@/components/settings/AuditPanel';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { session } = await pageSession({ permission: 'audit.view' });
  if (!session) redirect('/settings');
  return (
    <div className="card p-6">
      <h1 className="text-h2 mb-4">{en.settings.audit}</h1>
      <AuditPanel />
    </div>
  );
}
