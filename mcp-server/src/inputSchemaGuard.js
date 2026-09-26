// Enforcement for what tools/list ADVERTISES. Every native tool schema declares
// `additionalProperties: false`, but until this guard nothing on the tools/call path read that declaration:
// `toParams` is a pure allowlist — a filter, not a validator — so an argument outside the allowlist was
// silently dropped. Verified on prod 2026-08-25: `recommend_products` with a top-level `price_max: 40`
// (instead of `constraints: {price_max: 40}`) was ACCEPTED, the ceiling never applied, and a $64 item came
// back with empty warnings — a budget the buyer's agent believed was enforced, and wasn't. That is the
// worst failure mode a commerce door can have, and it is a whole CLASS: every misspelled or misplaced
// argument on every tool degraded to "accepted and ignored".
//
// The UCP dialect already closed this on its side (`rejectUnknown` in ucpArgumentAdapter.js) with the same
// argument: a schema that says additionalProperties:false while the door silently ignores extras is
// advertising a contract it does not keep. This module is the native dialect's version, driven by the
// DECLARED schema itself rather than a parallel field list, so enforcement cannot drift from advertisement:
// a property added to INPUT_SCHEMAS is accepted the moment it is advertised, with nobody having to remember
// a second table.
//
// SCOPE — unknown/misplaced KEYS only, deliberately not a full JSON Schema validator. Type, enum and
// required-field violations already fail LOUDLY downstream (buyer intake, kernel, upstream), each with a
// curated message; re-checking them here would just move those refusals to a blunter message. Unknown keys
// are the one violation nothing downstream can see — the allowlist has already deleted them.

/**
 * Walk `value` against the declared JSON-Schema subset our tool schemas actually use and collect every key
 * that a strict (`additionalProperties: false` + `properties`) object schema does not declare.
 *
 * Rules, matching JSON Schema semantics for the constructs present in INPUT_SCHEMAS:
 *   - strict object schema: undeclared own keys are violations; declared keys recurse into their subschema.
 *   - permissive object schema (`additionalProperties` true, absent, or a typed subschema — e.g.
 *     recommend_products `constraints`, complete_checkout `payment_authorization`): unknown keys pass and
 *     their values are treated as opaque.
 *   - array schema with an object `items`: each element recurses as `path[i]`.
 *   - a value whose runtime type does not match the schema's shape (e.g. a string where an object was
 *     declared) is skipped — a TYPE error is downstream's refusal to make, not this guard's.
 *
 * @returns {Array<{path: string, allowed: string[]}>} violations, in encounter order; empty when clean.
 */
export function findUndeclaredArguments(schema, value) {
  const out = [];
  collect(schema, value, "", out, 0);
  return out;
}

function collect(schema, value, path, out, depth) {
  // Depth-bounded like safeClone: a hostile deeply-nested body must exhaust the guard, not the stack.
  if (depth > 32 || !isPlainObject(schema)) return;
  if (Array.isArray(value)) {
    if (isPlainObject(schema.items)) {
      value.forEach((el, i) => collect(schema.items, el, `${path}[${i}]`, out, depth + 1));
    }
    return;
  }
  if (!isPlainObject(value)) return;
  const props = isPlainObject(schema.properties) ? schema.properties : null;
  const strict = props !== null && schema.additionalProperties === false;
  for (const key of Object.keys(value)) {
    // Own-key lookup on props, so a schema could never be probed through inherited Object.prototype names —
    // and a JSON `__proto__`/`constructor` argument is simply an undeclared key like any other.
    if (props && Object.prototype.hasOwnProperty.call(props, key)) {
      collect(props[key], value[key], path ? `${path}.${key}` : key, out, depth + 1);
    } else if (strict) {
      out.push({ path: path ? `${path}.${key}` : key, allowed: Object.keys(props) });
    }
  }
}

/**
 * Every property name the schema declares anywhere, mapped to the dotted path(s) it is declared at
 * (`customer_email` → `["quote.customer_email"]`). Fuel for the "did you mean" hint: the observed live
 * failure is an argument sent at the WRONG LEVEL, and a refusal that names the right level is the one a
 * model can act on in a single retry.
 */
export function declaredPropertyPathsByName(schema) {
  const map = new Map();
  walk(schema, "", 0);
  return map;

  function walk(s, path, depth) {
    if (depth > 32 || !isPlainObject(s)) return;
    if (isPlainObject(s.properties)) {
      for (const key of Object.keys(s.properties)) {
        const p = path ? `${path}.${key}` : key;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(p);
        walk(s.properties[key], p, depth + 1);
      }
    }
    if (isPlainObject(s.items)) walk(s.items, path ? `${path}[]` : "[]", depth + 1);
  }
}

function isPlainObject(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}
