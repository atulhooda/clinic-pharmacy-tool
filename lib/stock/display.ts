/**
 * Plain-text display helpers shared by the screens and the server's CSV and print views
 * (06a §14): quantities in base units with packs alongside, IST dates. No money here (lib/money.ts).
 */
export interface PackUnit { name: string; baseUnitsPerUnit: number; isBase: boolean; active: boolean }

const PLURAL_LESS = new Set(['ml', 'g']);
/** A unit as people read it: lower case, and PIECE is "unit" (032, founder 2026-11-11: "keep unit, not pieces"). */
/**
 * D-69: the units a person counts or prices in. The clinic counts strips, bottles, tubes and units: a
 * tablet, capsule, ml or g base unit is offered only when the item has no pack, and a box only when it has no strip.
 */
export function countUnits<U extends PackUnit>(units: readonly U[]): U[] {
  const active = units.filter((u) => u.active);
  const packs = active.filter((u) => !u.isBase && u.baseUnitsPerUnit > 1);
  const hasStrip = packs.some((u) => /strip/i.test(u.name));
  const shown = active.filter((u) => (u.isBase ? packs.length === 0 || !/^(tablet|capsule|ml|g)$/i.test(u.name) : !(hasStrip && /box/i.test(u.name))));
  return shown.length ? shown : active;
}

export function unitName(unit: string): string {
  const u = unit.toLowerCase();
  return u === 'piece' ? 'unit' : u;
}
export function unitWord(n: number, unit: string): string {
  const u = unitName(unit);
  if (n === 1 || n === -1 || PLURAL_LESS.has(u)) return `${n} ${u}`;
  return `${n} ${/(s|x|z|ch|sh)$/.test(u) ? `${u}es` : `${u}s`}`;
}

/** "1 box + 5 strips + 3 tablets": the active packs, largest first, then the loose base units. */
export function packs(base: number, baseUnit: string, units: readonly PackUnit[] = []): string {
  const sizes = units.filter((u) => !u.isBase && u.active && u.baseUnitsPerUnit > 1).sort((a, b) => b.baseUnitsPerUnit - a.baseUnitsPerUnit);
  const parts: string[] = [];
  let left = base;
  for (const u of sizes) {
    const whole = Math.trunc(left / u.baseUnitsPerUnit);
    if (whole === 0) continue;
    parts.push(unitWord(whole, u.name));
    left -= whole * u.baseUnitsPerUnit;
  }
  if (left !== 0 || parts.length === 0) parts.push(unitWord(left, baseUnit));
  return parts.join(' + ');
}

/** `DD-MM-YYYY HH:mm` in IST. */
export function istDateTime(iso: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}`;
}

/** `DD-MM-YYYY` for an ISO date. */
export const dmy = (d: string): string => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;

/** The pack sizes a printed pack names, most likely first: "1*15" → [15, 15], "10*10" → [10, 100], "60GM" → [60]. */
export function packSizes(pack: string | null): number[] {
  if (!pack) return [];
  const star = /(\d+)\s*[*x×]\s*(\d+)/i.exec(pack);
  if (star) return [Number(star[2]), Number(star[1]) * Number(star[2])];
  const n = /(\d+)/.exec(pack);
  return n ? [Number(n[1])] : [];
}

/**
 * D-67: what a Desk sales bill header says about its people. The patient's name and the doctor when there are
 * any; otherwise a note: `hidden` when the desk sent a patient the caller may not see (06a §4.3), `none` when the
 * desk sent no name and no doctor (a desk patient id alone means nothing to pharmacy staff, so it is never shown).
 */
export function deskBillParty(b: { patientName: string | null; patientHidden?: boolean; doctorName: string | null }):
  { patient: string | null; doctor: string | null; note: 'hidden' | 'none' | null } {
  const note = b.patientHidden ? 'hidden' : !b.patientName && !b.doctorName ? 'none' : null;
  return { patient: b.patientName || null, doctor: b.doctorName || null, note };
}
