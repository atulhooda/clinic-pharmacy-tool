import { en } from '@/lib/i18n/en';

export interface PackUnit { name: string; baseUnitsPerUnit: number; isBase: boolean; active: boolean }

const PLURAL_LESS = new Set(['ml', 'g']);
export function unitWord(n: number, unit: string): string {
  const u = unit.toLowerCase();
  if (n === 1 || n === -1 || PLURAL_LESS.has(u)) return `${n} ${u}`;
  return `${n} ${/(s|x|z|ch|sh)$/.test(u) ? `${u}es` : `${u}s`}`;
}

/** A quantity in base units, with packs alongside where the item has them: "3 strips + 5 tablets" (06a §14). */
export function packs(base: number, baseUnit: string, units: readonly PackUnit[] = []): string {
  const pack = units.filter((u) => !u.isBase && u.active && u.baseUnitsPerUnit > 1).sort((a, b) => b.baseUnitsPerUnit - a.baseUnitsPerUnit)
    .find((u) => Math.abs(base) >= u.baseUnitsPerUnit);
  if (!pack) return unitWord(base, baseUnit);
  const whole = Math.trunc(base / pack.baseUnitsPerUnit);
  const loose = base - whole * pack.baseUnitsPerUnit;
  return loose === 0 ? unitWord(whole, pack.name) : `${unitWord(whole, pack.name)} + ${unitWord(loose, baseUnit)}`;
}

/** `DD-MM-YYYY HH:mm` in IST (06a §14). */
export function istDateTime(iso: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}`;
}

/** `DD-MM-YYYY` for an ISO date. */
export const dmy = (d: string): string => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;

export const movementLabel = (type: string): string => (en.stock.movement as Record<string, string>)[type] ?? type;
