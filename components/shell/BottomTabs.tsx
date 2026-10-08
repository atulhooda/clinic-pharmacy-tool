'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isActive, type NavItem } from '@/lib/nav';
import { SHELL_ICONS } from './icons';

// The phone's bar: every destination (five at most in Milestone 1), labels under the icon.
export default function BottomTabs({ nav, className = '' }: { nav: NavItem[]; className?: string }) {
  const path = usePathname();
  return (
    <nav aria-label="Primary" className={`fixed inset-x-0 bottom-0 z-rail grid h-tabs border-t border-hairline bg-surface pb-[env(safe-area-inset-bottom)] ${className}`}
      style={{ gridTemplateColumns: `repeat(${nav.length}, minmax(0, 1fr))` }}>
      {nav.map((n) => {
        const active = isActive(path, n);
        const Icon = SHELL_ICONS[n.icon];
        return (
          <Link key={n.key} href={n.href} aria-current={active ? 'page' : undefined}
            className={`flex flex-col items-center justify-center gap-0.5 text-micro font-semibold ${active ? 'text-brand' : 'text-muted'}`}>
            <Icon className="h-5 w-5" />
            <span>{n.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
