import { json } from '@/lib/http/api';
import { HttpError } from '@/lib/http/errors';
import { deskRoute } from '@/lib/integrations/desk/route';
import { deskItems } from '@/lib/integrations/desk/sync';

export const dynamic = 'force-dynamic';

/** E-52 (D-57, D-66): every active item the desk may put on a bill, with stock, the highest MRP per base unit, packs and flags. Signed by the desk; 404 when the sync is off. */
export const GET = deskRoute(async (ctx, body) => {
  if (body !== null) throw new HttpError(422, 'UNKNOWN_FIELD', 'This route takes no body.');
  return json(await deskItems(ctx));
});
