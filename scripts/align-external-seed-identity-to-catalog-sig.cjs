#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { closePool, query, withClient } = require('../src/db');

const CONFIRM_TOKEN = 'ALIGN_REVIEWED_EXTERNAL_SEED_IDENTITY_TO_CATALOG_SIG';
const REVIEWED_PRODUCT_LINE_SINGLETON_REASON = 'reviewed_product_line_singleton_catalog_sig_alignment';
const REVIEWED_OFFICIAL_URL_EXACT_CONFLICT_CLEANUP_REASON =
  'reviewed_official_url_exact_conflict_cleanup_catalog_sig_alignment';
const OFFICIAL_REVIEWED_SET_COMPONENT_REF_REASON =
  'official_reviewed_set_component_ref_identity_alignment';
const ALLOWED_PRODUCT_LINE_SINGLETON_REVIEW_REASON_CODES = new Set([
  'multi_variant_exact_item_unresolved',
  'insufficient_exact_item_evidence',
]);
const ALLOWED_OFFICIAL_URL_EXACT_CONFLICT_REVIEW_REASON_CODES = new Set([
  'conflicting_official_url',
]);
const ALLOWED_OFFICIAL_URL_EXACT_CONFLICT_MATCHED_RULES = new Set([
  'manual_reviewed_default_title_axis_cleanup',
  'official_url_axes',
]);
const ALLOWED_OFFICIAL_REVIEWED_SET_MATCHED_RULES = new Set([
  'official_url_axes',
  'official_url_route',
]);

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  return String(value || '').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map(asString).filter(Boolean)));
}

function stableHash(prefix, parts) {
  return `${prefix}_${crypto.createHash('sha1').update(JSON.stringify(parts || [])).digest('hex').slice(0, 24)}`;
}

function isSig(value) {
  return /^sig_[a-f0-9]{16,64}$/i.test(asString(value));
}

function normalizeUrlForCompare(value) {
  const raw = asString(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}${url.pathname.toLowerCase()}`;
  } catch {
    return raw.toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

function normalizeTextKey(value) {
  return asString(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function isPositiveAmount(value) {
  const numeric = normalizeAmount(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function isLiveAvailability(value) {
  const normalized = asString(value).toLowerCase();
  if (!normalized) return true;
  return !['out_of_stock', 'sold_out', 'unavailable', 'discontinued'].includes(normalized);
}

function hostnameForCompare(value) {
  const raw = asString(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function textContainsMeaningfulRef(seedTitle, refTitle) {
  const seedKey = normalizeTextKey(seedTitle);
  const refKey = normalizeTextKey(refTitle);
  if (!seedKey || !refKey) return false;
  if (seedKey.includes(refKey)) return true;
  const refTokens = refKey.split(' ').filter((token) => token.length >= 3);
  if (!refTokens.length) return false;
  return refTokens.every((token) => seedKey.split(' ').includes(token));
}

function activeVariantAxes(value) {
  const axes = asObject(value);
  return Object.entries(axes).filter(([key, raw]) => {
    if (raw === null || raw === undefined || raw === '') return false;
    if (key === 'multi_variant' && (raw === false || asString(raw).toLowerCase() === 'false')) return false;
    return true;
  });
}

function hasTerminalHold(seedData) {
  const root = asObject(seedData);
  const snapshot = asObject(root.snapshot);
  const blockers = [
    asObject(root.transaction_readiness_blocker_v1),
    asObject(snapshot.transaction_readiness_blocker_v1),
  ];
  return blockers.some((blocker) => asString(blocker.status).toLowerCase() === 'terminal_hold');
}

function evaluateReviewedProductLineSingleton(row, { allowReviewedProductLineSingletons = false } = {}) {
  const blockers = [];
  const reviewReasonCodes = uniqueStrings(asArray(row.review_reason_codes));
  const unsupportedReviewReasonCodes = reviewReasonCodes.filter(
    (code) => !ALLOWED_PRODUCT_LINE_SINGLETON_REVIEW_REASON_CODES.has(code),
  );
  const catalogCanonicalUrl = normalizeUrlForCompare(row.canonical_url);
  const seedCanonicalUrl = normalizeUrlForCompare(row.seed_canonical_url || row.destination_url);
  const officialUrl = normalizeUrlForCompare(row.official_url);
  const catalogTitleKey = normalizeTextKey(row.title);
  const seedTitleKey = normalizeTextKey(row.seed_title || row.title);
  const axes = activeVariantAxes(row.variant_axes);
  const isMultiVariantOnly =
    axes.length === 1 &&
    axes[0][0] === 'multi_variant' &&
    (axes[0][1] === true || asString(axes[0][1]).toLowerCase() === 'true');

  if (!allowReviewedProductLineSingletons) blockers.push('flag_not_enabled');
  if (asString(row.source_tier).toLowerCase() !== 'brand') blockers.push('source_tier_not_brand');
  if (asString(row.matched_by_rule) !== 'singleton_source_ref') blockers.push('unexpected_matched_by_rule');
  if (!reviewReasonCodes.includes('multi_variant_exact_item_unresolved')) {
    blockers.push('missing_multi_variant_review_reason');
  }
  if (unsupportedReviewReasonCodes.length) blockers.push('unsupported_review_reason_codes');
  if (!isMultiVariantOnly) blockers.push('variant_axes_not_multi_variant_only');
  if (!officialUrl || !catalogCanonicalUrl || officialUrl !== catalogCanonicalUrl) {
    blockers.push('official_url_mismatch');
  }
  if (seedCanonicalUrl && catalogCanonicalUrl && seedCanonicalUrl !== catalogCanonicalUrl) {
    blockers.push('seed_canonical_url_mismatch');
  }
  if (!catalogTitleKey || !seedTitleKey || catalogTitleKey !== seedTitleKey) {
    blockers.push('seed_title_mismatch');
  }
  if (hasTerminalHold(row.seed_data)) blockers.push('terminal_hold_present');

  return {
    eligible: blockers.length === 0,
    blockers,
    evidence: {
      source_tier: asString(row.source_tier),
      matched_by_rule: asString(row.matched_by_rule),
      review_reason_codes: reviewReasonCodes,
      variant_axes: asObject(row.variant_axes),
      official_url: asString(row.official_url),
      canonical_url: asString(row.canonical_url),
      seed_canonical_url: asString(row.seed_canonical_url || row.destination_url),
      title: asString(row.title),
      seed_title: asString(row.seed_title || row.title),
    },
  };
}

function evaluateReviewedOfficialUrlExactConflictCleanup(
  row,
  { allowOfficialUrlExactConflictCleanup = false } = {},
) {
  const blockers = [];
  const reviewReasonCodes = uniqueStrings(asArray(row.review_reason_codes));
  const unsupportedReviewReasonCodes = reviewReasonCodes.filter(
    (code) => !ALLOWED_OFFICIAL_URL_EXACT_CONFLICT_REVIEW_REASON_CODES.has(code),
  );
  const catalogCanonicalUrl = normalizeUrlForCompare(row.canonical_url);
  const seedCanonicalUrl = normalizeUrlForCompare(row.seed_canonical_url || row.destination_url);
  const officialUrl = normalizeUrlForCompare(row.official_url);
  const catalogTitleKey = normalizeTextKey(row.title);
  const seedTitleKey = normalizeTextKey(row.seed_title || row.title);
  const matchedByRule = asString(row.matched_by_rule);

  if (!allowOfficialUrlExactConflictCleanup) blockers.push('flag_not_enabled');
  if (asString(row.source_tier).toLowerCase() !== 'brand') blockers.push('source_tier_not_brand');
  if (!ALLOWED_OFFICIAL_URL_EXACT_CONFLICT_MATCHED_RULES.has(matchedByRule)) {
    blockers.push('unexpected_matched_by_rule');
  }
  if (!reviewReasonCodes.includes('conflicting_official_url')) {
    blockers.push('missing_conflicting_official_url_review_reason');
  }
  if (unsupportedReviewReasonCodes.length) blockers.push('unsupported_review_reason_codes');
  if (!officialUrl || !catalogCanonicalUrl || officialUrl !== catalogCanonicalUrl) {
    blockers.push('official_url_mismatch');
  }
  if (seedCanonicalUrl && catalogCanonicalUrl && seedCanonicalUrl !== catalogCanonicalUrl) {
    blockers.push('seed_canonical_url_mismatch');
  }
  if (!catalogTitleKey || !seedTitleKey || catalogTitleKey !== seedTitleKey) {
    blockers.push('seed_title_mismatch');
  }
  if (hasTerminalHold(row.seed_data)) blockers.push('terminal_hold_present');

  return {
    eligible: blockers.length === 0,
    blockers,
    evidence: {
      source_tier: asString(row.source_tier),
      matched_by_rule: matchedByRule,
      review_reason_codes: reviewReasonCodes,
      variant_axes: asObject(row.variant_axes),
      official_url: asString(row.official_url),
      canonical_url: asString(row.canonical_url),
      seed_canonical_url: asString(row.seed_canonical_url || row.destination_url),
      title: asString(row.title),
      seed_title: asString(row.seed_title || row.title),
    },
  };
}

function evaluateOfficialReviewedSetComponentRefs(
  row,
  { allowOfficialReviewedSetComponentRefs = false } = {},
) {
  const blockers = [];
  const catalogCanonicalUrl = normalizeUrlForCompare(row.canonical_url);
  const seedCanonicalUrl = normalizeUrlForCompare(row.seed_canonical_url || row.destination_url);
  const officialUrl = normalizeUrlForCompare(row.official_url);
  const catalogTitleKey = normalizeTextKey(row.title);
  const seedTitleKey = normalizeTextKey(row.seed_title || row.title);
  const matchedByRule = asString(row.matched_by_rule);
  const parentPrice = normalizeAmount(row.price_amount);
  const parentHost = hostnameForCompare(row.canonical_url || row.seed_canonical_url || row.destination_url);
  const components = asArray(row.components).filter(
    (component) => asString(component.external_product_id || component.product_id || component.ref_title),
  );
  const componentIds = components.map((component) =>
    asString(component.external_product_id || component.product_id),
  );
  const uniqueComponentIds = new Set(componentIds.filter(Boolean));
  const componentPrices = components.map((component) =>
    normalizeAmount(component.max_list_price ?? component.price_amount),
  );
  const maxComponentPrice = componentPrices.reduce(
    (max, price) => (Number.isFinite(price) && price > max ? price : max),
    0,
  );
  const totalComponentPrice = componentPrices.reduce(
    (sum, price) => sum + (Number.isFinite(price) && price > 0 ? price : 0),
    0,
  );

  if (!allowOfficialReviewedSetComponentRefs) blockers.push('flag_not_enabled');
  if (asString(row.source_tier).toLowerCase() !== 'brand') blockers.push('source_tier_not_brand');
  if (!ALLOWED_OFFICIAL_REVIEWED_SET_MATCHED_RULES.has(matchedByRule)) {
    blockers.push('unexpected_matched_by_rule');
  }
  if (!officialUrl || !catalogCanonicalUrl || officialUrl !== catalogCanonicalUrl) {
    blockers.push('official_url_mismatch');
  }
  if (seedCanonicalUrl && catalogCanonicalUrl && seedCanonicalUrl !== catalogCanonicalUrl) {
    blockers.push('seed_canonical_url_mismatch');
  }
  if (!catalogTitleKey || !seedTitleKey || catalogTitleKey !== seedTitleKey) {
    blockers.push('seed_title_mismatch');
  }
  if (hasTerminalHold(row.seed_data)) blockers.push('terminal_hold_present');
  if (!isPositiveAmount(parentPrice)) blockers.push('missing_parent_price');
  if (!isLiveAvailability(row.availability)) blockers.push('parent_not_live_available');
  if (asString(row.product_sync_status).toLowerCase() !== 'live') blockers.push('catalog_not_live');
  if (components.length < 2) blockers.push('insufficient_component_refs');
  if (uniqueComponentIds.size !== components.length) blockers.push('duplicate_or_missing_component_ids');
  if (parentPrice > 0 && maxComponentPrice > parentPrice * 2) {
    blockers.push('component_price_outlier');
  }
  if (parentPrice > 0 && totalComponentPrice > parentPrice * 3) {
    blockers.push('component_total_price_outlier');
  }

  for (const component of components) {
    const componentId = asString(component.external_product_id || component.product_id);
    const refTitle = asString(component.ref_title);
    const seedTitle = asString(component.seed_title);
    const componentHost = hostnameForCompare(
      component.canonical_url || component.destination_url || component.ref_canonical_url,
    );
    if (!componentId) blockers.push('component_missing_external_product_id');
    if (asString(component.review_state).toLowerCase() !== 'reviewed') {
      blockers.push('component_not_reviewed');
    }
    if (asString(component.status).toLowerCase() !== 'active') blockers.push('component_not_active');
    if (asString(component.sync_status).toLowerCase() !== 'live') blockers.push('component_catalog_not_live');
    if (!isPositiveAmount(component.max_list_price ?? component.price_amount)) {
      blockers.push('component_missing_price');
    }
    if (!isLiveAvailability(component.availability)) blockers.push('component_not_live_available');
    if (parentHost && componentHost && parentHost !== componentHost) blockers.push('component_domain_mismatch');
    if (!textContainsMeaningfulRef(seedTitle, refTitle)) blockers.push('component_ref_title_mismatch');
  }

  return {
    eligible: blockers.length === 0,
    blockers: uniqueStrings(blockers),
    evidence: {
      source_tier: asString(row.source_tier),
      matched_by_rule: matchedByRule,
      official_url: asString(row.official_url),
      canonical_url: asString(row.canonical_url),
      seed_canonical_url: asString(row.seed_canonical_url || row.destination_url),
      title: asString(row.title),
      seed_title: asString(row.seed_title || row.title),
      parent_price: parentPrice,
      parent_availability: asString(row.availability),
      component_ref_count: components.length,
      max_component_price: maxComponentPrice || null,
      total_component_price: totalComponentPrice || null,
      components: components.map((component) => ({
        external_product_id: asString(component.external_product_id || component.product_id),
        ref_title: asString(component.ref_title),
        seed_title: asString(component.seed_title),
        review_state: asString(component.review_state),
        price_amount: normalizeAmount(component.price_amount),
        max_list_price: normalizeAmount(component.max_list_price),
        availability: asString(component.availability),
        canonical_url: asString(component.canonical_url),
      })),
    },
  };
}

async function fetchRows(externalProductIds) {
  const result = await query(
    `
      SELECT
        cp.product_key,
        cp.merchant_id,
        cp.platform,
        cp.source_product_id,
        cp.title,
        cp.brand,
        cp.canonical_url,
        cp.sync_status AS product_sync_status,
        cp.pivota_signature_id AS catalog_sig_id,
        cp.pivota_canonical_url AS catalog_sig_url,
        cp.content_key,
        eps.title AS seed_title,
        eps.canonical_url AS seed_canonical_url,
        eps.destination_url,
        eps.price_amount,
        eps.availability,
        COALESCE(eps.seed_data, '{}'::jsonb) AS seed_data,
        COALESCE(component_refs.components, '[]'::jsonb) AS components,
        pgm.product_group_id,
        pgm.is_primary,
        pil.source_listing_ref,
        pil.sellable_item_group_id AS identity_sig_id,
        pil.product_line_id,
        pil.review_family_id,
        pil.identity_status,
        pil.live_read_enabled,
        pil.review_required,
        pil.review_reason_codes,
        pil.source_tier,
        pil.official_url,
        pil.matched_by_rule,
        pil.match_basis,
        pil.strong_identity,
        pil.variant_axes
      FROM catalog_products cp
      LEFT JOIN external_product_seeds eps
        ON eps.external_product_id = cp.source_product_id
      LEFT JOIN product_group_members pgm
        ON pgm.merchant_id = cp.merchant_id
       AND pgm.platform = cp.platform
       AND pgm.platform_product_id = cp.source_product_id
      LEFT JOIN pdp_identity_listing pil
        ON pil.merchant_id = cp.merchant_id
       AND pil.product_id = cp.source_product_id
      LEFT JOIN LATERAL (
        WITH raw_refs AS (
          SELECT
            CASE
              WHEN jsonb_typeof(eps.seed_data->'bundle_component_refs') = 'array'
                THEN eps.seed_data->'bundle_component_refs'
              WHEN jsonb_typeof(eps.seed_data#>ARRAY['snapshot','bundle_component_refs']) = 'array'
                THEN eps.seed_data#>ARRAY['snapshot','bundle_component_refs']
              ELSE '[]'::jsonb
            END AS refs
        ),
        refs AS (
          SELECT
            ref->>'external_product_id' AS external_product_id,
            ref->>'product_id' AS product_id,
            ref->>'title' AS ref_title,
            ref->>'canonical_url' AS ref_canonical_url,
            ref->>'source_url' AS ref_source_url,
            ref->>'review_state' AS review_state
          FROM raw_refs
          LEFT JOIN LATERAL jsonb_array_elements(raw_refs.refs) AS ref ON true
        ),
        component_rows AS (
          SELECT
            refs.external_product_id,
            refs.product_id,
            refs.ref_title,
            refs.ref_canonical_url,
            refs.ref_source_url,
            refs.review_state,
            ce.title AS seed_title,
            ce.domain,
            ce.status,
            ce.canonical_url,
            ce.destination_url,
            ce.price_amount,
            ce.availability,
            ccp.sync_status,
            os.max_list_price
          FROM refs
          LEFT JOIN external_product_seeds ce
            ON ce.external_product_id = COALESCE(refs.external_product_id, refs.product_id)
          LEFT JOIN catalog_products ccp
            ON ccp.merchant_id = 'external_seed'
           AND ccp.platform = 'external_seed'
           AND ccp.source_product_id = COALESCE(refs.external_product_id, refs.product_id)
          LEFT JOIN LATERAL (
            SELECT max(co.list_price) FILTER (WHERE co.list_price > 0) AS max_list_price
            FROM catalog_offers co
            WHERE co.product_key = ccp.product_key
          ) os ON true
        )
        SELECT
          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'external_product_id', component_rows.external_product_id,
                'product_id', component_rows.product_id,
                'ref_title', component_rows.ref_title,
                'ref_canonical_url', component_rows.ref_canonical_url,
                'ref_source_url', component_rows.ref_source_url,
                'review_state', component_rows.review_state,
                'seed_title', component_rows.seed_title,
                'domain', component_rows.domain,
                'status', component_rows.status,
                'canonical_url', component_rows.canonical_url,
                'destination_url', component_rows.destination_url,
                'price_amount', component_rows.price_amount,
                'availability', component_rows.availability,
                'sync_status', component_rows.sync_status,
                'max_list_price', component_rows.max_list_price
              )
              ORDER BY component_rows.ref_title, component_rows.external_product_id, component_rows.product_id
            ) FILTER (
              WHERE component_rows.ref_title IS NOT NULL
                 OR component_rows.external_product_id IS NOT NULL
                 OR component_rows.product_id IS NOT NULL
            ),
            '[]'::jsonb
          ) AS components
        FROM component_rows
      ) component_refs ON true
      WHERE cp.merchant_id = 'external_seed'
        AND cp.source_product_id = ANY($1::text[])
      ORDER BY array_position($1::text[], cp.source_product_id::text)
    `,
    [externalProductIds],
  );
  return result.rows || [];
}

function buildPlans(rows, options = {}) {
  return rows.map((row) => {
    const blockers = [];
    const sourceRef = asString(row.source_listing_ref) || `external_seed:${asString(row.source_product_id)}`;
    const catalogSig = asString(row.catalog_sig_id);
    const reviewRequired = row.review_required === true || asString(row.identity_status) === 'review_required';
    const reviewedProductLineSingleton = reviewRequired
      ? evaluateReviewedProductLineSingleton(row, options)
      : { eligible: false, blockers: [], evidence: null };
    const reviewedOfficialUrlExactConflictCleanup = reviewRequired
      ? evaluateReviewedOfficialUrlExactConflictCleanup(row, options)
      : { eligible: false, blockers: [], evidence: null };
    const officialReviewedSetComponentRefs = reviewRequired
      ? evaluateOfficialReviewedSetComponentRefs(row, options)
      : { eligible: false, blockers: [], evidence: null };
    if (!asString(row.source_product_id)) blockers.push('missing_source_product_id');
    if (!asString(row.product_key)) blockers.push('missing_catalog_product');
    if (!asString(row.source_listing_ref)) blockers.push('missing_identity_listing');
    if (!isSig(catalogSig)) blockers.push('invalid_catalog_sig');
    if (reviewRequired) {
      const allowedByReviewedProductLineSingleton =
        options.allowReviewedProductLineSingletons && reviewedProductLineSingleton.eligible;
      const allowedByOfficialUrlExactConflictCleanup =
        options.allowOfficialUrlExactConflictCleanup && reviewedOfficialUrlExactConflictCleanup.eligible;
      const allowedByOfficialReviewedSetComponentRefs =
        options.allowOfficialReviewedSetComponentRefs && officialReviewedSetComponentRefs.eligible;
      if (
        !allowedByReviewedProductLineSingleton &&
        !allowedByOfficialUrlExactConflictCleanup &&
        !allowedByOfficialReviewedSetComponentRefs
      ) {
        const hasReviewedGate =
          options.allowReviewedProductLineSingletons ||
          options.allowOfficialUrlExactConflictCleanup ||
          options.allowOfficialReviewedSetComponentRefs;
        if (!hasReviewedGate) {
          blockers.push('identity_review_required');
        } else {
          if (options.allowReviewedProductLineSingletons) {
            blockers.push(
              ...reviewedProductLineSingleton.blockers.map(
                (blocker) => `reviewed_product_line_singleton_${blocker}`,
              ),
            );
          }
          if (options.allowOfficialUrlExactConflictCleanup) {
            blockers.push(
              ...reviewedOfficialUrlExactConflictCleanup.blockers.map(
                (blocker) => `reviewed_official_url_exact_conflict_cleanup_${blocker}`,
              ),
            );
          }
          if (options.allowOfficialReviewedSetComponentRefs) {
            blockers.push(
              ...officialReviewedSetComponentRefs.blockers.map(
                (blocker) => `official_reviewed_set_component_ref_${blocker}`,
              ),
            );
          }
        }
      }
    }
    const needsUpdate =
      blockers.length === 0 &&
      (asString(row.identity_sig_id) !== catalogSig ||
        row.live_read_enabled !== true ||
        asString(row.identity_status) !== 'approved' ||
        row.review_required === true ||
        JSON.stringify(row.review_reason_codes || []) !== '[]');
    return {
      action: blockers.length ? 'hold' : needsUpdate ? 'align_ready' : 'already_aligned',
      blockers,
      product_key: asString(row.product_key),
      source_listing_ref: sourceRef,
      external_product_id: asString(row.source_product_id),
      title: asString(row.title),
      brand: asString(row.brand),
      canonical_url: asString(row.canonical_url),
      product_group_id: asString(row.product_group_id),
      is_primary: row.is_primary === true,
      content_key: asString(row.content_key),
      catalog_sig_id: catalogSig,
      catalog_sig_url: asString(row.catalog_sig_url) || `https://agent.pivota.cc/products/${catalogSig}`,
      identity_sig_id_before: asString(row.identity_sig_id),
      product_line_id: asString(row.product_line_id),
      review_family_id: asString(row.review_family_id),
      identity_status_before: asString(row.identity_status),
      live_read_enabled_before: row.live_read_enabled === true,
      review_required_before: row.review_required === true,
      review_reason_codes_before: row.review_reason_codes || [],
      reviewed_product_line_singleton: reviewedProductLineSingleton,
      reviewed_official_url_exact_conflict_cleanup: reviewedOfficialUrlExactConflictCleanup,
      official_reviewed_set_component_ref: officialReviewedSetComponentRefs,
      needs_update: needsUpdate,
    };
  });
}

async function applyPlans(plans, reviewedBy) {
  const ready = plans.filter((plan) => plan.action === 'align_ready');
  const totals = { override_upserts: 0, identity_rows_updated: 0 };
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      await client.query(`SET LOCAL statement_timeout = '45s'`);
      for (const plan of ready) {
        const reviewReason = plan.reviewed_product_line_singleton?.eligible
          ? REVIEWED_PRODUCT_LINE_SINGLETON_REASON
          : plan.reviewed_official_url_exact_conflict_cleanup?.eligible
            ? REVIEWED_OFFICIAL_URL_EXACT_CONFLICT_CLEANUP_REASON
            : plan.official_reviewed_set_component_ref?.eligible
              ? OFFICIAL_REVIEWED_SET_COMPONENT_REF_REASON
              : 'reviewed_external_seed_identity_catalog_sig_alignment';
        const reviewGateEvidence = plan.reviewed_product_line_singleton?.eligible
          ? plan.reviewed_product_line_singleton.evidence
          : plan.reviewed_official_url_exact_conflict_cleanup?.eligible
            ? plan.reviewed_official_url_exact_conflict_cleanup.evidence
            : plan.official_reviewed_set_component_ref?.eligible
              ? plan.official_reviewed_set_component_ref.evidence
              : null;
        const payload = {
          source_listing_ref: plan.source_listing_ref,
          source_sellable_item_group_id: plan.identity_sig_id_before || null,
          target_sellable_item_group_id: plan.catalog_sig_id,
          target_product_group_id: plan.product_group_id || null,
          external_product_id: plan.external_product_id,
          product_key: plan.product_key,
          canonical_url: plan.canonical_url,
          catalog_sig_url: plan.catalog_sig_url,
          reason: reviewReason,
          review_gate_evidence: reviewGateEvidence,
          reviewed_by: reviewedBy,
          reviewed_at: new Date().toISOString(),
        };
        const overrideId = stableHash('ovr', [
          'reviewed_external_seed_identity_catalog_sig_alignment',
          plan.source_listing_ref,
          plan.catalog_sig_id,
        ]);
        await client.query(
          `
            INSERT INTO pdp_identity_override (
              id,
              source_listing_ref,
              action_type,
              payload,
              created_by,
              active,
              updated_at
            ) VALUES ($1,$2,'force_exact_group',$3::jsonb,$4,true,now())
            ON CONFLICT (id) DO UPDATE SET
              payload = EXCLUDED.payload,
              created_by = EXCLUDED.created_by,
              active = EXCLUDED.active,
              updated_at = now()
          `,
          [overrideId, plan.source_listing_ref, JSON.stringify(payload), reviewedBy],
        );
        totals.override_upserts += 1;
        const update = await client.query(
          `
            UPDATE pdp_identity_listing
            SET
              sellable_item_group_id = $2,
              identity_status = 'approved',
              live_read_enabled = true,
              review_required = false,
              review_reason_codes = '[]'::jsonb,
              matched_by_rule = 'reviewed_external_seed_identity_catalog_sig_alignment',
              match_basis = COALESCE(match_basis, '[]'::jsonb) || $3::jsonb,
              strong_identity = COALESCE(strong_identity, '{}'::jsonb) || $4::jsonb,
              review_summary = COALESCE(review_summary, '{}'::jsonb) || $5::jsonb,
              updated_at = now()
            WHERE source_listing_ref = $1
          `,
          [
            plan.source_listing_ref,
            plan.catalog_sig_id,
            JSON.stringify([
              `reviewed_catalog_sig_alignment:${plan.catalog_sig_id}`,
              `product_group_id:${plan.product_group_id || ''}`,
              ...(plan.reviewed_product_line_singleton?.eligible
                ? [`${REVIEWED_PRODUCT_LINE_SINGLETON_REASON}:official_url_title_variant_guard`]
                : []),
              ...(plan.reviewed_official_url_exact_conflict_cleanup?.eligible
                ? [`${REVIEWED_OFFICIAL_URL_EXACT_CONFLICT_CLEANUP_REASON}:official_url_title_guard`]
                : []),
              ...(plan.official_reviewed_set_component_ref?.eligible
                ? [`${OFFICIAL_REVIEWED_SET_COMPONENT_REF_REASON}:official_url_component_price_guard`]
                : []),
            ]),
            JSON.stringify({
              canonical_sig_id: plan.catalog_sig_id,
              product_group_id: plan.product_group_id || null,
              reviewed_external_seed_identity_catalog_sig_alignment_v1: payload,
            }),
            JSON.stringify({ reviewed_external_seed_identity_catalog_sig_alignment_v1: payload }),
          ],
        );
        totals.identity_rows_updated += Number(update.rowCount || 0);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
  return totals;
}

async function main() {
  const externalProductIds = uniqueStrings(
    asString(argValue('external-product-ids'))
      .split(',')
      .map((item) => item.trim()),
  );
  const out = asString(argValue('out'));
  const write = hasFlag('write');
  const confirm = asString(argValue('confirm'));
  const reviewedBy = asString(argValue('reviewed-by')) || 'codex';
  const allowReviewedProductLineSingletons = hasFlag('allow-reviewed-product-line-singletons');
  const allowOfficialUrlExactConflictCleanup = hasFlag('allow-official-url-exact-conflict-cleanup');
  const allowOfficialReviewedSetComponentRefs = hasFlag('allow-official-reviewed-set-component-refs');
  if (!externalProductIds.length) throw new Error('Missing --external-product-ids');
  if (write && confirm !== CONFIRM_TOKEN) throw new Error(`Refusing write without --confirm ${CONFIRM_TOKEN}`);
  const rows = await fetchRows(externalProductIds);
  const seenIds = new Set(rows.map((row) => asString(row.source_product_id)));
  const missingIds = externalProductIds.filter((id) => !seenIds.has(id));
  const plans = buildPlans(rows, {
    allowReviewedProductLineSingletons,
    allowOfficialUrlExactConflictCleanup,
    allowOfficialReviewedSetComponentRefs,
  });
  const held = plans.filter((plan) => plan.action === 'hold');
  const ready = plans.filter((plan) => plan.action === 'align_ready');
  const applied = write ? await applyPlans(plans, reviewedBy) : { override_upserts: 0, identity_rows_updated: 0 };
  const report = {
    status: held.length || missingIds.length ? 'blocked' : 'success',
    mode: write ? 'write' : 'dry_run',
    generated_at: new Date().toISOString(),
    external_product_ids: externalProductIds,
    options: {
      allow_reviewed_product_line_singletons: allowReviewedProductLineSingletons,
      allow_official_url_exact_conflict_cleanup: allowOfficialUrlExactConflictCleanup,
      allow_official_reviewed_set_component_refs: allowOfficialReviewedSetComponentRefs,
    },
    rows_seen: rows.length,
    missing_ids: missingIds,
    align_ready_count: ready.length,
    already_aligned_count: plans.filter((plan) => plan.action === 'already_aligned').length,
    held_count: held.length,
    applied,
    blockers: [
      ...missingIds.map((id) => ({ external_product_id: id, blockers: ['missing_catalog_product'] })),
      ...held.map((plan) => ({
        external_product_id: plan.external_product_id,
        blockers: plan.blockers,
      })),
    ],
    plans,
  };
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'blocked') process.exitCode = 2;
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
    });
}

module.exports = {
  CONFIRM_TOKEN,
  REVIEWED_PRODUCT_LINE_SINGLETON_REASON,
  REVIEWED_OFFICIAL_URL_EXACT_CONFLICT_CLEANUP_REASON,
  OFFICIAL_REVIEWED_SET_COMPONENT_REF_REASON,
  buildPlans,
  evaluateReviewedProductLineSingleton,
  evaluateReviewedOfficialUrlExactConflictCleanup,
  evaluateOfficialReviewedSetComponentRefs,
  normalizeUrlForCompare,
};
