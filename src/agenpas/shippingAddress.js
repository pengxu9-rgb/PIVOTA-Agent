'use strict';

/*
 * AgenPas shipping-address collection (docs/agenpas.md, "Shipping address"). The ONE place that knows the backend's
 * names for this step, so a renamed field changes here only:
 *
 *   the request   the unified view's `next_action: {kind: "shipping_address", fields_missing: [...], expires_at,
 *                 prefill?: {...}}` in a state before placing, or the state `needs_shipping_address`
 *   the answer    POST body {email, firstName, lastName, phone, addressLine1, addressLine2, city, region, postalCode,
 *                 country}: the backend door's own field names, which the page uses as-is
 *
 * VALIDATION here is the gateway's (the backend validates again). Every message is a CODE, never the value: nothing
 * a buyer typed is ever echoed back or logged. US only for the pilot (the rail is USD only).
 */

/** The backend door's fields, in the order the form shows them. */
const ADDRESS_FIELDS = Object.freeze([
  'email', 'firstName', 'lastName', 'phone', 'addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'country',
]);
const OPTIONAL_FIELDS = new Set(['addressLine2']);
// Left out of the "names no fields, so asks for all" fallback: the payment partner asks for neither a state nor a ZIP,
// and the store's own checkout asks if it needs one. A request that LISTS them still requires them (the backend's
// word); the page offers them as optional only when it adds them itself.
const NOT_ASKED_BY_DEFAULT = new Set(['region', 'postalCode']);

// Spellings the backend might use in `fields_missing` / `prefill` -> the door's name. Only this table changes when it does.
const FIELD_ALIASES = Object.freeze({
  email: 'email', buyer_email: 'email',
  firstName: 'firstName', first_name: 'firstName', given_name: 'firstName',
  lastName: 'lastName', last_name: 'lastName', family_name: 'lastName',
  phone: 'phone',
  addressLine1: 'addressLine1', address_line1: 'addressLine1', address_line_1: 'addressLine1',
  addressLine2: 'addressLine2', address_line2: 'addressLine2', address_line_2: 'addressLine2',
  city: 'city',
  region: 'region', state: 'region',
  postalCode: 'postalCode', postal_code: 'postalCode', zip: 'postalCode',
  country: 'country',
});

const ACTION_KIND = 'shipping_address';
const STATE = 'needs_shipping_address';
const PRE_PLACING = new Set(['routing', 'needs_payment_method', 'locking', 'awaiting_buyer_authorization', STATE]);

const US_STATES = Object.freeze([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]);
const US_STATE_SET = new Set(US_STATES);
const COUNTRIES = Object.freeze(['US']);

const MAX_FIELD_CHARS = 200;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/;
const ZIP_RE = /^(\d{5})(?:-?(\d{4}))?$/;
const PHONE_CHARS_RE = /^[0-9+\s\-().]+$/;

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function canonicalField(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(FIELD_ALIASES, name) ? FIELD_ALIASES[name] : null;
}

function iso(value, nowMs) {
  if (value === undefined || value === null) return { iso: null, past: false };
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(t)) return { iso: null, past: true }; // present but unreadable: not offered
  return { iso: new Date(t).toISOString(), past: t <= nowMs };
}

/**
 * The address request the view carries, or null. `state` is the projected state; `rawAction` the view's action object.
 * @returns {{ fields_missing: string[], expires_at: string|null, prefill: object } | null}
 */
function readAddressRequest(state, rawAction, { now } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.now();
  const asks = isPlainObject(rawAction) && rawAction.kind === ACTION_KIND;
  if (!PRE_PLACING.has(state) || (!asks && state !== STATE)) return null;
  const listed = asks && Array.isArray(rawAction.fields_missing) ? rawAction.fields_missing : [];
  const fields = [...new Set(listed.map(canonicalField).filter(Boolean))];
  // A state that asks without naming fields asks for all of them but the state and the ZIP (NOT_ASKED_BY_DEFAULT).
  const missing = fields.length ? ADDRESS_FIELDS.filter((f) => fields.includes(f))
    : (asks && listed.length ? [] : ADDRESS_FIELDS.filter((f) => !NOT_ASKED_BY_DEFAULT.has(f)));
  if (!missing.length) return null;
  const expires = asks ? iso(rawAction.expires_at, nowMs) : { iso: null, past: false };
  if (expires.past) return null;
  const prefill = {};
  if (asks && isPlainObject(rawAction.prefill)) {
    for (const [key, value] of Object.entries(rawAction.prefill)) {
      const field = canonicalField(key);
      if (field && typeof value === 'string' && value.length <= MAX_FIELD_CHARS && !CONTROL_RE.test(value)) prefill[field] = value;
    }
  }
  return { fields_missing: missing, expires_at: expires.iso, prefill };
}

function normalisePhone(raw) {
  if (!PHONE_CHARS_RE.test(raw)) return null;
  let digits = raw.replace(/[\s\-().]/g, '');
  const plus = digits.startsWith('+');
  digits = digits.replace(/^\+/, '');
  if (!/^[0-9]{7,15}$/.test(digits) || digits.includes('+')) return null;
  if (!plus && digits.length === 10) return `+1${digits}`; // a US number without its country code
  if (!plus && digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return plus ? `+${digits}` : null;
}

/**
 * Validate a submitted address. `required` lists the fields that must be present (the view's fields_missing);
 * any other known field may be present; an unknown field is refused. Never returns or logs a submitted value in an
 * error: only `{field: code}`.
 * @returns {{ ok: true, value: object } | { ok: false, field_errors: object }}
 */
function validateAddress(body, { required = [] } = {}) {
  const errors = {};
  if (!isPlainObject(body)) return { ok: false, field_errors: { _body: 'invalid' } };
  for (const key of Object.keys(body)) {
    if (!ADDRESS_FIELDS.includes(key)) errors[key.length <= 40 && /^[A-Za-z0-9_]+$/.test(key) ? key : '_body'] = 'unknown_field';
  }
  const value = {};
  for (const field of ADDRESS_FIELDS) {
    const raw = body[field];
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      if (required.includes(field) && !OPTIONAL_FIELDS.has(field)) errors[field] = 'required';
      continue;
    }
    if (typeof raw !== 'string') { errors[field] = 'invalid'; continue; }
    const v = raw.trim();
    if (v.length > MAX_FIELD_CHARS) { errors[field] = 'too_long'; continue; }
    if (CONTROL_RE.test(v)) { errors[field] = 'invalid_characters'; continue; }
    switch (field) {
      case 'email':
        if (!EMAIL_RE.test(v)) errors[field] = 'invalid_email'; else value[field] = v;
        break;
      case 'phone': {
        const p = normalisePhone(v);
        if (!p) errors[field] = 'invalid_phone'; else value[field] = p;
        break;
      }
      case 'postalCode': {
        const m = ZIP_RE.exec(v);
        if (!m) errors[field] = 'invalid_postal_code'; else value[field] = m[2] ? `${m[1]}-${m[2]}` : m[1];
        break;
      }
      case 'region': {
        const r = v.toUpperCase();
        if (!US_STATE_SET.has(r)) errors[field] = 'invalid_region'; else value[field] = r;
        break;
      }
      case 'country': {
        const c = v.toUpperCase();
        if (!COUNTRIES.includes(c)) errors[field] = 'unsupported_country'; else value[field] = c;
        break;
      }
      default:
        value[field] = v.replace(/\s+/g, ' ');
    }
  }
  if (!Object.keys(value).length && !Object.keys(errors).length) errors._body = 'empty';
  return Object.keys(errors).length ? { ok: false, field_errors: errors } : { ok: true, value };
}

/** The backend's 422 field errors, kept only as {known field: code}. */
function sanitizeFieldErrors(raw) {
  const out = {};
  const src = isPlainObject(raw) ? raw : {};
  for (const [key, code] of Object.entries(src)) {
    const field = canonicalField(key);
    if (field && typeof code === 'string' && /^[a-z0-9_]{1,48}$/.test(code)) out[field] = code;
  }
  return out;
}

module.exports = {
  ACTION_KIND,
  ADDRESS_FIELDS,
  COUNTRIES,
  STATE,
  US_STATES,
  readAddressRequest,
  sanitizeFieldErrors,
  validateAddress,
};
