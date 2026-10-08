import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { ChangePasswordForm } from '@/components/auth/ChangePasswordForm';
import { AccountFrame, isStandalone } from '@/components/auth/AccountFrame';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

export default async function ChangePasswordPage() {
  const { session } = await pageSession();
  if (!session) redirect('/');
  return (
    <AccountFrame standalone={isStandalone(session)} title={en.password.title}>
      <ChangePasswordForm mustChange={session.mustChangePassword} />
    </AccountFrame>
  );
}
