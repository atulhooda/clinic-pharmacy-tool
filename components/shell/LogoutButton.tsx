'use client';

import { useState } from 'react';
import { IconLogout } from '@/components/ui/icons';

// Sign out (A-06), then the organisation's sign-in link.
export default function LogoutButton({ slug, dark, compact }: { slug: string; dark?: boolean; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    await fetch('/api/auth/sign-out', { method: 'POST' }).catch(() => undefined);
    window.location.href = `/${slug}/sign-in`;
  }
  return (
    <button type="button" onClick={go} disabled={busy} aria-label={compact ? 'Log out' : undefined} title="Log out"
      className={`inline-flex min-h-[36px] items-center gap-2 whitespace-nowrap rounded-lg px-2.5 text-micro font-semibold ${
        dark ? 'text-sidebar-muted hover:bg-sidebar-raise hover:text-sidebar-text' : 'text-muted hover:bg-hairline/50 hover:text-ink'
      } ${compact ? 'min-w-[40px] justify-center px-0' : ''}`}>
      <IconLogout />
      {!compact && 'Log out'}
    </button>
  );
}
