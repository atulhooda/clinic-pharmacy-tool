import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { PinForm } from '@/components/auth/PinForm';
import { AccountFrame, isStandalone } from '@/components/auth/AccountFrame';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

export default async function SigningPinPage() {
  const { session } = await pageSession();
  if (!session) redirect('/');
  if (session.mustChangePassword) redirect('/account/password');
  return (
    <AccountFrame standalone={isStandalone(session)} title={en.pins.signingTitle}>
      <PinForm kind="signing" />
    </AccountFrame>
  );
}
