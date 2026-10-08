import { LockScreen } from '@/components/auth/LockScreen';
import Brand from '@/components/ui/Brand';
import MonoLabel from '@/components/ui/MonoLabel';

export const dynamic = 'force-dynamic';

/** The "Who's working?" lock screen of a trusted PC (06a §3.5). It needs no session. */
export default function LockPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <Brand />
      <div className="card mt-6 p-6 md:p-8">
        <LockScreen />
      </div>
      <p className="mt-6 text-center"><MonoLabel dot="blue">Powered by Engageo</MonoLabel></p>
    </main>
  );
}
