import { json } from '@/lib/http/api';
import { emptyBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';

export const dynamic = 'force-dynamic';

/**
 * A-08 (06a §3.6): the real-input ping. The client sends it at most every 30 s while there is
 * keyboard, pointer or touch input; the guard records it as input. Background polls never call it.
 */
export const POST = withSession({ mutating: true }, async (req, _ctx, s) => {
  await emptyBody(req);
  return json({ ok: true, lockAt: s.lockAt?.toISOString() ?? null });
});
