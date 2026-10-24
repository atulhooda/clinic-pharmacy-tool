/**
 * Plain-text display helpers shared by the screens and the server's CSV and print views
 * (06a §14): quantities in base units with packs alongside, IST dates. No money here (lib/money.ts).
 */
export interface PackUnit { name: string; baseUnitsPerUnit: number; isBase: boolean; active: boolean }

const PLURAL_LESS = new Set(['ml', 'g']);
export function unitWord(n: number, unit: string): string {
  const u = unit.toLowerCase();
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
