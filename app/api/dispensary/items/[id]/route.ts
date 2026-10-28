import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { getItem, patchItem, type ItemPatch } from '@/lib/stock/items';
import { ITEM_PATCH, pathId } from '@/lib/stock/schemas';
import { grantFromRequest } from '@/lib/auth/reauth';
import { deleteItem } from '@/lib/stock/adjustments';

export const dynamic = 'force-dynamic';
type Ctx = { params: { id: string } };

/** E-14: the item, its effective flags and its units (batches and balances come with the ledger, PR 7). */
export const GET = withSession<Ctx>({ permission: 'stock.view' }, async (_req, ctx, s) =>
  json(await getItem(s, pathId(ctx.params.id, 'ITEM_NOT_FOUND', 'No such item.'))));

/** E-15: everything but the item's identity. */
export const PATCH = withSession<Ctx>({ permission: 'stock.items', idempotent: { status: 200,
  replay: (s, _rid, ctx) => getItem(s, pathId(ctx.params.id, 'ITEM_NOT_FOUND', 'No such item.')) } }, async (req, ctx, s) => {
  const body = await strictBody(req, ITEM_PATCH);
  return json(await patchItem(s, pathId(ctx.params.id, 'ITEM_NOT_FOUND', 'No such item.'), body as ItemPatch));
});

/** Delete a medicine (founder, 2026-10-28): stock to 0 and off the list, signed (`stock.adjust` grant for the item, asked as the password). */
export const DELETE = withSession<Ctx>({ permission: 'stock.adjust' }, async (req, ctx, s) => {
  // D-64: the delete password, when the clinic has one, comes in the body (never logged).
  const text = await req.text();
  let deletePassword: string | undefined;
  try { const b = text ? JSON.parse(text) : {}; deletePassword = typeof b.deletePassword === 'string' ? b.deletePassword.slice(0, 200) : undefined; } catch { /* no body */ }
  await deleteItem(s, pathId(ctx.params.id, 'ITEM_NOT_FOUND', 'No such item.'), grantFromRequest(req), deletePassword);
  return json({ ok: true });
});

