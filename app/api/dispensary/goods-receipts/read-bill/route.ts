import { json } from '@/lib/http/api';
import { HttpError } from '@/lib/http/errors';
import { withSession } from '@/lib/http/session-route';
import { MAX_IMAGE_BYTES, MAX_PDF_BYTES, readBill, sniff } from '@/lib/stock/bill-reader';

export const dynamic = 'force-dynamic';

/**
 * E-51 (D-51): read one supplier bill (a photo or PDF, multipart field `file`) and propose a draft
 * delivery. Writes nothing, so it needs no Idempotency-Key (06a §12.2).
 */
export const POST = withSession({ permission: 'stock.receive' }, async (req, _ctx, s) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new HttpError(503, 'BILL_READER_NOT_CONFIGURED', 'Reading bills from a photo is not set up here. Type the delivery in instead.');
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(422, 'FIELD_INVALID', 'Send the bill as a file.', { field: 'file', rule: 'multipart' });
  }
  for (const k of form.keys()) if (k !== 'file') throw new HttpError(422, 'UNKNOWN_FIELD', `Unknown field ${k}.`, { field: k });
  const file = form.get('file');
  if (!(file instanceof Blob)) throw new HttpError(422, 'FIELD_INVALID', 'Send the bill as a file.', { field: 'file', rule: 'required' });
  if (file.size > MAX_PDF_BYTES) throw new HttpError(413, 'FILE_TOO_LARGE', 'That file is too large (8 MB at most).');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const media = sniff(bytes);
  if (!media) throw new HttpError(422, 'UNSUPPORTED_FORMAT', 'Send a JPEG, PNG or WebP photo, or a PDF.');
  if (media !== 'application/pdf' && bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'FILE_TOO_LARGE', 'That photo is too large (5 MB at most).');
  return json(await readBill(s, media, bytes));
});
