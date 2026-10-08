import { json } from '@/lib/http/api';
import { emptyBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { getGrn, postGrn } from '@/lib/stock/receipts';
import { pathId } from '@/lib/stock/schemas';

export const dynamic = 'force-dynamic';
type Ctx = { params: { id: string } };
const id = (ctx: Ctx) => pathId(ctx.params.id, 'GRN_NOT_FOUND', 'No such delivery.');

/** E-25: post a draft: its batches, lines and RECEIPTs, all or nothing. Warnings come back with it. */
export const POST = withSession<Ctx>({ permission: 'stock.receive', idempotent: { status: 200,
  replay: async (s, _rid, ctx) => ({ grn: await getGrn(s, id(ctx)), warnings: null }) } }, async (req, ctx, s) => {
  await emptyBody(req);
  const r = await postGrn(s, id(ctx));
  return json({ grn: await getGrn(s, r.id), warnings: r.warnings });
});
