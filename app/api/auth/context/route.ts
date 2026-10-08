import { gated, json } from '@/lib/http/api';
import { HttpError } from '@/lib/http/errors';
import { readCookie, ORG_COOKIE, orgCookie } from '@/lib/http/cookies';
import { resolveOrgBySlug } from '@/lib/db/orgs';
import { withTenant } from '@/lib/db/tenant';
import { deviceFromRequest, clearDeviceCookie } from '@/lib/auth/device';

export const dynamic = 'force-dynamic';

/**
 * A-01 (06a §2.4, §12.3): the sign-in context. Public. The organisation comes from a valid
 * trusted-device cookie, else `?org=<slug>`, else the `pharm_org` cookie. Returns names only,
 * never an id. A forged or revoked device cookie is ignored (06b DX-01).
 */
export const GET = gated(async (req: Request) => {
  const claim = await deviceFromRequest(req);
  if (claim) {
    const d = await withTenant(claim.org, async (db) => (await db.rows<{ slug: string; orgName: string; deviceName: string; premisesName: string }>(
      `SELECT o.slug, o.display_name AS "orgName", d.name AS "deviceName", p.name AS "premisesName"
         FROM devices d JOIN organisations o ON o.id = d.org_id JOIN premises p ON p.org_id = d.org_id AND p.id = d.premises_id
        WHERE d.org_id = $1 AND d.id = $2 AND d.revoked_at IS NULL AND o.status = 'ACTIVE'`, [claim.org, claim.deviceId]))[0]);
    if (d) {
      return json({ org: { slug: d.slug, displayName: d.orgName }, trustedDevice: true, device: { name: d.deviceName, premisesName: d.premisesName } });
    }
  }
  const slug = new URL(req.url).searchParams.get('org') ?? readCookie(req.headers.get('cookie'), ORG_COOKIE) ?? '';
  const org = await resolveOrgBySlug(slug);
  if (!org) throw new HttpError(404, 'ORG_NOT_FOUND', 'No organisation uses that sign-in link.');
  const headers = new Headers([['set-cookie', orgCookie(org.slug)]]);
  if (claim) headers.append('set-cookie', clearDeviceCookie());
  return json({ org: { slug: org.slug, displayName: org.displayName }, trustedDevice: false, device: null }, { headers });
});
