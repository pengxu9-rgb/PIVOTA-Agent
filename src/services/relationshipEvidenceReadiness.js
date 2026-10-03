'use strict';

const { normalizeProductIntelCanonicalRef, __internal: { evidenceIdentityKeys } } = require('../auroraBff/productRelationshipGraphSources');

// Planning diagnostics only: none of these statuses grants graph approval or changes inference.
const DAY = 86400000;
const MAX_PRODUCTS = 500;
const MAX_PAIRS = 1000;
const MAX_TASKS = 200;
const DENIED = new Set(['reject', 'reject_external', 'rejected', 'blocked', 'failed', 'fail', 'needs_review', 'suppressed']);
const text = (value) => typeof value === 'string' ? value.trim() : '';
const lower = (value) => text(value).toLowerCase();
// Match the exact evidence join: external_seed is a routing placeholder, not
// a merchant identity. Keep the original value in provenance and task output.
const isMerchantIdentityKnown = (value) => Boolean(text(value)) && lower(value) !== 'external_seed';
function boundedInteger(value, fallback, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error('invalid_evidence_plan_bound');
  return n;
}
function exactIdentity(product = {}) {
  const idText = (value) => { const result = text(value); if (result.length > 512 || /[\x00-\x1f]/.test(result)) throw new Error('invalid_evidence_identity'); return result; };
  const normalized = normalizeProductIntelCanonicalRef(product);
  const identity = Object.fromEntries(['product_key', 'pivota_signature_id', 'product_id', 'source_product_id',
    'merchant_id', 'platform', 'market', 'variant_title', 'variant_detail_label'].map((field) => [field, idText((normalized || product)[field])]));
  identity.market = identity.market.toUpperCase();
  const externalId = [identity.product_id, identity.source_product_id].find((id) => /^ext_/i.test(id));
  const key = identity.product_key ? `key:${identity.product_key}` : identity.pivota_signature_id
    ? `sig:${identity.pivota_signature_id}` : externalId ? `external:${externalId}`
      : isMerchantIdentityKnown(identity.merchant_id) && identity.platform && identity.product_id
        ? `merchant:${identity.merchant_id}:${identity.platform}:${identity.product_id}` : '';
  // Market/variant/merchant scope remains part of dedupe. Shared titles or display refs never bind tasks.
  return { ...identity, identity_conflict: !normalized, product_ref: idText(product.product_ref), exact_key: key
    ? JSON.stringify([key, identity.market, identity.merchant_id, identity.platform, identity.variant_title, identity.variant_detail_label]) : '' };
}
function identitiesContradict(product, source = {}) {
  const owner = exactIdentity(product); const evidence = exactIdentity(source);
  return owner.identity_conflict || evidence.identity_conflict ||
    Boolean(text(product.brand) && text(source.brand) && lower(product.brand) !== lower(source.brand)) ||
    ['product_key', 'pivota_signature_id', 'market', 'merchant_id', 'platform', 'variant_title', 'variant_detail_label']
      .some((field) => owner[field] && evidence[field] &&
        (field !== 'merchant_id' || isMerchantIdentityKnown(owner[field]) && isMerchantIdentityKnown(evidence[field])) &&
        (['merchant_id', 'platform', 'variant_title', 'variant_detail_label'].includes(field)
        ? lower(owner[field]) !== lower(evidence[field]) : owner[field] !== evidence[field]));
}
function owns(product, source = {}) {
  const owner = exactIdentity(product); const evidence = exactIdentity(source);
  if (identitiesContradict(product, source)) return false;
  if (owner.product_key && owner.product_key === evidence.product_key) return true;
  if (owner.pivota_signature_id && owner.pivota_signature_id === evidence.pivota_signature_id) return true;
  const ids = [owner.product_id, owner.source_product_id].filter(Boolean);
  return [evidence.product_id, evidence.source_product_id, text(source.sku_key)].some((id) => ids.includes(id) &&
    (/^ext_/i.test(id) || isMerchantIdentityKnown(owner.merchant_id) && isMerchantIdentityKnown(evidence.merchant_id) &&
      owner.platform && owner.merchant_id === evidence.merchant_id && owner.platform === evidence.platform));
}
function current(at, nowMs, days) {
  if (!at) return false;
  const age = nowMs - new Date(at).getTime();
  return Number.isFinite(age) && age >= 0 && age <= days * DAY;
}
function safeUrl(value) {
  try {
    if (text(value).length > 4096) return '';
    const url = new URL(text(value));
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return '';
    if ([...url.searchParams.keys()].some((key) => /token|password|secret|authorization|api.?key/i.test(key))) return '';
    return url.href;
  } catch (_) { return ''; }
}
function boundSourceUrl(product) {
  const url = safeUrl(product.url);
  if (!url || !exactIdentity(product).exact_key) return '';
  return (Array.isArray(product.source_refs) ? product.source_refs : []).some((ref) =>
    ['catalog_products', 'products_cache', 'external_product_seed', 'approved_live_external_seed'].includes(ref.type) &&
    ref.authoritative === true && safeUrl(ref.url) === url && !identitiesContradict(product, ref) &&
    (owns(product, ref) || ref.type === 'catalog_products' && text(ref.name) === text(product.product_key) && text(product.product_key) ||
      ['external_product_seed', 'approved_live_external_seed'].includes(ref.type) && /^ext_/i.test(text(ref.name)) &&
      [text(product.product_id), text(product.source_product_id)].includes(text(ref.name)))) ? url : '';
}
function ownsInsights(product, intel) {
  const canonical = intel.canonical_product_ref || {};
  if (identitiesContradict(product, canonical)) return false;
  const binding = product.product_intel_binding;
  if (binding && (binding.schema !== 'relgraph.product_intel_binding.v1' || !text(binding.source_record_ref) ||
    !binding.identity || !Array.isArray(binding.matched_identity_keys) || !binding.matched_identity_keys.length ||
    identitiesContradict(product, binding.identity) || identitiesContradict(canonical, binding.identity))) return false;
  if (owns(product, canonical)) return true;
  if (!binding) return false;
  const currentKeys = new Set(evidenceIdentityKeys(normalizeProductIntelCanonicalRef(product) || {}));
  const sourceKeys = evidenceIdentityKeys(normalizeProductIntelCanonicalRef(binding.identity) || {});
  if (!sourceKeys.some((key) => currentKeys.has(key) && binding.matched_identity_keys.includes(key))) return false;
  if (owns(product, binding.identity)) return true;
  // An arbitrary URL in a bundle is not ownership. The current listing URL
  // must independently belong to an authoritative catalog/seed source, and the
  // source record must have matched that exact URL during hydration.
  const url = boundSourceUrl(product);
  return Boolean(url && safeUrl(binding.identity.url) === url &&
    binding.matched_identity_keys.includes(`url:${product.url}`));
}

function productReadiness(product = {}, { nowMs = Date.now(), evidenceMaxAgeDays = 45 } = {}) {
  const records = Array.isArray(product.ingredient_evidence) ? product.ingredient_evidence : [];
  let ingredients = 'missing';
  if (product.ingredient_evidence_conflict === true) ingredients = 'conflict';
  else if (product.ingredient_evidence_incomplete === true || product.ingredient_text_truncated === true) ingredients = 'incomplete';
  else if (text(product.ingredient_text)) {
    const ownedRecords = records.filter((row) => owns(product, row));
    const formulaKeys = new Set(ownedRecords.map((row) => text(row.ingredient_text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).filter(Boolean));
    const matching = records.filter((row) => owns(product, row) && row.ingest_allowed !== false && row.ingest_allowed !== 'false' &&
      ![row.parse_status, row.review_status, row.audit_status].some((status) => DENIED.has(lower(status))) &&
      text(row.ingredient_text) === text(product.ingredient_text));
    const count = text(product.ingredient_text).split(/[,;]/).filter((part) => part.trim()).length;
    ingredients = formulaKeys.size > 1 ? 'conflict' : count < 5 ? 'partial' : !matching.length ? 'unbound' : matching.some((row) =>
      current(row.observed_at, nowMs, evidenceMaxAgeDays)) ? 'substantial_current_owned' : 'stale';
  }
  const intel = product.product_intel;
  let insights = 'missing';
  if (product.product_intel_evidence_incomplete === true) insights = 'incomplete';
  else if (intel) {
    const approved = ['approved', 'reviewed', 'approve'].includes(lower(intel.quality_state)) ||
      ['approved', 'approve', 'approve_external'].includes(lower(intel.provenance?.review_decision));
    const denied = DENIED.has(lower(intel.quality_state)) || DENIED.has(lower(intel.provenance?.review_decision));
    const core = intel.product_intel_core || intel.core;
    insights = denied ? 'rejected' : !ownsInsights(product, intel) ? 'unbound'
      : !core || typeof core !== 'object' || Array.isArray(core) || !Object.keys(core).length ? 'empty' : !approved ? 'unreviewed'
        : !current(intel.freshness?.generated_at, nowMs, evidenceMaxAgeDays) ? 'stale' : 'approved_current_owned';
  }
  const sourceUrl = boundSourceUrl(product);
  const price = product.price == null || product.price === '' ? NaN : Number(product.price);
  const offer = !Number.isFinite(price) || price <= 0 || !text(product.price_currency) ? 'missing'
    : !sourceUrl ? 'unbound' : current(product.price_observed_at, nowMs, 2) ? 'current_owned' : 'stale';
  return { ingredients, insights, offer, exact_identity: Boolean(exactIdentity(product).exact_key), acquisition_source_bound: Boolean(sourceUrl) };
}
function prepare({ products = [], pairs = [], nowMs = Date.now(), evidenceMaxAgeDays = 45, maxProducts, maxPairs } = {}) {
  const productLimit = boundedInteger(maxProducts, MAX_PRODUCTS, MAX_PRODUCTS);
  const pairLimit = boundedInteger(maxPairs, MAX_PAIRS, MAX_PAIRS);
  if (!Array.isArray(products) || !Array.isArray(pairs) || products.length > productLimit || pairs.length > pairLimit) throw new Error('evidence_input_exceeds_bound');
  if (!Number.isFinite(nowMs) || !Number.isFinite(evidenceMaxAgeDays) || evidenceMaxAgeDays <= 0 || evidenceMaxAgeDays > 365) throw new Error('invalid_evidence_clock');
  const byKey = new Map(); let unbound = 0;
  const add = (product) => {
    if (!product || typeof product !== 'object' || Array.isArray(product)) throw new Error('invalid_evidence_product');
    const key = exactIdentity(product).exact_key;
    if (!key) { unbound += 1; return; }
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(product);
  };
  products.forEach(add);
  pairs.forEach((pair) => { if (!pair?.anchor || !pair?.candidate) throw new Error('invalid_evidence_pair'); add(pair.anchor); add(pair.candidate); });
  if (byKey.size > productLimit) throw new Error('evidence_unique_products_exceed_bound');
  // Never select the best evidence alias: disagreement forces a reconciliation task.
  const records = [...byKey].sort(([a], [b]) => a.localeCompare(b)).map(([key, aliases]) => {
    aliases.sort((a, b) => JSON.stringify(exactIdentity(a)).localeCompare(JSON.stringify(exactIdentity(b))) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const identityConflict = aliases.some((product) => exactIdentity(product).identity_conflict) || ['product_key', 'pivota_signature_id', 'product_id', 'source_product_id', 'merchant_id', 'platform', 'market', 'variant_title', 'variant_detail_label']
      .some((field) => new Set(aliases.map((product) => text(product[field])).filter(Boolean)).size > 1);
    const states = aliases.map((product) => productReadiness(product, { nowMs, evidenceMaxAgeDays }));
    const readiness = { ...states[0] };
    for (const field of ['ingredients', 'insights', 'offer']) if (new Set(states.map((state) => state[field])).size > 1) readiness[field] = 'alias_conflict';
    if (new Set(aliases.map((product) => text(product.ingredient_text))).size > 1 && aliases.some((product) => product.ingredient_text)) readiness.ingredients = 'alias_conflict';
    if (new Set(aliases.map((product) => JSON.stringify([product.product_intel || null, product.product_intel_binding || null]))).size > 1) readiness.insights = 'alias_conflict';
    if (new Set(aliases.map((product) => JSON.stringify([product.price, product.price_currency, product.price_observed_at]))).size > 1) readiness.offer = 'alias_conflict';
    const urls = [...new Set(aliases.map(boundSourceUrl))];
    if (identityConflict) for (const field of ['ingredients', 'insights', 'offer']) readiness[field] = 'alias_conflict';
    readiness.acquisition_source_bound = !identityConflict && urls.length === 1 && Boolean(urls[0]);
    return { key, product: aliases[0], readiness, aliases: aliases.length, url: readiness.acquisition_source_bound ? urls[0] : '' };
  });
  return { records, pairs, nowMs, evidenceMaxAgeDays, unbound, productLimit, pairLimit };
}
function curatedCurrent(anchor, candidate, input) {
  const pair = candidate.curated_pair_evidence;
  return Boolean(pair && pair.verified === true && pair.relation_type === 'dupe' &&
    exactIdentity(anchor).exact_key && exactIdentity(candidate).exact_key &&
    text(pair.anchor_ref) === text(anchor.product_ref) && text(pair.candidate_ref) === text(candidate.product_ref) &&
    text(anchor.product_ref) && text(candidate.product_ref) &&
    text(anchor.market) && text(anchor.market).toUpperCase() === text(candidate.market).toUpperCase() &&
    text(pair.market).toUpperCase() === text(anchor.market).toUpperCase() &&
    owns(anchor, pair.anchor_listing || { product_key: pair.anchor_product_key, pivota_signature_id: pair.anchor_signature_id, market: pair.market }) &&
    owns(candidate, pair.candidate_listing || { product_key: pair.candidate_product_key, pivota_signature_id: pair.candidate_signature_id, market: pair.market }) &&
    current(pair.verified_at, input.nowMs, input.evidenceMaxAgeDays));
}
function summarizePrepared(input) {
  const { records, pairs } = input;
  const counts = { ingredients: {}, insights: {}, offer: {} };
  records.forEach(({ readiness }) => Object.keys(counts).forEach((field) => { counts[field][readiness[field]] = (counts[field][readiness[field]] || 0) + 1; }));
  const pairCounts = { total: pairs.length, both_substantial_current_owned_ingredients: 0, both_approved_current_owned_insights: 0,
    both_current_owned_same_currency_offers: 0, curated_dupe_verification_current: 0, curated_dupe_verification_gap: 0, alternative_supporting_evidence_pairs: 0, dupe_evidence_gap_pairs: 0 };
  const byKey = new Map(records.map((record) => [record.key, record]));
  pairs.forEach(({ anchor, candidate, relation_type }) => {
    if (relation_type === 'dupe' || candidate.curated_pair_evidence) {
      pairCounts[curatedCurrent(anchor, candidate, input) ? 'curated_dupe_verification_current' : 'curated_dupe_verification_gap']++;
    }
    const a = byKey.get(exactIdentity(anchor).exact_key)?.readiness; const b = byKey.get(exactIdentity(candidate).exact_key)?.readiness;
    if (!a || !b) { pairCounts.dupe_evidence_gap_pairs++; return; }
    const formulas = a.ingredients === 'substantial_current_owned' && b.ingredients === 'substantial_current_owned';
    const insights = a.insights === 'approved_current_owned' && b.insights === 'approved_current_owned';
    const offers = a.offer === 'current_owned' && b.offer === 'current_owned' &&
      text(anchor.market) && text(anchor.market).toUpperCase() === text(candidate.market).toUpperCase() &&
      text(anchor.price_currency).toUpperCase() === text(candidate.price_currency).toUpperCase();
    if (formulas) pairCounts.both_substantial_current_owned_ingredients++;
    if (insights) pairCounts.both_approved_current_owned_insights++;
    if (offers) pairCounts.both_current_owned_same_currency_offers++;
    if (insights && offers) pairCounts.alternative_supporting_evidence_pairs++;
    if (!formulas || !offers) pairCounts.dupe_evidence_gap_pairs++;
  });
  return { schema: 'relgraph.evidence_readiness.v1', planning_only: true, approval_eligibility_assessed: false,
    unique_exact_listings: records.length, unbound_input_records: input.unbound, counts, pairs: pairCounts,
    policy: { evidence_max_age_days: input.evidenceMaxAgeDays, offer_max_age_hours: 48, ingredient_entries_minimum: 5 }, graph_writes: 0 };
}
function summarizeRelationshipEvidenceReadiness(options) { return summarizePrepared(prepare(options)); }
function buildRelationshipEvidenceAcquisitionPlan(options = {}) {
  const input = prepare(options); const maxTasks = boundedInteger(options.maxTasks, 100, MAX_TASKS);
  const tasks = [];
  const opportunity = new Map();
  input.pairs.forEach(({ anchor, candidate, score = 0 }) => {
    const value = Number.isFinite(Number(score)) ? Math.max(0, Math.min(1, Number(score))) : 0;
    for (const product of [anchor, candidate]) { const key = exactIdentity(product).exact_key; opportunity.set(key, Math.max(opportunity.get(key) || 0, value)); }
  });
  input.records.forEach(({ key, product, readiness, aliases, url }) => {
    const fields = [['ingredients', 'ingredient_harvest_and_audit', 'substantial_current_owned'],
      ['insights', 'pivota_insights_review', 'approved_current_owned'], ['offer', 'catalog_offer_refresh', 'current_owned']];
    fields.forEach(([field, pipeline, ready]) => {
      if (readiness[field] === ready) return;
      const binding = exactIdentity(product); delete binding.exact_key;
      const conflict = ['conflict', 'alias_conflict'].includes(readiness[field]);
      tasks.push({ pipeline, action: conflict ? 'reconcile_exact_listing_evidence' : 'acquire_and_review',
        listing: binding, source_binding: { url: url || null, ownership: url ? 'current_listing_source_ref' : 'unresolved',
          variant_title: binding.variant_title, market: binding.market }, evidence_field: field, gap: readiness[field], aliases_seen: aliases,
        opportunity_score: opportunity.get(key) || 0, execution_ready: Boolean(url && binding.market && !conflict),
        required_review: true, required_binding: 'exact_listing_and_market', writes_authorized: false });
    });
  });
  input.pairs.forEach(({ anchor, candidate, relation_type, score = 0 }) => {
    if (!(relation_type === 'dupe' || candidate.curated_pair_evidence) || curatedCurrent(anchor, candidate, input)) return;
    const anchorIdentity = exactIdentity(anchor); const candidateIdentity = exactIdentity(candidate);
    if (!anchorIdentity.exact_key || !candidateIdentity.exact_key) return;
    delete anchorIdentity.exact_key; delete candidateIdentity.exact_key;
    const url = boundSourceUrl(candidate);
    tasks.push({ pipeline: 'curated_dupe_pair_review', action: 'verify_current_exact_pair', listing: candidateIdentity,
      anchor_listing: anchorIdentity, source_binding: { url: url || null, ownership: url ? 'current_listing_source_ref' : 'unresolved' },
      evidence_field: 'curated_pair', gap: 'verification_missing_stale_or_unbound', aliases_seen: 1,
      opportunity_score: Number.isFinite(Number(score)) ? Math.max(0, Math.min(1, Number(score))) : 0,
      execution_ready: false, required_review: true, required_binding: 'exact_pair_and_market', writes_authorized: false });
  });
  const uniqueTaskMap = new Map();
  for (const task of tasks) {
    const key = JSON.stringify([task.pipeline, task.listing, task.anchor_listing]);
    const previous = uniqueTaskMap.get(key);
    if (!previous || task.opportunity_score > previous.opportunity_score) uniqueTaskMap.set(key, task);
  }
  const uniqueTasks = [...uniqueTaskMap.values()];
  uniqueTasks.sort((a, b) => b.opportunity_score - a.opportunity_score || Number(b.execution_ready) - Number(a.execution_ready) ||
    JSON.stringify(a.listing).localeCompare(JSON.stringify(b.listing)) || a.evidence_field.localeCompare(b.evidence_field));
  return { schema: 'relgraph.evidence_acquisition_plan.v1', generated_at: new Date(input.nowMs).toISOString(), dry_run: true,
    execution_authorized: false, graph_writes: 0, kb_writes: 0, model_calls: 0, max_tasks: maxTasks,
    total_gap_tasks: uniqueTasks.length, omitted_gap_tasks: Math.max(0, uniqueTasks.length - maxTasks), summary: summarizePrepared(input), tasks: uniqueTasks.slice(0, maxTasks) };
}
module.exports = { summarizeRelationshipEvidenceReadiness, buildRelationshipEvidenceAcquisitionPlan, productReadiness, exactIdentity };
