import { HttpError } from './errors';

/**
 * strictBody (06a §5): hand-written validation that rejects unknown keys with 422, so no
 * request can smuggle in a field the route does not expect (e.g. `orgId`, 06b DX-73).
 * Error details name the field and the rule, never the value.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Base = { optional?: boolean; nullable?: boolean };
export type Rule =
  | (Base & { type: 'string'; min?: number; max?: number; pattern?: RegExp })
  | (Base & { type: 'int'; min?: number; max?: number })
  | (Base & { type: 'bool' })
  | (Base & { type: 'uuid' })
  | (Base & { type: 'uuid[]'; max?: number })
  /** A map of keys to booleans, e.g. permission overrides: {"stock.view": true}. */
  | (Base & { type: 'flags'; max?: number; keyPattern?: RegExp })
  | (Base & { type: 'string[]'; max?: number; itemMax?: number; itemPattern?: RegExp; oneOf?: readonly string[] })
  | (Base & { type: 'int[]'; max?: number; min?: number; itemMin?: number; itemMax?: number });
type Value<R> = R extends { type: 'string' } ? string : R extends { type: 'int' } ? number : R extends { type: 'bool' } ? boolean
  : R extends { type: 'uuid' } ? string : R extends { type: 'uuid[]' } ? string[] : R extends { type: 'flags' } ? Record<string, boolean>
  : R extends { type: 'string[]' } ? string[] : R extends { type: 'int[]' } ? number[] : never;
type Out<S extends Record<string, Rule>> = {
  [K in keyof S]: Value<S[K]> | (S[K]['nullable'] extends true ? null : never) | (S[K]['optional'] extends true ? undefined : never)
};

const invalid = (field: string, rule: string) => new HttpError(422, 'FIELD_INVALID', 'A field is not valid.', { field, rule });

function check(key: string, rule: Rule, v: unknown): unknown {
  switch (rule.type) {
    case 'string': {
      if (typeof v !== 'string') throw invalid(key, 'type');
      const len = [...v].length;
      if ((rule.min !== undefined && len < rule.min) || (rule.max !== undefined && len > rule.max)) throw invalid(key, 'length');
      if (rule.pattern && !rule.pattern.test(v)) throw invalid(key, 'format');
      return v;
    }
    case 'int':
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw invalid(key, 'type');
      if ((rule.min !== undefined && v < rule.min) || (rule.max !== undefined && v > rule.max)) throw invalid(key, 'range');
      return v;
    case 'bool':
      if (typeof v !== 'boolean') throw invalid(key, 'type');
      return v;
    case 'uuid':
      if (typeof v !== 'string' || !UUID_PATTERN.test(v)) throw invalid(key, 'format');
      return v.toLowerCase();
    case 'uuid[]': {
      if (!Array.isArray(v) || v.length > (rule.max ?? 100)) throw invalid(key, 'type');
      if (!v.every((x) => typeof x === 'string' && UUID_PATTERN.test(x))) throw invalid(key, 'format');
      return [...new Set(v.map((x: string) => x.toLowerCase()))];
    }
    case 'string[]': {
      if (!Array.isArray(v) || v.length > (rule.max ?? 50)) throw invalid(key, 'type');
      for (const x of v) {
        if (typeof x !== 'string' || [...x].length > (rule.itemMax ?? 100) || [...x].length === 0) throw invalid(key, 'type');
        if (rule.itemPattern && !rule.itemPattern.test(x)) throw invalid(key, 'format');
        if (rule.oneOf && !rule.oneOf.includes(x)) throw invalid(key, 'enum');
      }
      return [...new Set(v as string[])];
    }
    case 'int[]': {
      if (!Array.isArray(v) || v.length > (rule.max ?? 50) || v.length < (rule.min ?? 0)) throw invalid(key, 'length');
      for (const x of v) {
        if (typeof x !== 'number' || !Number.isSafeInteger(x)) throw invalid(key, 'type');
        if ((rule.itemMin !== undefined && x < rule.itemMin) || (rule.itemMax !== undefined && x > rule.itemMax)) throw invalid(key, 'range');
      }
      return v;
    }
    case 'flags': {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw invalid(key, 'type');
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length > (rule.max ?? 100)) throw invalid(key, 'length');
      for (const [k, b] of entries) {
        if (typeof b !== 'boolean') throw invalid(key, 'type');
        if (rule.keyPattern && !rule.keyPattern.test(k)) throw invalid(key, 'key');
      }
      return v;
    }
  }
}

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
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(schema)) {
    const v = input[key];
    if (v === undefined) {
      if (rule.optional) continue;
      throw new HttpError(422, 'FIELD_REQUIRED', 'A required field is missing.', { field: key });
    }
    if (v === null) {
      if (rule.nullable) { out[key] = null; continue; }
      if (rule.optional) continue;
      throw new HttpError(422, 'FIELD_REQUIRED', 'A required field is missing.', { field: key });
    }
    out[key] = check(key, rule, v);
  }
  return out as Out<S>;
}

/**
 * For routes that take no fields (sign-out, activity, lock, revoke): an empty body or `{}` is
 * fine; any field is refused like strictBody does, so no field can name another user or
 * session (06b DX-04).
 */
export async function emptyBody(req: Request): Promise<void> {
  const text = await req.text();
  if (!text.trim()) return;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'BAD_JSON', 'The request body must be JSON.');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'BAD_JSON', 'The request body must be a JSON object.');
  }
  const key = Object.keys(body)[0];
  if (key !== undefined) throw new HttpError(422, 'UNKNOWN_FIELD', 'The request has a field this route does not accept.', { field: key });
}
