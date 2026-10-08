import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { grantFromRequest } from '@/lib/auth/reauth';
import { listPremises, createPremises } from '@/lib/admin/premises';

export const dynamic = 'force-dynamic';

/** M-02: the caller's premises (the owner: all). Any member. */
export const GET = withSession({}, async (_req, _ctx, s) => json({ items: await listPremises(s) }));

/** M-03: create a premises (`org.settings` + grant). */
export const POST = withSession({ permission: 'org.settings', idempotent: { status: 201,
  replay: async (s, rid) => (await listPremises(s)).find((p) => p.id === rid) ?? null } }, async (req, _ctx, s) => {
  const body = await strictBody(req, {
    name: { type: 'string', min: 1, max: 80 },
    address: { type: 'string', min: 1, max: 500 },
    stateCode: { type: 'string', pattern: /^[0-9]{2}$/ },
    gstin: { type: 'string', max: 15, optional: true, nullable: true },
    legalName: { type: 'string', max: 200, optional: true, nullable: true },
  });
  return json(await createPremises(s, body, grantFromRequest(req)), { status: 201 });
});
