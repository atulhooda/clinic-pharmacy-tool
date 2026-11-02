import { json } from '@/lib/http/api';
import { withSession } from '@/lib/http/session-route';
import { listDeskSales } from '@/lib/stock/desk-sales';

export const dynamic = 'force-dynamic';

/** E-55 (D-57): the desk's sale lines at the caller's premises; `?status=open` (short or rejected, the default), `all`, or `flagged` (D-66: lines with rx_flags). */
export const GET = withSession({ permission: 'stock.view' }, async (req, _ctx, s) => json(await listDeskSales(s, new URL(req.url).searchParams)));
