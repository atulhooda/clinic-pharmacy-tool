import { json } from '@/lib/http/api';
import { strictBody, UUID_PATTERN } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { issueGrant } from '@/lib/auth/reauth';

export const dynamic = 'force-dynamic';

/**
 * A-12 (06a §3.7): the signing PIN or the account password (never the switch PIN) → a
 * single-use grant for one purpose and entity, valid 2 minutes. The client sends it back in
 * the Reauth-Grant header. Wrong secrets count against this session.
 */
export const POST = withSession({}, async (req, _ctx, s) => {
  const body = await strictBody(req, {
    pin: { type: 'string', min: 1, max: 16, optional: true },
    password: { type: 'string', min: 1, max: 256, optional: true },
    purpose: { type: 'string', min: 1, max: 40 },
    entityId: { type: 'string', pattern: UUID_PATTERN },
  });
  const g = await issueGrant(s, body);
  return json({ grantId: g.grantId, expiresAt: g.expiresAt.toISOString() }, { status: 201 });
});
