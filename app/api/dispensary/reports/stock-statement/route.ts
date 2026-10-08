import { json } from '@/lib/http/api';
import { HttpError } from '@/lib/http/errors';
import { withSession } from '@/lib/http/session-route';
import { auditExport, premisesHeaders, stockStatement } from '@/lib/stock/statement';
import { statementCsv, statementHtml } from '@/lib/stock/statement-export';

export const dynamic = 'force-dynamic';

/**
 * E-45 (D-47): the stock statement, `?premisesId=&from=&to=&format=json|csv|print&all=`. No patient
 * data, so no signing grant; each CSV or print export is audited.
 */
export const GET = withSession({ permission: 'stock.view' }, async (req, _ctx, s) => {
  const q = new URL(req.url).searchParams;
  const format = q.get('format') ?? 'json';
  if (!['json', 'csv', 'print'].includes(format)) throw new HttpError(422, 'FIELD_INVALID', 'format is json, csv or print.', { field: 'format', rule: 'enum' });
  const st = await stockStatement(s, q);
  if (format === 'json') return json(st);
  await auditExport(s, st, format);
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (format === 'csv') {
    return new Response(statementCsv(st), { headers: { ...headers, 'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="stock-statement-${st.from}-to-${st.to}.csv"` } });
  }
  return new Response(statementHtml(st, await premisesHeaders(s, st)), { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
});
