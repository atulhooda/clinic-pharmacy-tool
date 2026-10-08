import { json } from '@/lib/http/api';
import { withSession } from '@/lib/http/session-route';
import { getMaster } from '@/lib/stock/master';
import { pathId } from '@/lib/stock/schemas';

export const dynamic = 'force-dynamic';

/** E-09 */
export const GET = withSession<{ params: { id: string } }>({}, async (_req, ctx, s) =>
  json(await getMaster(s, pathId(ctx.params.id, 'MASTER_NOT_FOUND', 'No such medicine.'))));
