import { json } from '@/lib/http/api';
import { emptyBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { discardGrn, getGrn } from '@/lib/stock/receipts';
import { pathId } from '@/lib/stock/schemas';

export const dynamic = 'force-dynamic';
type Ctx = { params: { id: string } };
const id = (ctx: Ctx) => pathId(ctx.params.id, 'GRN_NOT_FOUND', 'No such delivery.');

/** E-26: discard a draft. It is kept, marked DISCARDED; nothing is ever posted from it. */
export const POST = withSession<Ctx>({ permission: 'stock.receive', idempotent: { status: 200, replay: (s, _rid, ctx) => getGrn(s, id(ctx)) } }, async (req, ctx, s) => {
  await emptyBody(req);
  return json(await getGrn(s, await discardGrn(s, id(ctx))));
});
