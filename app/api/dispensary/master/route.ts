import { json } from '@/lib/http/api';
import { withSession } from '@/lib/http/session-route';
import { searchMaster } from '@/lib/stock/master';

export const dynamic = 'force-dynamic';

/** E-08: the global medicine master, `?q=&salt=`. Any member. */
export const GET = withSession({}, async (req, _ctx, s) => json(await searchMaster(s, new URL(req.url).searchParams)));
