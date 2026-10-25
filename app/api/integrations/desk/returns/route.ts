import { json } from '@/lib/http/api';
import { deskRoute } from '@/lib/integrations/desk/route';
import { parseReturns, postDeskReturns } from '@/lib/integrations/desk/sync';

export const dynamic = 'force-dynamic';

/**
 * E-54 (D-57): a credit note's lines put back what their bill lines took, never more,
 * idempotent per (creditNoteId, lineKey). Signed by the desk; 404 when the sync is off.
 */
export const POST = deskRoute(async (ctx, body) => json(await postDeskReturns(ctx, parseReturns(body))));
