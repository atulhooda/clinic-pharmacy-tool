import { withTenant } from '../db/tenant';
import { HttpError } from '../http/errors';
import { log } from '../log';
import type { Session } from '../auth/guard';
import { parseExpiry } from './receipts';
import { packSizes } from './display';

export { packSizes };

/**
 * Reading a supplier's bill from a photo (D-51; 06a §0 principle 7's one exception; E-51).
 *
 * - The model (R8-10) only transcribes, through one forced tool, `record_bill`.
 * - Everything it returns is cleaned field by field here; a field that does not fit becomes null
 *   and is flagged, so nothing malformed reaches a draft.
 * - The app, not the model, decides what the text refers to (R8-11): the supplier by GSTIN then
 *   name, each line's item by trigram similarity, the pack by its size.
 * - Nothing is written (R8-12). The log line holds counts and a duration only (R8-13).
 */
export const MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type Media = (typeof MEDIA)[number];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 8 * 1024 * 1024;
const DEFAULT_MODEL = 'claude-opus-5-5';

/** The media type from the file's first bytes; the declared type is not trusted. */
export function sniff(b: Uint8Array): Media | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (String.fromCharCode(...b.slice(0, 5)) === '%PDF-') return 'application/pdf';
  return null;
}

const PROMPT = `This is one supplier's invoice (a bill) to an Indian clinic's pharmacy. Transcribe it with the record_bill tool.
- Copy every value exactly as printed. Use null for anything not printed or not legible. Never guess, compute or correct.
- One entry in "lines" per product line, in printed order. "name" is the product as printed (e.g. "ABC 500 TAB").
- "pack" is the pack size as printed (e.g. "10 TAB", "60GM", "1*15"). "qty" is the billed quantity and "free" the free quantity, as integers.
- Money is in rupees exactly as printed, as text (e.g. "45.50"): "mrp" the MRP, "rate" the purchase rate, "discount" the line's discount amount.
- "gstPercent" is the line's total GST rate in percent (CGST + SGST, or IGST).
- "expiry" exactly as printed (e.g. "11/27"). The invoice date as YYYY-MM-DD.
- Ignore totals, bank details, addresses, signatures and any patient information.`;

const nullableString = { type: ['string', 'null'] };
export const RECORD_BILL = {
  name: 'record_bill',
  description: "Record what is printed on the supplier's bill, exactly as printed.",
  input_schema: {
    type: 'object',
    properties: {
      supplier: { type: 'object', properties: { name: nullableString, gstin: nullableString, drugLicenceNumbers: { type: 'array', items: { type: 'string' } } } },
      invoice: { type: 'object', properties: { number: nullableString, date: { type: ['string', 'null'], description: 'YYYY-MM-DD' } } },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' }, pack: nullableString, hsn: nullableString, batch: nullableString, expiry: nullableString,
            qty: { type: ['integer', 'null'] }, free: { type: ['integer', 'null'] },
            mrp: nullableString, rate: nullableString, discount: nullableString, gstPercent: { type: ['number', 'null'] },
          },
          required: ['name'],
        },
      },
    },
    required: ['lines'],
  },
} as const;

/** The Messages API request (06b DBR-08). */
export function buildRequest(model: string, media: Media, base64: string) {
  const source = { type: 'base64', media_type: media, data: base64 };
  return {
    model,
    max_tokens: 8192,
    tools: [RECORD_BILL],
    tool_choice: { type: 'tool', name: 'record_bill' },
    messages: [{ role: 'user', content: [media === 'application/pdf' ? { type: 'document', source } : { type: 'image', source }, { type: 'text', text: PROMPT }] }],
  };
}

type Reader = (media: Media, base64: string) => Promise<unknown>;

/** The real reader: Anthropic's Messages API (R8-10). Returns the tool's input, unchecked. */
const anthropic: Reader = async (media, base64) => {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(buildRequest(process.env.BILL_READER_MODEL || DEFAULT_MODEL, media, base64)),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new HttpError(502, 'BILL_READ_FAILED', 'The bill could not be read. Try again, or type it in.', { upstream: r.status });
  const body = (await r.json()) as { content?: { type: string; name?: string; input?: unknown }[] };
  return body.content?.find((c) => c.type === 'tool_use' && c.name === 'record_bill')?.input ?? null;
};
let reader: Reader = anthropic;

/** Tests only (06b §24.2): replace the network call with a fixed transcription. */
export function setBillReaderForTests(fake: Reader | null): void {
  reader = fake ?? anthropic;
}

export interface ReadLine {
  name: string;
  pack: string | null;
  hsn: string | null;
  batch: string | null;
  expiry: string | null;
  qty: number | null;
  free: number | null;
  mrpPaise: number | null;
  ratePaise: number | null;
  discountPaise: number | null;
  gstRateBp: number | null;
  /** Fields that were present but did not fit, and so were dropped. */
  flags: string[];
}
export interface ReadBill {
  supplier: { name: string | null; gstin: string | null; drugLicenceNumbers: string[] };
  invoice: { number: string | null; date: string | null };
  lines: ReadLine[];
  /** Lines without a readable name, left out. */
  skipped: number;
  flags: string[];
}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim().replace(/\s+/g, ' ') : null);
/** "1,234.50" or 1234.5 → paise, by string arithmetic. */
export function rupeesToPaise(v: unknown): number | null {
  const s = typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : typeof v === 'string' ? v.replace(/[₹,\s]/g, '') : null;
  const m = s ? /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s) : null;
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0')) : null;
}

/** DBR-06: clean the model's answer; each misfit field becomes null and is flagged. */
export function cleanBill(raw: unknown): ReadBill {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!Array.isArray(o.lines)) throw new HttpError(502, 'BILL_READ_FAILED', 'No lines could be read from that bill. Try a clearer photo, or type it in.');
  const flags: string[] = [];
  const sup = (o.supplier && typeof o.supplier === 'object' ? o.supplier : {}) as Record<string, unknown>;
  const inv = (o.invoice && typeof o.invoice === 'object' ? o.invoice : {}) as Record<string, unknown>;
  const gstin = text(sup.gstin, 20)?.toUpperCase().replace(/\s/g, '') ?? null;
  const validGstin = gstin && /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/.test(gstin) ? gstin : null;
  if (gstin && !validGstin) flags.push('supplier.gstin');
  const date = text(inv.date, 10);
  const validDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) && parseExpiry(date) ? date : null;
  if (date && !validDate) flags.push('invoice.date');
  let skipped = 0;
  const lines: ReadLine[] = [];
  for (const r of o.lines.slice(0, 200)) {
    const l = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const name = text(l.name, 200);
    if (!name) { skipped++; continue; }
    const f: string[] = [];
    const keep = <T>(key: string, value: T | null, present: boolean): T | null => { if (present && value === null) f.push(key); return value; };
    const int = (v: unknown, min: number) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= 1_000_000 ? v : null);
    const has = (k: string) => l[k] !== null && l[k] !== undefined && l[k] !== '';
    const expiry = text(l.expiry, 20);
    const hsn = text(l.hsn, 12)?.replace(/\s/g, '') ?? null;
    // A percentage with at most two decimals (2.5 → 250 bp), between 0 and 28.
    const bp = typeof l.gstPercent === 'number' ? Math.round(l.gstPercent * 100) : NaN;
    const gst = bp >= 0 && bp <= 2800 && Math.abs((l.gstPercent as number) * 100 - bp) < 1e-6 ? bp : null;
    lines.push({
      name,
      pack: text(l.pack, 40),
      hsn: keep('hsn', hsn && /^\d{4,8}$/.test(hsn) ? hsn : null, has('hsn')),
      batch: keep('batch', text(l.batch, 40), has('batch')),
      expiry: keep('expiry', expiry && parseExpiry(expiry) ? expiry : null, has('expiry')),
      qty: keep('qty', int(l.qty, 1), has('qty')),
      free: keep('free', int(l.free, 0), has('free')),
      mrpPaise: keep('mrp', rupeesToPaise(l.mrp), has('mrp')),
      ratePaise: keep('rate', rupeesToPaise(l.rate), has('rate')),
      discountPaise: keep('discount', rupeesToPaise(l.discount), has('discount')),
      gstRateBp: keep('gstPercent', gst, has('gstPercent')),
      flags: f,
    });
  }
  if (lines.length === 0) throw new HttpError(502, 'BILL_READ_FAILED', 'No lines could be read from that bill. Try a clearer photo, or type it in.');
  return {
    supplier: { name: text(sup.name, 120), gstin: validGstin, drugLicenceNumbers: Array.isArray(sup.drugLicenceNumbers) ? sup.drugLicenceNumbers.map((x) => text(x, 60)).filter((x): x is string => !!x).slice(0, 10) : [] },
    invoice: { number: text(inv.number, 40), date: validDate },
    lines, skipped, flags,
  };
}


export interface Candidate { id: string; name: string; score: number }
export interface Proposal {
  supplier: ReadBill['supplier'] & { matchId: string | null; candidates: Candidate[] };
  invoice: ReadBill['invoice'];
  lines: (ReadLine & { itemId: string | null; candidates: Candidate[]; purchaseUnitId: string | null })[];
  skipped: number;
  flags: string[];
}
const PRESELECT = 45;

/** R8-11: what the text refers to, in this organisation only. Scores are whole percentages. */
export async function match(s: Session, bill: ReadBill): Promise<Proposal> {
  return withTenant(s.orgId, async (db) => {
    let matchId: string | null = null;
    let candidates: Candidate[] = [];
    if (bill.supplier.gstin) {
      const byGstin = await db.rows<{ id: string; name: string }>('SELECT id, name FROM suppliers WHERE org_id = $1 AND gstin = $2', [s.orgId, bill.supplier.gstin]);
      if (byGstin[0]) { matchId = byGstin[0].id; candidates = [{ ...byGstin[0], score: 100 }]; }
    }
    if (!matchId && bill.supplier.name) {
      candidates = await db.rows<Candidate>(
        `SELECT id, name, round(similarity(lower(name), lower($2)) * 100)::int AS score FROM suppliers
          WHERE org_id = $1 AND active AND similarity(lower(name), lower($2)) >= 0.2 ORDER BY score DESC, lower(name) LIMIT 3`, [s.orgId, bill.supplier.name]);
      if (candidates[0] && candidates[0].score >= PRESELECT) matchId = candidates[0].id;
    }
    const lines = [];
    for (const l of bill.lines) {
      const cands = await db.rows<Candidate>(
        `SELECT id, display_name AS name, round(similarity(lower(display_name), lower($2)) * 100)::int AS score FROM items
          WHERE org_id = $1 AND active AND similarity(lower(display_name), lower($2)) >= 0.2 ORDER BY score DESC, lower(display_name) LIMIT 3`, [s.orgId, l.name]);
      const itemId = cands[0] && cands[0].score >= PRESELECT ? cands[0].id : null;
      let purchaseUnitId: string | null = null;
      if (itemId) {
        const units = await db.rows<{ id: string; factor: number; isBase: boolean }>(
          `SELECT id, base_units_per_unit AS factor, is_base AS "isBase" FROM item_units WHERE org_id = $1 AND item_id = $2 AND active AND purchasable
            ORDER BY base_units_per_unit DESC`, [s.orgId, itemId]);
        const sizes = packSizes(l.pack);
        purchaseUnitId = (sizes.map((n) => units.find((u) => u.factor === n)).find(Boolean) ?? units.find((u) => !u.isBase) ?? units[0])?.id ?? null;
      }
      lines.push({ ...l, itemId, candidates: cands, purchaseUnitId });
    }
    return { supplier: { ...bill.supplier, matchId, candidates }, invoice: bill.invoice, lines, skipped: bill.skipped, flags: bill.flags };
  });
}

/** E-51: read one bill and propose a draft. Writes nothing. */
export async function readBill(s: Session, media: Media, bytes: Uint8Array): Promise<Proposal> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new HttpError(503, 'BILL_READER_NOT_CONFIGURED', 'Reading bills from a photo is not set up here. Type the delivery in instead.');
  }
  const started = Date.now();
  const raw = await reader(media, Buffer.from(bytes).toString('base64'));
  const proposal = await match(s, cleanBill(raw));
  log('bill_read', { media, lines: proposal.lines.length, matched: proposal.lines.filter((l) => l.itemId).length, skipped: proposal.skipped, ms: Date.now() - started });
  return proposal;
}
