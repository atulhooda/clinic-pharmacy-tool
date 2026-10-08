'use client';

import Link from 'next/link';
import type { ShellUser } from '@/lib/auth/shell-user';

// Who is signed in: name · role. It opens My account (password, PINs, sign out everywhere).
export default function UserChip({ user, dark, compact }: { user: ShellUser; dark?: boolean; compact?: boolean }) {
  const initials = user.name.replace(/^(dr|mr|mrs|ms)\.?\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join('').toUpperCase();
  const cls = `inline-flex min-h-[36px] max-w-full items-center gap-1.5 rounded-lg border px-2.5 text-micro font-semibold ${
    dark ? 'border-sidebar-border text-sidebar-text hover:bg-sidebar-raise' : 'border-hairline-firm text-ink hover:bg-hairline/50'
  } ${compact ? 'min-w-[40px] justify-center px-0' : ''}`;
  return (
    <Link href="/account" className={cls} title={`${user.name} · ${user.role} — My account`} aria-label={compact ? `${user.name} — My account` : undefined}>
      {compact ? <span className="font-mono">{initials || '?'}</span> : (
        <>
          <span className="max-w-[16ch] truncate">{user.name}</span>
          <span className="opacity-70">· {user.role}</span>
        </>
      )}
    </Link>
  );
}
