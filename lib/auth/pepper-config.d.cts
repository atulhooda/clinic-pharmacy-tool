export type PepperConfig = { ok: true; peppers: Map<number, Buffer>; current: number } | { ok: false; check: string };
export function parsePeppers(raw: string | undefined): PepperConfig;
export function missingVersions(inUse: { version: number }[], peppers: Map<number, Buffer>): number[];
export const CENSUS_SQL: string;
