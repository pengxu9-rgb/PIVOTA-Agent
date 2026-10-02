'use strict';

const { activeCatalogProductSourceWhere } = require('../services/activeCatalogSourceSql');
const { externalSeedCatalogBindingSql } = require('../services/externalSeedCatalogBindingSql');
const { PDP_RENDER_FRESHNESS_DAYS } = require('./relationshipGraphCoverage');
const { brand, optionRole, isSameFamilyVariant } = require('./relationshipPairPolicy');

const DEFAULT_TARGET_RECALL_OPTIONS = Object.freeze({
  maxAnchors: 200,
  batchSize: 20,
  perAnchor: 64,
  maxCandidates: 5000,
  maxPages: 2,
});
const MAX_TARGET_RECALL_QUERIES = 60;

function bounded(value, fallback, max) {
  const n = Number(value);
  return value == null || value === '' || !Number.isFinite(n)
    ? fallback : Math.max(1, Math.min(max, Math.trunc(n)));
}

function normalizeTargetRecallOptions(options = {}) {
  return {
    maxAnchors: bounded(options.maxAnchors, 200, 400),
    batchSize: bounded(options.batchSize, 20, 20),
    perAnchor: bounded(options.perAnchor, 64, 96),
    maxCandidates: bounded(options.maxCandidates, 5000, 5000),
    maxPages: bounded(options.maxPages, 2, 3),
  };
}

const GENERIC_CATEGORIES = new Set(['beauty', 'skincare', 'skin care', 'makeup', 'cosmetics', 'cosmetic', 'hair', 'hair care', 'haircare', 'personal care', 'products']);
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'your', 'our', 'new', 'all', 'skin', 'beauty', 'skincare', 'makeup', 'product', 'products']);
const ROLE_TERMS = Object.freeze({
  cream: ['moisturizer', 'moisturiser', 'cream', 'lotion'],
  cleanser: ['cleanser', 'cleansing', 'face wash', 'makeup remover'],
  perfume: ['perfume', 'parfum', 'eau de toilette', 'fragrance'],
  lashes: ['lashes', 'eyelashes', 'lash extensions', 'lash clusters'],
  nails: ['press on nails', 'press-on nails', 'fake nails'],
  setting_powder: ['setting powder', 'finishing powder'],
  lip_tint: ['lip tint', 'lip stain'],
});

function text(value) { return typeof value === 'string' ? value.normalize('NFKC').toLowerCase().trim() : ''; }
function category(value) { return text(value).replace(/[_-]+/g, ' ').replace(/\s+/g, ' '); }
function tokens(value) { return [...new Set(text(value).split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word)))]; }
function escapedRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function targetRecallProfile(anchor, existingProducts = []) {
  const role = optionRole(anchor);
  const categories = [...new Set([anchor.category, ...(anchor.category_taxonomy || [])]
    .filter((value) => typeof value === 'string').map(category)
    .filter((value) => value && !GENERIC_CATEGORIES.has(value)))].slice(0, 8);
  const roleTerms = role ? (ROLE_TERMS[role] || [role.replace(/_/g, ' ')]) : [];
  // PostgreSQL word boundaries prevent e.g. hair serum from matching an unrelated
  // brand token. These are retrieval hints only; shared structural policy runs below.
  const jobPattern = roleTerms.length ? `\\m(${roleTerms.map(escapedRegex).join('|')})\\M` : '';
  const anchorBrand = brand(anchor);
  const brandWords = new Set(tokens(anchorBrand));
  const evidenceTokens = tokens([anchor.name, anchor.description, anchor.ingredient_text].filter(Boolean).join(' '))
    .filter((token) => !brandWords.has(token)).slice(0, 24);
  return {
    anchor_ref: anchor.product_ref,
    identity_keys: [...new Set([anchor.product_ref, anchor.product_id, anchor.product_key,
      anchor.source_product_id, anchor.pivota_signature_id, anchor.content_key]
      .filter(Boolean).map(text))],
    brand: anchorBrand,
    categories,
    job_pattern: jobPattern,
    evidence_tokens: evidenceTokens,
    known_brands: [...new Set(existingProducts.map(brand).filter(Boolean))].slice(0, 500),
  };
}

// Scan the eligible catalog BEFORE any candidate bound. Do not take a newest-row
// source LIMIT first: that excluded whole older brands from a selected anchor's
// opportunity set. Only compact retrieval fields enter the scan; full payloads
// are fetched for the bounded winners. Brand rank diversifies retrieval, never
// contributes to the relationship similarity score or review approval.
const TARGET_RECALL_SQL = `
  WITH anchors AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS a(anchor_ref text, identity_keys text[],
      brand text, categories text[], job_pattern text, evidence_tokens text[], known_brands text[])
  ), eligible AS MATERIALIZED (
    SELECT cp.product_key, cp.source_product_id, cp.pivota_signature_id, cp.content_key,
      lower(btrim(coalesce(nullif(cp.brand, ''), cp.product_payload->>'brand', ''))) AS brand,
      ARRAY[lower(regexp_replace(coalesce(cp.category, ''), '[_-]+', ' ', 'g')),
        lower(regexp_replace(coalesce(cp.product_type, ''), '[_-]+', ' ', 'g')),
        lower(regexp_replace(coalesce(cp.category_label, ''), '[_-]+', ' ', 'g'))] AS categories,
      lower(concat_ws(' ', cp.title, cp.category, cp.product_type, cp.category_label)) AS job_text,
      -- A JSON object canonicalizes duplicate words once per eligible listing.
      -- Its key lookup avoids scanning a long word array for every anchor token.
      coalesce((SELECT jsonb_object_agg(word, true)
        FROM regexp_split_to_table(lower(concat_ws(' ', cp.title, left(cp.description, 2000), left(cp.recall_doc, 2000))), '[^a-z0-9]+') AS words(word)
        WHERE word <> ''), '{}'::jsonb) AS evidence_token_set
    FROM catalog_products cp
    LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
    WHERE ${activeCatalogProductSourceWhere('cp', 'cm')}
      AND cp.sync_status = 'live'
      AND cp.suppressed_at IS NULL AND cp.suppression_reason IS NULL
      AND cp.pdp_will_render IS TRUE
      AND cp.pdp_will_render_computed_at >= now() - interval '${PDP_RENDER_FRESHNESS_DAYS} days'
      AND cp.pdp_will_render_computed_at <= now()
      AND cp.pivota_signature_id IS NOT NULL AND btrim(cp.pivota_signature_id) <> ''
      AND cp.pivota_signature_id !~ ':'
      AND btrim(coalesce(cp.title, '')) <> ''
      AND (
        upper(coalesce(nullif(btrim(cp.recall_market), ''), nullif(btrim(cp.product_payload->>'market'), ''),
          nullif(btrim(cp.product_payload#>>'{snapshot,market}'), ''))) = $2
        OR (coalesce(nullif(btrim(cp.recall_market), ''), nullif(btrim(cp.product_payload->>'market'), ''),
          nullif(btrim(cp.product_payload#>>'{snapshot,market}'), '')) IS NULL
          AND EXISTS (SELECT 1 FROM external_product_seeds eps
            WHERE eps.status = 'active' AND upper(btrim(eps.market)) = $2
              AND ${externalSeedCatalogBindingSql('eps', 'cp')}))
      )
      AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY[cp.recall_market, cp.product_payload->>'market',
        cp.product_payload#>>'{snapshot,market}']) known_market(value)
        WHERE nullif(btrim(known_market.value), '') IS NOT NULL AND upper(btrim(known_market.value)) <> $2)
      AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY[cp.recall_availability,
        cp.product_payload->>'availability', cp.product_payload->>'availability_status', cp.product_payload->>'availabilityStatus',
        cp.product_payload#>>'{snapshot,availability}', cp.product_payload#>>'{snapshot,availability_status}',
        cp.product_payload#>>'{snapshot,availabilityStatus}']) stock(value)
        WHERE regexp_replace(lower(stock.value), '[^a-z]', '', 'g') IN ('outofstock', 'soldout', 'unavailable', 'discontinued'))
      -- Keep the trust membership uncorrelated so a sparse eligibility estimate
      -- cannot turn it into one full trust-table scan per catalog row.
      AND coalesce(cp.product_key IN (SELECT crt.subject_key FROM catalog_row_trust crt
        WHERE crt.subject_type = 'product' AND crt.serving_decision = 'public'), false)
  ), matches AS (
    SELECT a.anchor_ref, e.product_key, e.brand,
      (a.brand <> '' AND e.brand <> '' AND e.brand <> a.brand) AS cross_brand,
      (e.brand <> '' AND NOT e.brand = ANY(a.known_brands)) AS unseen_brand,
      (SELECT count(*) FROM unnest(a.evidence_tokens) token WHERE e.evidence_token_set ? token) AS shared_tokens
    FROM anchors a JOIN eligible e
      ON (e.categories && a.categories OR (a.job_pattern <> '' AND e.job_text ~ a.job_pattern))
    WHERE NOT ARRAY[lower(e.product_key), lower(e.source_product_id), lower(e.pivota_signature_id),
      lower('product:' || e.pivota_signature_id), lower('product:' || e.source_product_id), lower(e.content_key)] && a.identity_keys
  ), brands AS (
    SELECT *, row_number() OVER (PARTITION BY anchor_ref, coalesce(nullif(brand, ''), product_key)
      ORDER BY shared_tokens DESC, md5(anchor_ref || ':' || product_key), product_key) AS brand_rank
    FROM matches
  ), ranked AS (
    SELECT *, row_number() OVER (PARTITION BY anchor_ref
      ORDER BY cross_brand DESC, brand_rank ASC, unseen_brand DESC, shared_tokens DESC,
        md5(anchor_ref || ':' || product_key), product_key) AS candidate_rank
    FROM brands
  )
  SELECT r.anchor_ref AS recall_anchor_ref, cp.*,
    'product:' || cp.pivota_signature_id AS product_ref
  FROM ranked r JOIN catalog_products cp ON cp.product_key = r.product_key
  WHERE r.candidate_rank > $3 AND r.candidate_rank <= $4
  ORDER BY r.anchor_ref, r.candidate_rank
`;

function structurallyCompatible(anchor, candidate) {
  const policy = require('./productRelationshipGraphBuilder').__internal;
  return !isSameFamilyVariant(anchor, candidate) &&
    !policy.isOutOfScopeBeautyProduct(candidate) &&
    policy.productFormCompatibility(anchor, candidate).compatible &&
    policy.productJobCompatibility(anchor, candidate).compatible &&
    policy.leafCategoryCompatibility(anchor, candidate).compatible &&
    policy.setCompositionCompatibility(anchor, candidate).compatible;
}

async function loadProductRelationshipGraphTargetRecall({ queryFn, anchors = [], existingProducts = [], market = 'US', ...options } = {}) {
  const caps = normalizeTargetRecallOptions(options);
  const selected = anchors.slice(0, Math.min(caps.maxAnchors, caps.maxCandidates));
  const usable = selected.map((anchor) => ({ anchor, profile: targetRecallProfile(anchor, existingProducts) }))
    .filter(({ profile }) => profile.anchor_ref && (profile.categories.length || profile.job_pattern));
  const byRef = new Map(usable.map(({ anchor }) => [anchor.product_ref, anchor]));
  const candidatesByAnchor = Object.fromEntries(usable.map(({ anchor }) => [anchor.product_ref, []]));
  const diagnostics = { enabled: true, caps, selected_anchor_count: selected.length,
    queried_anchor_count: usable.length, unqueried_anchor_count: anchors.length - usable.length,
    query_count: 0, rows_read: 0, candidate_count: 0, unique_candidate_count: 0, structural_rejected_count: 0,
    max_query_count: MAX_TARGET_RECALL_QUERIES,
    eligibility: 'live_catalog_public_trust_fresh_render_probe', verified_fresh_offer: false };
  if (!usable.length || typeof queryFn !== 'function') return { products: [], candidatesByAnchor, diagnostics };
  const { normalizeCatalogProductRow, isSourceMissingError } = require('./productRelationshipGraphSources');
  const perAnchor = Math.min(caps.perAnchor, Math.max(1, Math.floor(caps.maxCandidates / usable.length)));
  diagnostics.per_anchor_budget = perAnchor;
  const queriedRefs = new Set();
  // Sequential batches/pages share the caller's pool without spawning a per-row
  // query fanout. Each page is bounded; total returned rows <= maxCandidates * maxPages.
  for (let start = 0; start < usable.length && diagnostics.query_count < MAX_TARGET_RECALL_QUERIES; start += caps.batchSize) {
    let pending = usable.slice(start, start + caps.batchSize);
    for (let page = 0; page < caps.maxPages && pending.length && diagnostics.query_count < MAX_TARGET_RECALL_QUERIES; page += 1) {
      let rows;
      try {
        diagnostics.query_count += 1;
        for (const { anchor } of pending) queriedRefs.add(anchor.product_ref);
        rows = (await queryFn(TARGET_RECALL_SQL, [JSON.stringify(pending.map(({ profile }) => profile)),
          String(market || 'US').trim().toUpperCase(), page * perAnchor, (page + 1) * perAnchor])).rows || [];
      } catch (error) {
        if (!isSourceMissingError(error)) throw error;
        // Missing trust/catalog support must fail closed, including after an
        // earlier page. Existing global retrieval remains available to the caller.
        return { products: [], candidatesByAnchor: {}, diagnostics: { ...diagnostics,
          queried_anchor_count: queriedRefs.size, unqueried_anchor_count: anchors.length - queriedRefs.size,
          skipped: 'required_catalog_source_missing', candidate_count: 0, unique_candidate_count: 0 } };
      }
      diagnostics.rows_read += rows.length;
      const pageCounts = new Map();
      for (const row of rows.slice(0, pending.length * perAnchor)) {
        const ref = row.recall_anchor_ref;
        const anchor = byRef.get(ref);
        const list = candidatesByAnchor[ref];
        if (!anchor || !list) continue;
        pageCounts.set(ref, (pageCounts.get(ref) || 0) + 1);
        const candidate = normalizeCatalogProductRow(row);
        if (!candidate || !structurallyCompatible(anchor, candidate)) {
          diagnostics.structural_rejected_count += 1;
          continue;
        }
        if (list.length < perAnchor && !list.some((item) => item.product_ref === candidate.product_ref)) list.push(candidate);
      }
      pending = pending.filter(({ anchor }) => candidatesByAnchor[anchor.product_ref].length < perAnchor &&
        pageCounts.get(anchor.product_ref) === perAnchor);
    }
  }
  const products = [...new Map(Object.values(candidatesByAnchor).flat().map((product) => [product.product_ref, product])).values()];
  diagnostics.candidate_count = Object.values(candidatesByAnchor).reduce((sum, list) => sum + list.length, 0);
  diagnostics.unique_candidate_count = products.length;
  diagnostics.queried_anchor_count = queriedRefs.size;
  diagnostics.unqueried_anchor_count = anchors.length - queriedRefs.size;
  diagnostics.query_cap_reached = diagnostics.query_count >= MAX_TARGET_RECALL_QUERIES;
  return { products, candidatesByAnchor, diagnostics };
}

module.exports = { DEFAULT_TARGET_RECALL_OPTIONS, normalizeTargetRecallOptions,
  loadProductRelationshipGraphTargetRecall, __internal: { TARGET_RECALL_SQL, targetRecallProfile, structurallyCompatible } };
