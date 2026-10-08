import { dmy, istDateTime, packs } from './display';
import type { Statement } from './statement';

/**
 * The stock statement's exports (06a §14): CSV in UTF-8 with a BOM, and an HTML print view whose
 * header block repeats on every printed page. Quantities are base units, with packs alongside.
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** A CSV text cell: quoted, and defused if a spreadsheet would read it as a formula. */
const cell = (s: string) => `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;

export function statementCsv(st: Statement): string {
  const head = ['Item', 'Category', 'Base unit', 'Opening', 'Received', 'Issued', 'Returned', 'Other', 'Balance', 'Of which quarantined', 'Balance in packs'];
  const lines = [
    [cell('Stock statement'), cell(`${dmy(st.from)} to ${dmy(st.to)}`), cell(st.premisesNames.join(' + ')), cell(`Generated ${istDateTime(st.generatedAt)} IST`)].join(','),
    head.map(cell).join(','),
    ...st.rows.map((r) => [cell(r.name), cell(r.category), cell(r.baseUnit.toLowerCase()), r.opening, r.received, r.issued, r.returned, r.other, r.balance,
      r.quarantined, cell(packs(r.balance, r.baseUnit, r.units))].join(',')),
  ];
  return `﻿${lines.join('\r\n')}\r\n`;
}

export interface PremisesHeader { name: string; address: string; stateCode: string; gstin: string | null; licences: string[] }

export function statementHtml(st: Statement, premises: readonly PremisesHeader[]): string {
  const num = (n: number) => `<td class="n">${n}</td>`;
  const rows = st.rows.map((r) => `<tr><td>${esc(r.name)}<span class="u">${esc(r.baseUnit.toLowerCase())}</span></td>${num(r.opening)}${num(r.received)}${num(r.issued)}${num(r.returned)}${num(r.other)}<td class="n b">${r.balance}<span class="u">${esc(packs(r.balance, r.baseUnit, r.units))}${r.quarantined ? ` · ${r.quarantined} quarantined` : ''}</span></td></tr>`).join('');
  const who = premises.map((p) => `<div><b>${esc(p.name)}</b> · ${esc(p.address)} · State ${esc(p.stateCode)}${p.gstin ? ` · GSTIN ${esc(p.gstin)}` : ''}${p.licences.length ? ` · Licences ${esc(p.licences.join(', '))}` : ''}</div>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stock statement ${dmy(st.from)} to ${dmy(st.to)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #111; background: #fff; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th, td { border-bottom: 1px solid #ddd; padding: 5px 6px; text-align: left; vertical-align: top; }
  th { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #555; }
  .n { text-align: right; font-variant-numeric: tabular-nums; }
  .b { font-weight: 700; }
  .u { display: block; font-weight: 400; color: #666; font-size: 10px; }
  .head td { border: 0; padding: 0 0 10px; }
  .meta { color: #444; }
  @page { size: A4 landscape; margin: 14mm; @bottom-right { content: "Page " counter(page) " of " counter(pages); font-size: 9px; } }
  @media print { body { margin: 0; } .noprint { display: none; } }
</style></head><body>
<button class="noprint" onclick="window.print()">Print</button>
<table>
<thead>
<tr class="head"><td colspan="7"><h1>Stock statement</h1><div class="meta">${who}<div>Period ${dmy(st.from)} to ${dmy(st.to)} · Generated ${istDateTime(st.generatedAt)} IST · Opening + Received − Issued + Returned + Other = Balance</div></div></td></tr>
<tr><th>Item</th><th class="n">Opening</th><th class="n">Received</th><th class="n">Issued</th><th class="n">Returned</th><th class="n">Other</th><th class="n">Balance</th></tr>
</thead>
<tbody>${rows || '<tr><td colspan="7">Nothing moved in this period.</td></tr>'}</tbody>
</table>
</body></html>`;
}

