'use client';

import { useState } from 'react';
import Button from '@/components/ui/Button';

/** A-16: sign out of every PC and browser, this one included. */
export function EndAllSessionsButton({ slug }: { slug: string }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    if (!window.confirm('Sign out everywhere, this browser included?')) return;
    setBusy(true);
    await fetch('/api/account/sessions/revoke', { method: 'POST' }).catch(() => undefined);
    window.location.href = `/${slug}/sign-in`;
  }
  return <Button variant="danger" busy={busy} onClick={go}>Sign out everywhere</Button>;
}
