const { query } = require('../db');

const BEAUTY_ATTRIBUTE_FIELDS = [
  'product_form',
  'category_leaf',
  'target_area',
  'shade_or_color_family',
  'scent_family',
  'spf_or_otc_flag',
  'skin_concern',
  'claim_risk_level',
];

const AUDIT_STATUSES = new Set(['pending', 'codex_reviewed', 'manually_corrected', 'rejected']);

const SPF_OTC_VALUES = new Set(['cosmetic', 'spf', 'otc_drug', 'spf_otc', 'unknown']);
const CLAIM_RISK_VALUES = new Set(['low', 'medium', 'high']);
const TARGET_AREA_VALUES = new Set([
  'face', 'lips', 'body', 'hair', 'eyes', 'brows', 'cheeks',
  'hands', 'nails', 'scalp', 'oral', 'fragrance', 'multi_area', 'unknown',
]);

function normalizeKey(value) {
  if (value == null) return '';
  const text = String(value).trim();
  if (!text) return '';
  // Accept both `product:ext_<hash>` (relation-graph anchor form) and bare
  // `ext_<hash>`. Strip the prefix.
  return text.replace(/^product:/, '');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rowToAttributes(row) {
  if (!row) return null;
  const out = { product_key: row.product_key };
  for (const field of BEAUTY_ATTRIBUTE_FIELDS) {
    out[field] = row[field];
    out[`${field}_source`] = row[`${field}_source`];
    out[`${field}_confidence`] = row[`${field}_confidence`] == null
      ? null
      : Number(row[`${field}_confidence`]);
  }
  out.extractor_version = row.extractor_version || null;
  out.raw_extraction = row.raw_extraction || null;
  out.audit_status = row.audit_status || 'pending';
  out.audit_notes = row.audit_notes || null;
  out.extracted_at = row.extracted_at || null;
  out.created_at = row.created_at;
  out.updated_at = row.updated_at;
  return out;
}

async function lookupBeautyAttributes(productKey, { queryFn = query } = {}) {
  const key = normalizeKey(productKey);
  if (!key) return null;
  const res = await queryFn(
    'SELECT * FROM product_beauty_attributes WHERE product_key = $1 LIMIT 1',
    [key],
  );
  const rows = Array.isArray(res?.rows) ? res.rows : [];
  return rows.length ? rowToAttributes(rows[0]) : null;
}

async function lookupBeautyAttributesBatch(productKeys, { queryFn = query } = {}) {
  if (!Array.isArray(productKeys) || !productKeys.length) return new Map();
  const keys = Array.from(new Set(
    productKeys.map(normalizeKey).filter(Boolean),
  ));
  if (!keys.length) return new Map();
  const res = await queryFn(
    'SELECT * FROM product_beauty_attributes WHERE product_key = ANY($1::text[])',
    [keys],
  );
  const rows = Array.isArray(res?.rows) ? res.rows : [];
  const out = new Map();
  for (const row of rows) out.set(row.product_key, rowToAttributes(row));
  return out;
}

// Phase B preflight calls this to know whether a candidate has enough
// attribute coverage to apply structural gates. If both anchor and candidate
// have null product_form or audit_status='pending', preflight should skip
// gating (label remains 'generated' / 'review_ready' per existing behavior)
// rather than reject on insufficient evidence.
function hasGateableAttributes(attrs) {
  if (!isPlainObject(attrs)) return false;
  if (attrs.audit_status === 'rejected') return false;
  // Minimum: product_form present with non-null confidence.
  return Boolean(attrs.product_form && attrs.product_form_confidence != null);
}

function validateExtractionPayload(payload) {
  if (!isPlainObject(payload)) return { ok: false, errors: ['payload_not_object'] };
  const errors = [];
  if (!payload.product_key || typeof payload.product_key !== 'string') {
    errors.push('missing_product_key');
  }
  for (const field of BEAUTY_ATTRIBUTE_FIELDS) {
    const conf = payload[`${field}_confidence`];
    if (conf != null) {
      const n = Number(conf);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        errors.push(`invalid_confidence:${field}`);
      }
    }
  }
  if (payload.spf_or_otc_flag != null && !SPF_OTC_VALUES.has(payload.spf_or_otc_flag)) {
    errors.push(`invalid_spf_or_otc_flag:${payload.spf_or_otc_flag}`);
  }
  if (payload.claim_risk_level != null && !CLAIM_RISK_VALUES.has(payload.claim_risk_level)) {
    errors.push(`invalid_claim_risk_level:${payload.claim_risk_level}`);
  }
  if (payload.target_area != null && !TARGET_AREA_VALUES.has(payload.target_area)) {
    errors.push(`invalid_target_area:${payload.target_area}`);
  }
  if (payload.skin_concern != null && !Array.isArray(payload.skin_concern)) {
    errors.push('skin_concern_not_array');
  }
  if (payload.audit_status != null && !AUDIT_STATUSES.has(payload.audit_status)) {
    errors.push(`invalid_audit_status:${payload.audit_status}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

async function upsertBeautyAttributes(input = {}, { queryFn = query } = {}) {
  const validation = validateExtractionPayload(input);
  if (!validation.ok) {
    const err = new Error(`invalid_beauty_attributes:${validation.errors.join(',')}`);
    err.code = 'INVALID_BEAUTY_ATTRIBUTES';
    err.errors = validation.errors;
    throw err;
  }

  const key = normalizeKey(input.product_key);
  const params = [key];
  const cols = ['product_key'];
  const placeholders = ['$1'];
  const updates = [];
  let idx = 2;

  for (const field of BEAUTY_ATTRIBUTE_FIELDS) {
    const value = input[field];
    const source = input[`${field}_source`];
    const conf = input[`${field}_confidence`];
    cols.push(field, `${field}_source`, `${field}_confidence`);
    if (field === 'skin_concern') {
      placeholders.push(`$${idx}::text[]`, `$${idx + 1}`, `$${idx + 2}`);
      params.push(Array.isArray(value) ? value : null, source ?? null, conf == null ? null : Number(conf));
    } else {
      placeholders.push(`$${idx}`, `$${idx + 1}`, `$${idx + 2}`);
      params.push(value ?? null, source ?? null, conf == null ? null : Number(conf));
    }
    updates.push(
      `${field} = EXCLUDED.${field}`,
      `${field}_source = EXCLUDED.${field}_source`,
      `${field}_confidence = EXCLUDED.${field}_confidence`,
    );
    idx += 3;
  }

  cols.push('extractor_version', 'raw_extraction', 'audit_status', 'audit_notes', 'extracted_at');
  placeholders.push(`$${idx}`, `$${idx + 1}::jsonb`, `$${idx + 2}`, `$${idx + 3}`, `$${idx + 4}::timestamptz`);
  params.push(
    input.extractor_version ?? null,
    input.raw_extraction == null ? null : JSON.stringify(input.raw_extraction),
    input.audit_status ?? 'pending',
    input.audit_notes ?? null,
    input.extracted_at ?? null,
  );
  updates.push(
    'extractor_version = EXCLUDED.extractor_version',
    'raw_extraction = EXCLUDED.raw_extraction',
    'audit_status = EXCLUDED.audit_status',
    'audit_notes = EXCLUDED.audit_notes',
    'extracted_at = EXCLUDED.extracted_at',
    'updated_at = now()',
  );

  const sql = `
    INSERT INTO product_beauty_attributes (${cols.join(', ')})
    VALUES (${placeholders.join(', ')})
    ON CONFLICT (product_key) DO UPDATE SET
      ${updates.join(',\n      ')}
  `;
  await queryFn(sql, params);
  return { product_key: key };
}

module.exports = {
  BEAUTY_ATTRIBUTE_FIELDS,
  AUDIT_STATUSES,
  SPF_OTC_VALUES,
  CLAIM_RISK_VALUES,
  TARGET_AREA_VALUES,
  normalizeKey,
  lookupBeautyAttributes,
  lookupBeautyAttributesBatch,
  upsertBeautyAttributes,
  validateExtractionPayload,
  hasGateableAttributes,
};
