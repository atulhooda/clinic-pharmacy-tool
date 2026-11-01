// The delivery editor's live checks (R12-1), kept apart from the component so they run under node:test:
// the form's lines as the rules read them, and what posting would say about the screen now.
import { liveChecks, type Problem, type RuleLine, type ScreenLine } from '@/lib/stock/receipt-rules';
import { parseRupees } from './format';
import type { ItemOpt, Unit } from './catalogue';

export type ApiLine = { itemId: string; purchaseUnitId: string; qty: number; freeQty: number; batchNo: string | null; expiry: string | null; mfgDate: string | null; mrpPaise: number | null;
  mrpUnitId: string | null; purchaseRatePaise: number; discountPaise: number; gstRateBp: number | null; manufacturerName: string | null; manufacturerAddress: string | null;
  lineNo: number; itemName: string; baseUnit: string; purchaseUnitName: string; receivedBase: number; valuePaise: number; gstPaise: number };
export type Grn = { id: string; status: 'DRAFT' | 'POSTED' | 'REVERSED' | 'DISCARDED'; supplierId: string; supplierName: string; supplierLicenceStatus: string;
  invoiceNo: string; invoiceDate: string; invoiceTotalPaise: number | null; notes: string | null; postedAt: string | null; lines: ApiLine[];
  valuePaise: number; gstPaise: number; totalPaise: number; checks: { errors: Problem[]; warnings: Problem[] } | null;
  checkContext: { manufacturerRequired: boolean; today: string; nearExpiryBy: string } | null };
/** `saved`: the line's number in the last saved draft (null if added since); `mfgDate` is carried, not edited here. */
export type Form = { key: string; saved: number | null; mfgDate: string; itemId: string | null; purchaseUnitId: string | null; qty: string; freeQty: string; batchNo: string; expiry: string; mrp: string;
  mrpUnitId: string | null; rate: string; discount: string; gst: string; mfrName: string; mfrAddress: string };

export type Maker = { mfrName: string | null; mfrAddress: string | null };
export const onFile = (i: ItemOpt | undefined): Maker | null => (i ? { mfrName: i.manufacturerName ?? null, mfrAddress: i.manufacturerAddress ?? null } : null);
const digits = (v: string) => (/^\d+$/.test(v) ? Number(v) : 0);

/** A line as the rules read it (R12-1). Lenient: a field not yet valid counts as empty; Save reports the field itself. */
export function ruleLine(l: Form): RuleLine {
  const mrp = l.mrp ? parseRupees(l.mrp) : null;
  return { qty: digits(l.qty), freeQty: digits(l.freeQty), batchNo: l.batchNo.trim() || null, expiry: l.expiry.trim() || null, mfgDate: l.mfgDate.trim() || null,
    mrpPaise: mrp || null, mrpUnitId: mrp ? (l.mrpUnitId ?? l.purchaseUnitId) : null, purchaseRatePaise: (l.rate ? parseRupees(l.rate) : 0) ?? 0,
    discountPaise: (l.discount ? parseRupees(l.discount) : 0) ?? 0, manufacturerName: l.mfrName.trim() || null, manufacturerAddress: l.mfrAddress.trim() || null };
}

/** What posting would say about the form on screen: the server's last answer, with every rule it can run here re-run now. */
export function screenChecks(grn: Grn, head: { supplierId: string; invoiceNo: string; invoiceDate: string }, lines: readonly Form[],
  itemById: ReadonlyMap<string, ItemOpt>, units: Readonly<Record<string, Unit[]>>) {
  const screen: ScreenLine[] = lines.map((l) => {
    const line = ruleLine(l);
    const was = l.saved === null ? undefined : grn.lines[l.saved - 1];
    const sameAsSaved = !!was && was.itemId === l.itemId && was.purchaseUnitId === l.purchaseUnitId && (was.batchNo ?? null) === line.batchNo
      && (was.expiry ?? null) === line.expiry && (was.mrpPaise ?? null) === line.mrpPaise && (was.mrpUnitId ?? null) === line.mrpUnitId;
    const item = l.itemId ? itemById.get(l.itemId) : undefined;
    const unit = l.itemId && l.purchaseUnitId ? units[l.itemId]?.find((u) => u.id === l.purchaseUnitId) : undefined;
    const facts = item && unit && item.trackBatches !== undefined ? {
      item: { category: item.category, trackBatches: item.trackBatches, active: item.active, mfrName: item.manufacturerName ?? null, mfrAddress: item.manufacturerAddress ?? null },
      unit: { factor: unit.baseUnitsPerUnit, purchasable: unit.purchasable, active: unit.active },
    } : null;
    return { savedLineNo: l.saved, sameAsSaved, line, facts };
  });
  return liveChecks({ server: grn.checks, ctx: grn.checkContext, lines: screen,
    header: { invoiceDate: head.invoiceDate, changed: head.supplierId !== grn.supplierId || head.invoiceNo.trim() !== grn.invoiceNo } });
}

