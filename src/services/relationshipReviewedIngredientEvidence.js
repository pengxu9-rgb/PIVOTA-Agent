'use strict';

const crypto = require('node:crypto');
const TABLE = 'public.relgraph_reviewed_ingredient_evidence';
const MAX_RECORDS = 17;
const DAY = 86400000;
const FIELDS = ['product_key', 'pivota_signature_id', 'product_id', 'source_product_id', 'merchant_id', 'platform', 'market', 'variant_title', 'variant_detail_label'];
const COMMON_PROOF_FIELDS = ['identity','source_url','source_observed_at','formula_sha256','raw_source_sha256','exact_listing_verified','full_ingredient_list'];
function requireProofFields(value, allowed) {
  assert(value && Object.keys(value).every(key => allowed.includes(key)), 'ingredient_evidence_unknown_proof_field');
}
const text = value => typeof value === 'string' ? value.trim() : '';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const assert = (condition, code) => { if (!condition) throw new Error(code); };
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function identity(value) {
  // Lazy load avoids a module cycle with the ingredient loader.
  const { exactIdentity } = require('./relationshipEvidenceReadiness');
  const normalized = exactIdentity(value);
  assert(normalized.exact_key && !normalized.identity_conflict && normalized.market, 'ingredient_evidence_identity');
  assert(normalized.product_key || normalized.pivota_signature_id || [normalized.product_id, normalized.source_product_id].some(id => /^ext_/i.test(id)), 'ingredient_evidence_immutable_identity');
  return Object.fromEntries(FIELDS.map(field => [field, normalized[field]]));
}
function identityKey(value) { return sha256(JSON.stringify(identity(value))); }
function sourceUrl(value) {
  try {
    const parsed = new URL(value);
    assert(text(value) && value.length <= 4096 && parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash, 'ingredient_evidence_source');
    assert(![...parsed.searchParams.keys()].some(key => /token|password|secret|authorization|api.?key/i.test(key)), 'ingredient_evidence_source');
    return parsed.href;
  } catch (_) { throw new Error('ingredient_evidence_source'); }
}
function timestamp(value, nowMs, current) {
  const at = Date.parse(value); assert(text(value) && Number.isFinite(at) && at <= nowMs && (!current || nowMs - at <= 45 * DAY), 'ingredient_evidence_timestamp');
  return new Date(at).toISOString();
}
function groundingText(value) {
  return text(value).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (match, code) => {
      const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }).replace(/&(amp|nbsp|quot|apos|lt|gt);/gi, (match, entity) => ({amp:'&',nbsp:' ',quot:'"',apos:"'",lt:'<',gt:'>'}[entity.toLowerCase()]))
    .normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function validateReviewedIngredientEvidence(input, { nowMs = Date.now(), requireCurrent = true, verifyCaptureBody = false } = {}) {
  assert(Number.isFinite(nowMs) && input?.schema === 'relgraph.reviewed_ingredient_evidence.v1', 'ingredient_evidence_schema');
  const owner = identity(input.identity); const key = identityKey(owner);
  const ingredientText = text(input.ingredient_text);
  assert(ingredientText.length <= 24000 && ingredientText.split(/[,;]/).filter(text).length >= 5 && input.full_ingredient_list === true, 'ingredient_evidence_full_formula');
  const formulaHash = sha256(ingredientText); const url = sourceUrl(input.source_url);
  const observedAt = timestamp(input.source_observed_at, nowMs, requireCurrent);
  assert(input.formula_sha256 === formulaHash && /^[a-f0-9]{64}$/.test(input.raw_source_sha256 || ''), 'ingredient_evidence_fingerprint');
  assert(input.parse_status === 'OK' && input.review_status === 'APPROVED' && input.audit_status === 'PASS' && input.ingest_allowed === true, 'ingredient_evidence_status');
  const capture = input.source_capture;
  requireProofFields(capture, [...COMMON_PROOF_FIELDS,'capture_id','capture_method','source_excerpt','source_excerpt_sha256']);
  assert(capture && JSON.stringify(capture).length <= 16000, 'ingredient_evidence_capture_bound');
  const excerpt = text(capture.source_excerpt);
  assert(excerpt && excerpt.length <= 8000 && capture.source_excerpt_sha256 === sha256(excerpt) &&
    groundingText(excerpt).includes(groundingText(ingredientText)), 'ingredient_evidence_source_grounding');
  if (verifyCaptureBody) {
    const body = input.raw_source_body;
    assert(Buffer.isBuffer(body) && body.length > 0 && body.length <= 2 * 1024 * 1024 && sha256(body) === input.raw_source_sha256 &&
      groundingText(body.toString('utf8')).includes(groundingText(excerpt)), 'ingredient_evidence_raw_capture_grounding');
  }
  assert(capture && capture.exact_listing_verified === true && capture.full_ingredient_list === true && capture.capture_method === 'bound_pdp_fetch' &&
    identityKey(capture.identity) === key && sourceUrl(capture.source_url) === url && timestamp(capture.source_observed_at, nowMs, requireCurrent) === observedAt &&
    capture.formula_sha256 === formulaHash && capture.raw_source_sha256 === input.raw_source_sha256 && text(capture.capture_id), 'ingredient_evidence_capture_binding');
  const reviews = input.reviews;
  assert(Array.isArray(reviews) && reviews.length >= 1 && reviews.length <= 2 && JSON.stringify(reviews).length <= 24000, 'ingredient_evidence_reviews');
  const providers = new Set(); const reviewIds = new Set();
  for (const review of reviews) {
    requireProofFields(review, [...COMMON_PROOF_FIELDS,'provider','review_id','decision','reviewed_at','source_grounded','source_excerpt_sha256','grounded_quote','model','packet_sha256']);
    assert(review.model === undefined || text(review.model).length > 0 && text(review.model).length <= 128 && /^[a-z0-9._-]+$/i.test(review.model), 'ingredient_evidence_review_model');
    assert(review.packet_sha256 === undefined || typeof review.packet_sha256 === 'string' && /^[a-f0-9]{64}$/.test(review.packet_sha256), 'ingredient_evidence_review_packet');
    assert(['gpt', 'gemini', 'human'].includes(review.provider) && !providers.has(review.provider) && text(review.review_id) && !reviewIds.has(review.review_id) &&
      review.decision === 'approve' && review.exact_listing_verified === true && review.full_ingredient_list === true && review.source_grounded === true &&
      identityKey(review.identity) === key && sourceUrl(review.source_url) === url && review.raw_source_sha256 === input.raw_source_sha256 &&
      review.formula_sha256 === formulaHash && timestamp(review.source_observed_at, nowMs, requireCurrent) === observedAt &&
      review.source_excerpt_sha256 === capture.source_excerpt_sha256 && groundingText(review.grounded_quote) === groundingText(ingredientText) &&
      Date.parse(timestamp(review.reviewed_at, nowMs, requireCurrent)) >= Date.parse(observedAt), 'ingredient_evidence_review_binding');
    providers.add(review.provider); reviewIds.add(review.review_id);
  }
  assert(providers.size === 2 && providers.has('gpt') && providers.has('gemini') || providers.size === 1 && providers.has('human'), 'ingredient_evidence_consensus');
  assert(!input.reconciliation && !input.supersedes, 'ingredient_evidence_reconciliation_unsupported');
  const record = { schema: input.schema, identity: owner, identity_key: key, ingredient_text: ingredientText, full_ingredient_list: true,
    formula_sha256: formulaHash, raw_source_sha256: input.raw_source_sha256, source_url: url, source_observed_at: observedAt,
    source_capture: { ...capture, identity: identity(capture.identity) }, reviews: reviews.map(review => ({ ...review, identity: identity(review.identity) })),
    parse_status: 'OK', review_status: 'APPROVED', audit_status: 'PASS', ingest_allowed: true };
  // Bind complete independent proof, not just an owner/formula pair.
  const snapshot = JSON.parse(JSON.stringify(record));
  return freeze({ ...snapshot, evidence_id: sha256(canonicalJson(snapshot)) });
}
function formulaKey(value) { return text(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function assertNoProtectedConflict(record, existing) {
  assert(Array.isArray(existing) && existing.length <= 4, 'ingredient_evidence_existing_incomplete');
  for (const row of existing) {
    assert(![row.parse_status, row.review_status, row.audit_status].some(value => /^(reject|rejected|blocked|failed|fail|needs_review)$/i.test(text(value))) &&
      row.ingest_allowed !== false && row.ingest_allowed !== 'false', 'ingredient_evidence_existing_rejection');
    const formula = row.ingredient_text || row.raw_inci || row.raw_ingredient_text_clean || row.inci_list;
    assert(!text(formula) || formulaKey(formula) && formulaKey(formula) === formulaKey(record.ingredient_text), 'ingredient_evidence_existing_conflict');
  }
}

async function inspectExisting(client, record) {
  const scope = record.identity; const ids = [scope.product_id, scope.source_product_id].filter(id => /^ext_/i.test(id));
  const refs = [...ids, ...ids.map(id => `product:${id}`), scope.pivota_signature_id, scope.pivota_signature_id && `product:${scope.pivota_signature_id}`].filter(Boolean);
  const rawRefs = [...new Set([scope.product_id, scope.source_product_id].filter(Boolean).flatMap(id => [id, `product:${id}`]))];
  const knownMerchant = scope.merchant_id && scope.merchant_id.toLowerCase() !== 'external_seed' ? scope.merchant_id : '';
  const checks = [
    [TABLE, 'identity_key = $1', [record.identity_key]],
    ['public.beauty_sku_ingredients', "(to_jsonb(e)->>'product_key' = $1 AND $1 <> '' OR to_jsonb(e)->>'sku_key' = ANY($2::text[]) OR ($3 <> '' AND $4 = '' AND to_jsonb(e)->>'merchant_id' = $3 AND to_jsonb(e)->>'sku_key' = ANY($5::text[])))", [scope.product_key, refs, knownMerchant, scope.platform, rawRefs]],
    ['pci_kb.sku_ingredients', "(to_jsonb(e)->>'sku_key' = ANY($1::text[]) OR to_jsonb(e)->>'source_ref' = $2) AND upper(COALESCE(to_jsonb(e)->>'market','')) IN ('',$3)", [refs, record.source_url, scope.market]],
  ];
  for (const [table, predicate, params] of checks) {
    if (table !== TABLE) {
      const available = await client.query('SELECT to_regclass($1) AS regclass', [table]);
      if (!available.rows?.[0]?.regclass) continue;
    }
    // Include denied/unreviewed rows; loader's serving filters must never hide rejection from ingestion.
    const result = await client.query(`SELECT to_jsonb(e) AS evidence FROM ${table} e WHERE ${predicate} LIMIT 5 FOR SHARE`, params);
    assertNoProtectedConflict(record, (result.rows || []).map(row => row.evidence));
  }
}

async function appendReviewedIngredientEvidence({ pool, records, nowMs = Date.now(), apply = false, rebindExactListing } = {}) {
  assert(typeof apply === 'boolean', 'ingredient_evidence_apply_mode');
  assert(Array.isArray(records) && records.length > 0 && records.length <= MAX_RECORDS, 'ingredient_evidence_batch_bound');
  const validated = records.map(record => validateReviewedIngredientEvidence(record, { nowMs, verifyCaptureBody: true }));
  assert(new Set(validated.map(record => record.identity_key)).size === validated.length, 'ingredient_evidence_duplicate_listing');
  assert(pool && typeof pool.connect === 'function', 'ingredient_evidence_transaction_client');
  assert(typeof rebindExactListing === 'function', 'ingredient_evidence_transaction_rebind_required');
  const client = await pool.connect(); let transaction = false; let unknownCommit = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); transaction = true;
    await client.query("SET LOCAL statement_timeout = '10000ms'");
    await client.query("SET LOCAL lock_timeout = '3000ms'");
    const available = await client.query('SELECT to_regclass($1) AS regclass', [TABLE]);
    assert(available.rows?.[0]?.regclass, 'ingredient_evidence_migration_required');
    for (const record of [...validated].sort((a,b) => a.identity_key.localeCompare(b.identity_key))) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [record.identity_key]);
      // The independently reviewed operator must hydrate/rebind through this
      // transaction client, never through an earlier exported manifest or pool.
      const product = await rebindExactListing({ client, record });
      const { productReadiness } = require('./relationshipEvidenceReadiness');
      assert(product && identityKey(product) === record.identity_key && sourceUrl(product.url) === record.source_url &&
        productReadiness(product, { nowMs }).acquisition_source_bound, 'ingredient_evidence_transaction_listing_drift');
      await inspectExisting(client, record);
    }
    let inserted = 0;
    if (apply) for (const record of validated) {
      const owner = record.identity;
      const result = await client.query(`INSERT INTO ${TABLE}
        (evidence_id, identity_key, product_key, pivota_signature_id, product_id, source_product_id, merchant_id, platform, market,
          variant_title, variant_detail_label, ingredient_text, formula_sha256, raw_source_sha256, source_url, source_observed_at, proof)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb) ON CONFLICT (evidence_id) DO NOTHING`,
      [record.evidence_id, record.identity_key, ...FIELDS.map(field => owner[field]), record.ingredient_text, record.formula_sha256,
        record.raw_source_sha256, record.source_url, record.source_observed_at, JSON.stringify(record)]);
      inserted += result.rowCount || 0;
    }
    if (apply) {
      try { await client.query('COMMIT'); transaction = false; }
      catch (_) {
        unknownCommit = true; transaction = false;
        // COMMIT might have landed. Returning only durable proof IDs allows
        // a later read-only reconciliation; do not retry or claim a rollback.
        return { schema: 'relgraph.ingredient_ingest_receipt.v1', status: 'publication_outcome_unknown',
          transaction_outcome: 'unknown', exact_listings: validated.length, evidence_ids: validated.map(record => record.evidence_id),
          dry_run: false, inserted: null, kb_writes: null, graph_writes: 0, model_calls: 0, conflicts_overwritten: 0, retry_allowed: false };
      }
    } else { await client.query('ROLLBACK'); transaction = false; }
    return { schema: 'relgraph.ingredient_ingest_receipt.v1', exact_listings: validated.length, inserted, dry_run: !apply,
      graph_writes: 0, model_calls: 0, kb_writes: inserted, conflicts_overwritten: 0 };
  } finally {
    try { if (transaction) await client.query('ROLLBACK'); } finally { client.release(unknownCommit ? new Error('ingredient_commit_outcome_unknown') : undefined); }
  }
}
module.exports = { TABLE, MAX_RECORDS, identityKey, sha256, validateReviewedIngredientEvidence, appendReviewedIngredientEvidence,
  __internal: { identity, formulaKey, groundingText, canonicalJson, assertNoProtectedConflict, inspectExisting } };
