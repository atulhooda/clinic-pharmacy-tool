import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { grantFromRequest } from '@/lib/auth/reauth';
import { getOrgSettings, putOrgSettings } from '@/lib/admin/org-settings';

export const dynamic = 'force-dynamic';

/** M-01 GET: the organisation's security settings, with the version as ETag. */
export const GET = withSession({ permission: 'org.settings' }, async (_req, _ctx, s) => {
  const o = await getOrgSettings(s);
  return json(o, { headers: { etag: `"${o.version}"` } });
});

/** M-01 PUT: lock minutes (1–10), day reset (HH:MM IST), untrusted idle (5–720 or null). `If-Match` and an `org.settings` grant. */
export const PUT = withSession({ permission: 'org.settings', idempotent: { status: 200, replay: (s) => getOrgSettings(s) } }, async (req, _ctx, s) => {
  const body = await strictBody(req, {
    deviceLockMinutes: { type: 'int', min: 1, max: 10 },
    dayResetTimeIst: { type: 'string', pattern: /^([01][0-9]|2[0-3]):[0-5][0-9]$/ },
    untrustedIdleMinutes: { type: 'int', min: 5, max: 720, nullable: true },
  });
  const o = await putOrgSettings(s, body, req.headers.get('if-match'), grantFromRequest(req));
  return json(o, { headers: { etag: `"${o.version}"` } });
});
