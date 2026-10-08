import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { getStockSettings, putStockSettings } from '@/lib/stock/settings';
import { STOCK_SETTINGS } from '@/lib/stock/schemas';

export const dynamic = 'force-dynamic';

/** E-01: the organisation's stock settings (409 DISPENSARY_NOT_CONFIGURED before E-02). */
export const GET = withSession({ permission: 'stock.view' }, async (_req, _ctx, s) => {
  const r = await getStockSettings(s);
  return json(r, { headers: { etag: `"${r.version}"` } });
});

/** E-03: change them (If-Match). */
export const PUT = withSession({ permission: 'stock.settings', idempotent: { status: 200, replay: (s) => getStockSettings(s) } }, async (req, _ctx, s) => {
  const body = await strictBody(req, STOCK_SETTINGS);
  const r = await putStockSettings(s, body as Parameters<typeof putStockSettings>[1], req.headers.get('if-match'));
  return json(r, { headers: { etag: `"${r.version}"` } });
});
