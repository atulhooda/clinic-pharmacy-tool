'use client';

import { navFor } from '@/lib/nav';
import type { ShellUser } from '@/lib/auth/shell-user';
import { ActivityTracker } from '@/components/auth/ActivityTracker';
import { SwitchPersonButton } from '@/components/auth/SwitchPersonButton';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import BottomTabs from './BottomTabs';

// ONE shell, three widths, one nav array (the desk's layout):
//   <768px    the bottom tab bar
//   768–1023  the icon rail
//   ≥1024     the full sidebar
// On a trusted PC it also runs the idle-lock timer and offers "Switch person".
export default function AppShell({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const nav = navFor(user.permissions);
  return (
    <div className="min-h-dvh">
      {user.lockMinutes !== null && <ActivityTracker lockMinutes={user.lockMinutes} />}
      <Sidebar mode="full" nav={nav} user={user} className="hidden lg:flex" />
      <Sidebar mode="rail" nav={nav} user={user} className="hidden md:flex lg:hidden" />
      <div className="pb-tabs md:pb-0 md:pl-rail lg:pl-64">
        <TopBar user={user} actions={user.deviceName ? <SwitchPersonButton /> : null} />
        <main className="px-4 py-4 md:px-8 md:py-6">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
      <BottomTabs nav={nav} className="md:hidden" />
    </div>
  );
}
