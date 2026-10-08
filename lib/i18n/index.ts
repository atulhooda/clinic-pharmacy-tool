import { D, type Key } from './dict';

/** The dictionary mechanism copied with the UI kit from Ritu Desk (06a §16). */
export type Locale = 'en' | 'hi' | 'gu';
export type { Key };
const IDX: Record<Locale, 0 | 1 | 2> = { en: 0, hi: 1, gu: 2 };

/** Only reviewed languages are offered (see ./dict). Hindi and Gujarati await a native speaker's review. */
export const ENABLED_LOCALES: readonly Locale[] = ['en'];

export function t(locale: Locale, key: Key | string, vars?: Record<string, string | number>): string {
  const row = (D as Record<string, readonly [string, string, string]>)[key];
  let s = row ? row[IDX[locale]] || row[0] : key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
