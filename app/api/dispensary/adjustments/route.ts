import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { grantFromRequest } from '@/lib/auth/reauth';
import { adjustStock, getAdjustment, listAdjustments, parseCountLines } from '@/lib/stock/adjustments';

export const dynamic = 'force-dynamic';

/** E-34 GET: adjustments at the caller's premises; `?premisesId=`. */
export const GET = withSession({ permission: 'stock.view' }, async (req, _ctx, s) => json(await listAdjustments(s, new URL(req.url).searchParams)));

/**
 * E-34 POST (D-53, PR 10a): what was counted on the shelf, per batch. A batch with no movement yet
 * gets opening stock; one with movements gets a count correction, with a reason. Signed (`stock.adjust`
 * grant for the premises); never backdated, so the body has no `occurredAt` (06b DT-21).
 */
export const POST = withSession({ permission: 'stock.adjust', idempotent: { status: 201, replay: (s, rid) => getAdjustment(s, rid as string) } }, async (req, _ctx, s) => {
  const body = await strictBody(req, {
    premisesId: { type: 'uuid' },
    reasonCode: { type: 'string', max: 40, optional: true, nullable: true },
    note: { type: 'string', min: 1, max: 500, optional: true, nullable: true },
    lines: { type: 'objects', max: 100 },
  });
  const id = await adjustStock(s, { premisesId: body.premisesId.toLowerCase(), reasonCode: body.reasonCode ?? null, note: body.note?.trim() || null,
    lines: parseCountLines(body.lines) }, grantFromRequest(req));
  return json(await getAdjustment(s, id), { status: 201 });
});
