import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/auth/page-session';
import { ChangePasswordForm } from '@/components/auth/ChangePasswordForm';
import { en } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

export default async function ChangePasswordPage() {
  const { session } = await pageSession();
  if (!session) redirect('/');
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <div className="rounded-xl2 border border-hairline bg-surface p-6 shadow-card">
        <h1 className="text-h2 mb-4">{en.password.title}</h1>
        <ChangePasswordForm mustChange={session.mustChangePassword} />
      </div>
    </main>
  );
}
