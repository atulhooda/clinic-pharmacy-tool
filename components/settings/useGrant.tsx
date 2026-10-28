'use client';

import { useCallback, useState } from 'react';
import { ReauthDialog } from '@/components/auth/ReauthDialog';

/**
 * Ask for the signing PIN (06a §3.7) and resolve with a single-use grant id, or null if the
 * person cancels. Render `dialog` somewhere in the component.
 */
export function useGrant() {
  const [ask, setAsk] = useState<{ purpose: string; entityId: string; passwordOnly: boolean; resolve: (g: string | null) => void } | null>(null);
  const withGrant = useCallback((purpose: string, entityId: string, opts: { passwordOnly?: boolean } = {}) =>
    new Promise<string | null>((resolve) => setAsk({ purpose, entityId, passwordOnly: opts.passwordOnly ?? false, resolve })), []);
  const dialog = ask ? (
    <ReauthDialog purpose={ask.purpose} entityId={ask.entityId} passwordOnly={ask.passwordOnly}
      onGrant={(g) => { ask.resolve(g); setAsk(null); }}
      onCancel={() => { ask.resolve(null); setAsk(null); }} />
  ) : null;
  return { withGrant, dialog };
}
