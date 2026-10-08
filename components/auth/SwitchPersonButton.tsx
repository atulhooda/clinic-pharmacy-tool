'use client';

import { en } from '@/lib/i18n/en';

/** A-09 "Switch person": lock this PC now and show the lock screen. */
export function SwitchPersonButton() {
  async function lock() {
    await fetch('/api/auth/lock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
    window.location.assign('/lock');
  }
  return (
    <button type="button" onClick={lock}
      className="min-h-tap rounded-xl2 border border-hairline-firm px-4 text-small font-semibold hover:border-brand">
      {en.home.switchPerson}
    </button>
  );
}
