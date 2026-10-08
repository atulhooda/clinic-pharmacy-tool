import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { PinForm } from '@/components/auth/PinForm';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

export default async function SigningPinPage() {
  const { session } = await pageSession();
  if (!session) redirect('/');
  if (session.mustChangePassword) redirect('/account/password');
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <div className="rounded-xl2 border border-hairline bg-surface p-6 shadow-card">
        <h1 className="text-h2 mb-4">{en.pins.signingTitle}</h1>
        <PinForm kind="signing" />
      </div>
    </main>
  );
}
