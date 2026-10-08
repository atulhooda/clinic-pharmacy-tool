'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Brand from '@/components/ui/Brand';
import MonoLabel from '@/components/ui/MonoLabel';
import { isActive, type NavItem } from '@/lib/nav';
import type { ShellUser } from '@/lib/auth/shell-user';
import { SHELL_ICONS } from './icons';
import UserChip from './UserChip';
import LogoutButton from './LogoutButton';

// The near-black command rail (the desk's). `full` (≥1024px) shows labels; `rail` (768–1023px)
// shows icons only, with the label as the accessible name. Same NAV, same order.
export default function Sidebar({ mode, nav, user, className = '' }: { mode: 'full' | 'rail'; nav: NavItem[]; user: ShellUser; className?: string }) {
  const path = usePathname();
  const full = mode === 'full';
  return (
    <aside className={`fixed inset-y-0 left-0 z-rail flex-col bg-sidebar text-sidebar-text ${full ? 'w-64' : 'w-rail'} ${className}`} aria-label="Primary">
      <div className={`flex h-16 items-center border-b border-sidebar-border ${full ? 'px-5' : 'justify-center px-2'}`}>
        {full ? <Brand dark /> : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src="/engageo-mark.svg" alt="Engageo" width={32} height={32} className="h-8 w-8 rounded-lg" />
        )}
      </div>

      <nav className={`flex-1 py-5 ${full ? 'px-3' : 'px-2'}`}>
        {full && <MonoLabel className="px-3 !text-sidebar-muted">Pharmacy</MonoLabel>}
        <ul className="mt-3 space-y-1">
          {nav.map((n) => {
            const active = isActive(path, n);
            const Icon = SHELL_ICONS[n.icon];
            return (
              <li key={n.key}>
                <Link href={n.href} aria-current={active ? 'page' : undefined} aria-label={full ? undefined : n.label} title={full ? undefined : n.label}
                  className={`group relative flex min-h-tap items-center gap-3 rounded-lg text-small transition-colors ${full ? 'px-3 py-2.5' : 'justify-center px-0 py-2.5'} ${
                    active ? 'bg-brand text-white shadow-[0_2px_10px_rgba(57,73,230,0.4)]' : 'text-sidebar-muted hover:bg-sidebar-raise hover:text-sidebar-text'
                  }`}>
                  <Icon className={`h-[18px] w-[18px] ${active ? 'text-white' : ''}`} />
                  {full && <span className="font-medium">{n.label}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className={`border-t border-sidebar-border py-4 ${full ? 'px-5' : 'px-2'}`}>
        {full ? (
          <>
            <div className="truncate text-small font-semibold text-sidebar-text">{user.orgName}</div>
            <div className="truncate text-micro text-sidebar-muted">
              {[user.premisesName, user.deviceName].filter(Boolean).join(' · ') || '—'}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <UserChip user={user} dark />
              <LogoutButton slug={user.orgSlug} dark />
            </div>
            <div className="mt-3">
              <MonoLabel dot="blue" className="!text-sidebar-muted">Powered by Engageo</MonoLabel>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <UserChip user={user} dark compact />
            <LogoutButton slug={user.orgSlug} dark compact />
          </div>
        )}
      </div>
    </aside>
  );
}
