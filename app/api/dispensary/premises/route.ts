import { json } from '@/lib/http/api';
import { withSession } from '@/lib/http/session-route';
import { listDispensaryPremises } from '@/lib/stock/settings';

export const dynamic = 'force-dynamic';

/** E-04: the caller's premises with their dispensary settings and locations. */
export const GET = withSession({ permission: 'stock.view' }, async (_req, _ctx, s) => json({ items: await listDispensaryPremises(s) }));
