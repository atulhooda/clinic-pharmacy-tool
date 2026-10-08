import { json } from '@/lib/http/api';
import { withSession } from '@/lib/http/session-route';
import { listAudit } from '@/lib/admin/audit-view';

export const dynamic = 'force-dynamic';

/** M-12: the audit log, `?from=&to=&action=&staffId=&limit=&cursor=`, newest first. */
export const GET = withSession({ permission: 'audit.view' }, async (req, _ctx, s) => json(await listAudit(s, new URL(req.url).searchParams)));
