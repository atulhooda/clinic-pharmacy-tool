import Brand from '@/components/ui/Brand';
import PageHeader from '@/components/ui/PageHeader';
import MonoLabel from '@/components/ui/MonoLabel';

/**
 * An account form's frame: centred on its own when it is the only thing the person may do (a
 * one-time password, or no switch PIN yet on a trusted PC); otherwise a page inside the shell.
 */
export function AccountFrame({ standalone, title, children }: { standalone: boolean; title: string; children: React.ReactNode }) {
  if (standalone) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
        <Brand />
        <div className="card mt-6 p-6">
          <MonoLabel dot="blue">Account</MonoLabel>
          <h1 className="mb-4 mt-2 text-h2">{title}</h1>
          {children}
        </div>
      </main>
    );
  }
  return (
    <div>
      <PageHeader eyebrow="Account" title={title} />
      <div className="card mt-6 max-w-md p-6">{children}</div>
    </div>
  );
}

export const isStandalone = (s: { mustChangePassword: boolean; deviceId: string | null; hasSwitchPin: boolean }) =>
  s.mustChangePassword || (s.deviceId !== null && !s.hasSwitchPin);
