'use client';

import { useEffect, useState } from 'react';
import type { ShellUser } from '@/lib/auth/shell-user';

const fmt = (ms: number) => {
  const d = new Date(ms);
  const date = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
  return { date, time };
};

// Sticky at every width: the date and time in IST (the clock advances on its own), and on a
// trusted PC the "Switch person" button. On a phone it also names the organisation.
export default function TopBar({ user, actions }: { user: ShellUser; actions?: React.ReactNode }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const f = now ? fmt(now) : null;
  return (
    <header className="sticky top-0 z-top flex h-14 items-center justify-between gap-3 border-b border-hairline bg-canvas/95 px-4 backdrop-blur md:h-16 md:px-8">
      <div className="min-w-0">
        <div className="truncate text-small font-semibold text-ink md:hidden">{user.orgName}</div>
        <div className="mono-label tnum flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />
          {f ? <><span>{f.date}</span><span>{f.time}</span></> : <span>&nbsp;</span>}
        </div>
      </div>
      <div className="flex items-center gap-1 md:gap-2">{actions}</div>
    </header>
  );
}
