import { json } from '@/lib/http/api';
import { deskRoute } from '@/lib/integrations/desk/route';
import { parseSales, postDeskSales } from '@/lib/integrations/desk/sync';

export const dynamic = 'force-dynamic';

/**
 * E-53 (D-57): an issued bill's linked lines take stock, each all or nothing (posted, short or
 * rejected), idempotent per (billId, lineKey). Signed by the desk; 404 when the sync is off.
 */
export const POST = deskRoute(async (ctx, body) => json(await postDeskSales(ctx, parseSales(body))));
