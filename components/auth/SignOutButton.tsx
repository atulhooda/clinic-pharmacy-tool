'use client';

import { en } from '@/lib/i18n/en';

export function SignOutButton({ orgSlug }: { orgSlug: string }) {
  async function signOut() {
    await fetch('/api/auth/sign-out', { method: 'POST' });
    window.location.assign(`/${orgSlug}/sign-in`);
  }
  return (
    <button type="button" onClick={signOut}
      className="min-h-tap rounded-xl2 border border-ink bg-surface px-4 font-semibold shadow-brutal-sm hover:bg-surface-raise">
      {en.home.signOut}
    </button>
  );
}
