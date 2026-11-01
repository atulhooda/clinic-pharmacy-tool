/**
 * A delivery line's posting rules as pure functions (06a §9.3 post_grn; MR-04, MR-08, MR-09; §11.3).
 * No database and no Node imports: the server's checks (receipts.ts) and the delivery editor
 * (GrnEditor) run THIS code, so what the screen says and what posting enforces cannot drift
 * apart (R12-1). Facts only the database knows (a stored batch's MRP, the premises' licences)
 * come in precomputed; the editor leaves them out and keeps the server's last answer for them.
 */
export interface Problem { code: string; lineNo?: number }

/** §11.3: `MM/YYYY` (or `MM/YY`) is the last day of that month; a full date is kept as is. */
export function parseExpiry(text: string): { date: string; printed: string | null } | null {
  const t = text.trim();
  let m = /^(\d{1,2})\s*[/-]\s*(\d{4}|\d{2})$/.exec(t);
  if (m) {
    const month = Number(m[1]);
    const year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
    if (month < 1 || month > 12 || year < 2000 || year > 2099) return null;
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { date: `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`, printed: t };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) {
    const d = new Date(`${t}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t) return null;
    return { date: t, printed: null };
  }
  return null;
}

/** MR-04 applies to these categories: their purchase record names the manufacturer and address. */
export const needsManufacturer = (category: string): boolean => category === 'MEDICINE' || category === 'INJECTABLE';

/** What a line says (manufacturer fields trimmed, blank = null). */
export interface RuleLine {
  qty: number;
  freeQty: number;
  batchNo: string | null;
  expiry: string | null;
  mfgDate: string | null;
  mrpPaise: number | null;
  mrpUnitId: string | null;
  purchaseRatePaise: number;
  discountPaise: number;
  manufacturerName: string | null;
  manufacturerAddress: string | null;
}
export interface LineFacts {
  item: { category: string; trackBatches: boolean; active: boolean; mfrName: string | null; mfrAddress: string | null };
  unit: { factor: number; purchasable: boolean; active: boolean };
  /** Database-only facts. `undefined` means "not evaluated here" (the editor), never "fine". */
  mrpMismatch?: boolean;
  ndpsBlocked?: boolean;
  xBlocked?: boolean;
}
export interface RuleContext {
  /** MR-04 is in force (an RMP premises). */
  manufacturerRequired: boolean;
  /** IST today and the first near-expiry date, both `YYYY-MM-DD`. */
  today: string;
  nearExpiryBy: string;
  /** Tests only (06b DL-19). */
  skipExpiryPrecheck?: boolean;
}

/** The codes a line can be given only with database facts; the editor keeps the server's answer for them. */
export const SERVER_ONLY_LINE_CODES: ReadonlySet<string> = new Set(['BATCH_MRP_MISMATCH', 'LICENCE_REQUIRED_NDPS', 'LICENCE_REQUIRED_SCHEDULE_X']);

/** One line's errors and warnings, in the order posting reports them (the first error decides the status). */
export function lineProblems(l: RuleLine, f: LineFacts, ctx: RuleContext): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!f.item.active) errors.push('ITEM_INACTIVE');
  if (!f.unit.purchasable || !f.unit.active) errors.push('UNIT_NOT_PURCHASABLE');
  if ((l.qty + l.freeQty) * f.unit.factor > 2_000_000_000) errors.push('QTY_TOO_LARGE');
  if (l.discountPaise > l.qty * l.purchaseRatePaise) errors.push('DISCOUNT_EXCEEDS_GROSS');
  if (f.item.trackBatches) {
    const exp = l.expiry ? parseExpiry(l.expiry) : null;
    if (!l.batchNo || !exp || !l.mrpPaise || !l.mrpUnitId) errors.push('BATCH_DETAILS_REQUIRED');
    if (exp && exp.date < ctx.today && !ctx.skipExpiryPrecheck) errors.push('BATCH_EXPIRED');
    else if (exp && exp.date <= ctx.nearExpiryBy) warnings.push('NEAR_EXPIRY_ON_ARRIVAL');
    const mfg = l.mfgDate ? parseExpiry(l.mfgDate) : null;
    if (mfg && exp && mfg.date > exp.date) errors.push('MFG_AFTER_EXPIRY');
    // OQ-15: an existing batch keeps its MRP (the server compares it per base unit).
    if (f.mrpMismatch) errors.push('BATCH_MRP_MISMATCH');
  } else if (l.batchNo || l.expiry) {
    errors.push('BATCH_NOT_TRACKED');
  }
  // MR-04: a medicine's purchase record names its manufacturer and their address (line → item → master).
  if (ctx.manufacturerRequired && needsManufacturer(f.item.category)
      && !((l.manufacturerName ?? f.item.mfrName) && (l.manufacturerAddress ?? f.item.mfrAddress))) {
    errors.push('MANUFACTURER_DETAILS_MISSING');
  }
  // MR-08, MR-09: this premises' own licences, in date today.
  if (f.ndpsBlocked) errors.push('LICENCE_REQUIRED_NDPS');
  if (f.xBlocked) errors.push('LICENCE_REQUIRED_SCHEDULE_X');
  return { errors, warnings };
}

// ---------------------------------------------------------------- the editor's live view (R12-1)

/** A line as it is on screen, ready for the rules. */
export interface ScreenLine {
  /** The line number this line had in the last saved draft, or null for a line added since. */
  savedLineNo: number | null;
  /** Item, pack, batch, expiry and MRP are as saved (what the server-only checks read). */
  sameAsSaved: boolean;
  line: RuleLine;
  /** Null while the item or its packs are not known on screen (nothing picked yet, or still loading). */
  facts: LineFacts | null;
}

/** Header problems that are recomputed here; the rest are the server's and go stale when the header changes. */
const LOCAL_HEADER_CODES = new Set(['GRN_EMPTY', 'INVOICE_DATE_IN_FUTURE']);

/**
 * The posting checks for what is on screen now. The server's answer (from the last save) is the
 * starting point; every rule `lineProblems` can evaluate without the database is recomputed from
 * the screen, so a fixed field clears its problem as it is typed. Server-only problems are kept
 * for lines (and a header) that have not changed since the save, and moved with their line when
 * lines are removed. `recheck` is true when something on screen has not been checked by the
 * server yet (Save or Post does that; Post always saves first and the server has the last word).
 */
export function liveChecks(args: {
  server: { errors: Problem[]; warnings: Problem[] } | null;
  ctx: RuleContext | null;
  header: { invoiceDate: string; changed: boolean };
  lines: readonly ScreenLine[];
}): { errors: Problem[]; warnings: Problem[]; recheck: boolean } {
  const { server, ctx, header, lines } = args;
  const sErrors = server?.errors ?? [];
  const sWarnings = server?.warnings ?? [];
  const errors: Problem[] = [];
  const warnings: Problem[] = [];
  let recheck = header.changed;
  // A check that could not run at all on the server (a reference that no longer resolves) has no context: show the server's answer.
  if (!ctx) return { errors: sErrors, warnings: sWarnings, recheck: true };

  if (lines.length === 0) errors.push({ code: 'GRN_EMPTY' });
  if (header.invoiceDate && header.invoiceDate > ctx.today) errors.push({ code: 'INVOICE_DATE_IN_FUTURE' });
  if (!header.changed) {
    errors.push(...sErrors.filter((p) => p.lineNo === undefined && !LOCAL_HEADER_CODES.has(p.code)));
    warnings.push(...sWarnings.filter((p) => p.lineNo === undefined));
  }

  lines.forEach((s, i) => {
    const lineNo = i + 1;
    const fromServer = (list: Problem[]) => (s.savedLineNo === null ? [] : list.filter((p) => p.lineNo === s.savedLineNo));
    const keep = s.savedLineNo !== null && s.sameAsSaved;
    if (!keep) recheck = true;
    if (!s.facts) {
      // Nothing to evaluate on screen: the server's answer while the line is unchanged, else wait for a save.
      if (keep) {
        errors.push(...fromServer(sErrors).map((p) => ({ code: p.code, lineNo })));
        warnings.push(...fromServer(sWarnings).map((p) => ({ code: p.code, lineNo })));
      }
      return;
    }
    const local = lineProblems(s.line, { item: s.facts.item, unit: s.facts.unit }, ctx);
    errors.push(...local.errors.map((code) => ({ code, lineNo })));
    warnings.push(...local.warnings.map((code) => ({ code, lineNo })));
    if (keep) {
      errors.push(...fromServer(sErrors).filter((p) => SERVER_ONLY_LINE_CODES.has(p.code)).map((p) => ({ code: p.code, lineNo })));
      warnings.push(...fromServer(sWarnings).filter((p) => SERVER_ONLY_LINE_CODES.has(p.code)).map((p) => ({ code: p.code, lineNo })));
    }
  });
  return { errors, warnings, recheck };
}

/**
 * The manufacturer fields of a line when its item changes (R12-3): each field takes the new
 * item's value on file, unless the person typed something of their own there. A field still
 * blank, or still showing the previous item's value, is theirs to overwrite; anything else is kept.
 */
export function makerOnPick(
  cur: { mfrName: string; mfrAddress: string },
  prev: { mfrName: string | null; mfrAddress: string | null } | null,
  next: { mfrName: string | null; mfrAddress: string | null } | null,
): { mfrName: string; mfrAddress: string } {
  const field = (now: string, was: string | null | undefined, onFile: string | null | undefined) =>
    (now.trim() === '' || (was && now.trim() === was.trim()) ? (onFile ?? '') : now);
  return { mfrName: field(cur.mfrName, prev?.mfrName, next?.mfrName), mfrAddress: field(cur.mfrAddress, prev?.mfrAddress, next?.mfrAddress) };
}
