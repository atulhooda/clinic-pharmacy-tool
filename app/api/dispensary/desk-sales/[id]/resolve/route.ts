import { json } from '@/lib/http/api';
import { emptyBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { grantFromRequest } from '@/lib/auth/reauth';
import { getDeskSale, resolveDeskSale } from '@/lib/stock/desk-sales';
import { pathId } from '@/lib/stock/schemas';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };
const id = (ctx: Ctx) => pathId(ctx.params.id, 'DESK_SALE_NOT_FOUND', 'No such desk sale line.');

/**
 * E-56 (D-57): try a short or rejected desk sale line again, after the stock was counted or
 * received. Signed (`stock.adjust` grant for the line's premises); the movements name this person.
 */
export const POST = withSession<Ctx>({ permission: 'stock.adjust', idempotent: { status: 200, replay: (s, _rid, ctx) => getDeskSale(s, id(ctx)) } },
  async (req, ctx, s) => {
    await emptyBody(req);
    return json(await resolveDeskSale(s, id(ctx), grantFromRequest(req)));
  });
