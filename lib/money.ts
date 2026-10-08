/**
 * Money at the edges (06a §5, D-5): integer paise in, text out. Formatting is by integer
 * arithmetic on the digits, never by dividing, so no float ever touches an amount. Rupees use
 * Indian grouping (1,23,456.78) with Latin digits.
 */
export function fmtPaise(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new RangeError('fmtPaise: an integer number of paise');
  const digits = String(Math.abs(paise)).padStart(3, '0');
  const rupees = digits.slice(0, -2);
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${paise < 0 ? '−' : ''}₹${rest ? `${rest},` : ''}${last3}.${digits.slice(-2)}`;
}
