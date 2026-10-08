import { gated, json } from '@/lib/http/api';
import { HttpError } from '@/lib/http/errors';
import { resolveOrgBySlug } from '@/lib/db/orgs';

export const dynamic = 'force-dynamic';

/**
 * A-01 (06a §12.3): the sign-in context. Public. Returns the organisation's slug and display
 * name, never an id. The trusted-device part arrives with PR 3.
 */
export const GET = gated(async (req: Request) => {
  const slug = new URL(req.url).searchParams.get('org') ?? '';
  const org = await resolveOrgBySlug(slug);
  if (!org) throw new HttpError(404, 'ORG_NOT_FOUND', 'No organisation uses that sign-in link.');
  return json({ org: { slug: org.slug, displayName: org.displayName }, trustedDevice: false });
});
