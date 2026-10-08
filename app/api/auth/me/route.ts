import { json } from '@/lib/http/api';
import { withSession } from '@/lib/http/session-route';

export const dynamic = 'force-dynamic';

/**
 * A-07: who is signed in, with what permissions, at which premises, on which PC, and when the
 * PC locks. Self only. The organisation id is the entity for organisation-level re-auth purposes.
 */
export const GET = withSession({ allowMustChange: true }, async (_req, _ctx, s) =>
  json({
    name: s.name,
    role: s.roleKey,
    org: { id: s.orgId, slug: s.orgSlug, displayName: s.orgName },
    permissions: [...s.permissions].sort(),
    premises: s.premises,
    mustChangePassword: s.mustChangePassword,
    sessionExpiresAt: s.expiresAt.toISOString(),
    device: s.device,
    lockAt: s.lockAt?.toISOString() ?? null,
    hasSwitchPin: s.hasSwitchPin,
    hasSigningPin: s.hasSigningPin,
    needsSigningPin: s.needsSigningPin,
  }));
