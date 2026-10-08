import { HttpError } from './errors';

/**
 * strictBody (06a §5): hand-written validation that rejects unknown keys with 422, so no
 * request can smuggle in a field the route does not expect (e.g. `orgId`, 06b DX-73).
 * Error details name the field and the rule, never the value.
 */
export type Rule = { type: 'string'; min?: number; max?: number; optional?: boolean; pattern?: RegExp };
type Out<S extends Record<string, Rule>> = { [K in keyof S]: S[K]['optional'] extends true ? string | undefined : string };

export async function strictBody<S extends Record<string, Rule>>(req: Request, schema: S): Promise<Out<S>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, 'BAD_JSON', 'The request body must be JSON.');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'BAD_JSON', 'The request body must be a JSON object.');
  }
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      throw new HttpError(422, 'UNKNOWN_FIELD', 'The request has a field this route does not accept.', { field: key });
    }
  }
  const out: Record<string, string | undefined> = {};
  for (const [key, rule] of Object.entries(schema)) {
    const v = input[key];
    if (v === undefined || v === null) {
      if (rule.optional) continue;
      throw new HttpError(422, 'FIELD_REQUIRED', 'A required field is missing.', { field: key });
    }
    if (typeof v !== 'string') throw new HttpError(422, 'FIELD_INVALID', 'A field has the wrong type.', { field: key, rule: 'type' });
    const len = [...v].length;
    if ((rule.min !== undefined && len < rule.min) || (rule.max !== undefined && len > rule.max)) {
      throw new HttpError(422, 'FIELD_INVALID', 'A field has the wrong length.', { field: key, rule: 'length' });
    }
    if (rule.pattern && !rule.pattern.test(v)) {
      throw new HttpError(422, 'FIELD_INVALID', 'A field has the wrong format.', { field: key, rule: 'format' });
    }
    out[key] = v;
  }
  return out as Out<S>;
}
