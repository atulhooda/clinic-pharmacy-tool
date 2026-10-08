import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { setupDispensary } from '@/lib/stock/settings';
import { STOCK_SETTINGS, optional } from '@/lib/stock/schemas';

export const dynamic = 'force-dynamic';

/** E-02: set the dispensary up (the defaults, or the values given). 409 ALREADY_CONFIGURED once done. */
export const POST = withSession({ permission: 'stock.settings' }, async (req, _ctx, s) => {
  const body = await strictBody(req, optional(STOCK_SETTINGS));
  return json(await setupDispensary(s, body as Parameters<typeof setupDispensary>[1]), { status: 201 });
});
