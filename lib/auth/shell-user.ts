import type { Session } from './guard';

/** What the shell shows about the signed-in person: plain, serialisable, no ids beyond the slug. */
export interface ShellUser {
  name: string;
  role: string;
  orgName: string;
  orgSlug: string;
  /** The premises this screen works at: the trusted PC's, else the person's first. */
  premisesName: string | null;
  deviceName: string | null;
  lockMinutes: number | null;
  permissions: string[];
}

export function shellUser(s: Session): ShellUser {
  const premises = s.device ? s.premises.find((p) => p.id === s.device!.premisesId) ?? null : s.premises[0] ?? null;
  return {
    name: s.name,
    role: s.roleKey,
    orgName: s.orgName,
    orgSlug: s.orgSlug,
    premisesName: premises?.name ?? null,
    deviceName: s.device?.name ?? null,
    lockMinutes: s.lockMinutes,
    permissions: [...s.permissions],
  };
}
