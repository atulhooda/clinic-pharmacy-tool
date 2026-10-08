'use client';

import { useEffect } from 'react';

/**
 * 06a §3.6 on the client: real input (keyboard, pointer, touch) sends an activity ping (A-08)
 * at most every 30 s, and the same timer as the server shows the lock screen on time. The
 * server rule is the guarantee; this only keeps the screen honest. Polls never ping.
 */
export function ActivityTracker({ lockMinutes }: { lockMinutes: number }) {
  useEffect(() => {
    let lastInput = Date.now();
    let lastPing = Date.now();
    const lockMs = lockMinutes * 60_000;
    const toLock = () => window.location.assign('/lock');
    const onInput = () => {
      lastInput = Date.now();
      if (lastInput - lastPing < 30_000) return;
      lastPing = lastInput;
      fetch('/api/auth/activity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        .then((r) => { if (r.status === 401) toLock(); })
        .catch(() => {});
    };
    const events = ['keydown', 'pointerdown', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, onInput, { passive: true }));
    const timer = window.setInterval(() => { if (Date.now() - lastInput > lockMs) toLock(); }, 5_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, onInput));
      window.clearInterval(timer);
    };
  }, [lockMinutes]);
  return null;
}
