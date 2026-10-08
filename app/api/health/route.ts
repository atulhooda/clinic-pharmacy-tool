import { getSchemaStatus } from '@/lib/db/selfcheck';
import { json } from '@/lib/http/api';

export const dynamic = 'force-dynamic';

/**
 * 06a §12.3: public; returns only {ok, schemaVerified}. It is the one /api route not
 * behind the self-check gate, so an operator can see why everything else answers 503.
 */
export async function GET(): Promise<Response> {
  const status = await getSchemaStatus();
  return json({ ok: true, schemaVerified: status.ok });
}
