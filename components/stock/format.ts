import { en } from '@/lib/i18n/en';

export { dmy, istDateTime, packs, unitWord, type PackUnit } from '@/lib/stock/display';

export const movementLabel = (type: string): string => (en.stock.movement as Record<string, string>)[type] ?? type;

/** "45.50" or "45" → 4550 paise, by string arithmetic (no floats); null for anything else. */
export function parseRupees(text: string): number | null {
  const m = /^\s*(\d{1,9})(?:\.(\d{1,2}))?\s*$/.exec(text.replace(/[₹,]/g, ''));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}
