import { json } from '@/lib/http/api';
import { withSession } from '@/lib/http/session-route';

export const dynamic = 'force-dynamic';

/** A-07: who is signed in, with what permissions, at which premises. Self only. */
export const GET = withSession({ allowMustChange: true }, async (_req, _ctx, s) =>
  json({
    name: s.name,
    role: s.roleKey,
    org: { slug: s.orgSlug, displayName: s.orgName },
    permissions: [...s.permissions].sort(),
    premises: s.premises,
    mustChangePassword: s.mustChangePassword,
    sessionExpiresAt: s.expiresAt.toISOString(),
  }));
