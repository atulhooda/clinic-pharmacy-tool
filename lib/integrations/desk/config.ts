/**
 * The desk sync switch (06a §12.5, D-57). On only when all three are set:
 * - DESK_SYNC_KEY: the shared HMAC key, at least 32 characters (a shorter key keeps it off);
 * - DESK_SYNC_ORG_SLUG: the organisation the desk's bills belong to;
 * - DESK_SYNC_PREMISES_ID: the premises whose default store they draw on.
 * The organisation and premises come ONLY from here, never from a request. Off, every
 * /api/integrations/desk/** route answers 404, as if it did not exist.
 */
export interface DeskSyncConfig {
  key: string;
  orgSlug: string;
  premisesId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MIN_KEY_LENGTH = 32;

export function deskSyncConfig(env: NodeJS.ProcessEnv = process.env): DeskSyncConfig | null {
  const key = env.DESK_SYNC_KEY ?? '';
  const orgSlug = (env.DESK_SYNC_ORG_SLUG ?? '').trim().toLowerCase();
  const premisesId = (env.DESK_SYNC_PREMISES_ID ?? '').trim().toLowerCase();
  if (key.length < MIN_KEY_LENGTH || !orgSlug || !UUID.test(premisesId)) return null;
  return { key, orgSlug, premisesId };
}

/** Whether this organisation's screens show the desk's sales (the switch is on for it). */
export function deskSyncOnFor(orgSlug: string): boolean {
  return deskSyncConfig()?.orgSlug === orgSlug.toLowerCase();
}
