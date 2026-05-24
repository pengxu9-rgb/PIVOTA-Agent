#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return '';
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : '';
}

function hasArg(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parsePositiveInt(value, fallback, { allowZero = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  if (parsed === 0 && allowZero) return 0;
  if (parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function inc(map, key, amount = 1) {
  const normalized = asString(key) || 'unknown';
  map[normalized] = (map[normalized] || 0) + amount;
}

function topEntries(map, limit = 50) {
  return Object.entries(map || {})
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function coerceObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    return asObject(JSON.parse(value));
  } catch {
    return {};
  }
}

function collectQualityRows(payload) {
  const productPayload = coerceObject(payload);
  const seedData = coerceObject(productPayload.seed_data);
  const snapshot = coerceObject(seedData.snapshot);
  return [
    coerceObject(productPayload.pdp_field_quality_summary),
    coerceObject(seedData.pdp_field_quality_summary),
    coerceObject(snapshot.pdp_field_quality_summary),
  ].filter((item) => Object.keys(item).length > 0);
}

function classifyContentQuality(row) {
  const payload = coerceObject(row.product_payload);
  const summaries = collectQualityRows(payload);
  const joinedQualityText = JSON.stringify(summaries).toLowerCase();
  const hasApproved = /(reviewed|manual_reviewed|published|seller_grounded|official_authoritative|authoritative)/i
    .test(joinedQualityText);
  const hasWeak = /(polluted|generic|synthetic|mock|legacy|fallback|force[_\s-]?fill|low_quality|blocked)/i
    .test(joinedQualityText);
  const snapshot = coerceObject(coerceObject(payload.seed_data).snapshot);
  const seedData = coerceObject(payload.seed_data);
  const hasCoreContent = Boolean(
    asString(payload.pdp_description_raw || seedData.pdp_description_raw || snapshot.pdp_description_raw) ||
      asString(payload.pdp_how_to_use_raw || seedData.pdp_how_to_use_raw || snapshot.pdp_how_to_use_raw) ||
      asArray(payload.pdp_details_sections || seedData.pdp_details_sections || snapshot.pdp_details_sections).length ||
      asString(payload.pdp_ingredients_raw || seedData.pdp_ingredients_raw || snapshot.pdp_ingredients_raw),
  );

  if (hasApproved && !hasWeak) return 'reviewed_or_authoritative';
  if (hasWeak) return 'content_low_quality_drift';
  if (hasCoreContent) return 'content_present_unreviewed';
  return 'content_missing_or_unfilled';
}

function buildWhere(options, params) {
  const where = [
    `cp.pivota_signature_id IS NOT NULL`,
    `cp.pivota_signature_id LIKE 'sig\\_%' ESCAPE '\\'`,
    `cp.merchant_id = 'external_seed'`,
    `cp.platform = 'external_seed'`,
  ];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (options.sig) where.push(`cp.pivota_signature_id = ${bind(options.sig)}`);
  if (options.externalProductId) where.push(`cp.source_product_id = ${bind(options.externalProductId)}`);
  if (options.brand) where.push(`lower(coalesce(cp.brand, eps.seed_data->>'brand', eps.seed_data->'snapshot'->>'brand', '')) = lower(${bind(options.brand)})`);
  if (options.domain) where.push(`eps.domain = ${bind(options.domain)}`);
  if (options.market) where.push(`coalesce(eps.market, 'US') = ${bind(options.market)}`);
  if (!options.includeInactive) {
    where.push(`coalesce(eps.status, 'active') = 'active'`);
    where.push(`coalesce(cp.sync_status, 'active') <> 'archived'`);
  }
  return where;
}

async function fetchRows(options) {
  const params = [];
  const where = buildWhere(options, params);
  let limitSql = '';
  if (options.limit > 0) {
    params.push(options.limit);
    limitSql = `LIMIT $${params.length}`;
  }
  const result = await query(
    `
      SELECT
        cp.product_key,
        cp.pivota_signature_id AS requested_sig,
        cp.source_product_id AS source_ext,
        cp.title,
        cp.brand,
        cp.category_path,
        cp.product_payload,
        eps.domain,
        eps.market,
        eps.destination_url,
        pil.sellable_item_group_id AS identity_sellable_item_group_id,
        pil.product_line_id,
        pil.review_family_id,
        pil.identity_confidence,
        pil.match_basis,
        COALESCE(identity_members.identity_group_members_count, 0)::int AS identity_group_members_count,
        COALESCE(identity_members.identity_group_member_refs, '[]'::jsonb) AS identity_group_member_refs,
        COALESCE(catalog_offer_stats.catalog_offers_count, 0)::int AS catalog_offers_count,
        COALESCE(catalog_offer_stats.catalog_offer_merchants_count, 0)::int AS catalog_offer_merchants_count,
        COALESCE(catalog_offer_stats.catalog_offer_refs, '[]'::jsonb) AS catalog_offer_refs
      FROM catalog_products cp
      LEFT JOIN external_product_seeds eps
        ON eps.external_product_id = cp.source_product_id
      LEFT JOIN pdp_identity_listing pil
        ON pil.source_listing_ref = 'external_seed:' || cp.source_product_id
       AND pil.identity_status = 'approved'
       AND pil.live_read_enabled IS TRUE
       AND COALESCE(pil.review_required, false) IS NOT TRUE
      LEFT JOIN LATERAL (
        SELECT
          count(*)::int AS identity_group_members_count,
          jsonb_agg(
            jsonb_build_object(
              'source_listing_ref', m.source_listing_ref,
              'merchant_id', m.merchant_id,
              'product_id', m.product_id,
              'source_tier', m.source_tier
            )
            ORDER BY CASE WHEN m.source_tier = 'brand' THEN 0 ELSE 1 END, m.source_listing_ref
          ) AS identity_group_member_refs
        FROM pdp_identity_listing m
        WHERE NULLIF(pil.sellable_item_group_id, '') IS NOT NULL
          AND m.sellable_item_group_id = pil.sellable_item_group_id
          AND m.identity_status = 'approved'
          AND m.live_read_enabled IS TRUE
          AND COALESCE(m.review_required, false) IS NOT TRUE
      ) identity_members ON true
      LEFT JOIN LATERAL (
        SELECT
          count(DISTINCT o.offer_id)::int AS catalog_offers_count,
          count(DISTINCT o.merchant_id)::int AS catalog_offer_merchants_count,
          jsonb_agg(DISTINCT jsonb_build_object(
            'offer_id', o.offer_id,
            'merchant_id', o.merchant_id,
            'source_product_id', cp2.source_product_id,
            'currency', o.currency,
            'price', COALESCE(o.merchant_effective_price, o.estimated_best_price, o.list_price)
          )) FILTER (WHERE o.offer_id IS NOT NULL) AS catalog_offer_refs
        FROM pdp_identity_listing m
        JOIN catalog_products cp2
          ON cp2.merchant_id = m.merchant_id
         AND cp2.source_product_id = m.product_id
        LEFT JOIN catalog_skus s ON s.product_key = cp2.product_key
        LEFT JOIN catalog_offers o ON o.sku_key = s.sku_key
        WHERE NULLIF(pil.sellable_item_group_id, '') IS NOT NULL
          AND m.sellable_item_group_id = pil.sellable_item_group_id
          AND m.identity_status = 'approved'
          AND m.live_read_enabled IS TRUE
          AND COALESCE(m.review_required, false) IS NOT TRUE
      ) catalog_offer_stats ON true
      WHERE ${where.join('\n        AND ')}
      ORDER BY cp.updated_at DESC NULLS LAST, cp.created_at DESC NULLS LAST
      ${limitSql}
    `,
    params,
  );
  return result.rows || [];
}

async function probeRuntime({ baseUrl, sig, debug = false }) {
  const url = baseUrl.replace(/\/$/, '');
  const authToken = asString(
    process.env.SHOP_GATEWAY_AGENT_API_KEY ||
      process.env.PIVOTA_AGENT_API_KEY ||
      process.env.AGENT_API_KEY ||
      process.env.PIVOTA_API_KEY,
  );
  const body = {
    operation: 'get_pdp_v2',
    payload: {
      include: ['offers'],
      product_ref: { merchant_id: 'external_seed', product_id: sig },
      options: { no_cache: true },
      ...(debug ? { debug: true } : {}),
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authToken ? { 'x-agent-api-key': authToken } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return {
      runtime_status: 'probe_failed',
      runtime_error: `http_${res.status}`,
    };
  }
  const payload = await res.json();
  const offersModule = asArray(payload.modules).find((module) => module?.type === 'offers');
  const canonicalModule = asArray(payload.modules).find((module) => module?.type === 'canonical');
  const offersData = asObject(offersModule?.data);
  const canonicalData = asObject(canonicalModule?.data);
  return {
    runtime_status: 'ok',
    runtime_offers_count: Number(offersData.offers_count || payload.offers_count || 0) || 0,
    runtime_offer_source: asString(offersData.offer_source || canonicalData.offer_source),
    runtime_sellable_item_group_id: asString(canonicalData.sellable_item_group_id),
    runtime_product_group_id: asString(canonicalData.product_group_id),
    runtime_default_offer_id: asString(offersData.default_offer_id),
  };
}

function classifyRow(row, runtime) {
  const blockingReasons = [];
  const contentQualityBucket = classifyContentQuality(row);
  const identityGroupId = asString(row.identity_sellable_item_group_id);
  const identityGroupMembersCount = Number(row.identity_group_members_count || 0) || 0;
  const catalogOffersCount = Number(row.catalog_offers_count || 0) || 0;
  const runtimeOffersCount = runtime ? Number(runtime.runtime_offers_count || 0) || 0 : null;
  const runtimeOfferSource = runtime ? asString(runtime.runtime_offer_source) : '';

  if (identityGroupId && identityGroupMembersCount === 0) blockingReasons.push('group_members_missing');
  if (identityGroupMembersCount > 1 && catalogOffersCount < 2) blockingReasons.push('catalog_offers_missing');
  if (runtime && identityGroupMembersCount > 1 && runtimeOfferSource === 'self') {
    blockingReasons.push('self_offer_fallback_leak');
  }
  if (runtime && identityGroupMembersCount > 1 && runtimeOffersCount < 2) {
    blockingReasons.push('identity_ready_offer_not_fused');
  }
  if (contentQualityBucket === 'content_low_quality_drift') blockingReasons.push('content_low_quality_drift');
  if (!identityGroupId) blockingReasons.push('identity_missing');

  let bucket = 'ready_multi_merchant';
  if (!identityGroupId) bucket = 'identity_missing';
  else if (identityGroupMembersCount === 0) bucket = 'group_members_missing';
  else if (identityGroupMembersCount > 1 && catalogOffersCount < 2) bucket = 'catalog_offers_missing';
  else if (runtime && identityGroupMembersCount > 1 && runtimeOffersCount < 2) bucket = 'identity_ready_offer_not_fused';
  else if (contentQualityBucket === 'content_low_quality_drift') bucket = 'content_donor_mismatch';
  else if (identityGroupMembersCount <= 1) bucket = 'single_seller_or_no_verified_merge';

  return {
    requested_sig: asString(row.requested_sig),
    source_ext: asString(row.source_ext),
    title: asString(row.title),
    brand: asString(row.brand),
    domain: asString(row.domain),
    market: asString(row.market),
    category_path: asString(row.category_path),
    identity_sellable_item_group_id: identityGroupId || null,
    product_line_id: asString(row.product_line_id) || null,
    review_family_id: asString(row.review_family_id) || null,
    content_canonical_ref: null,
    selected_commerce_ref: row.source_ext ? { merchant_id: 'external_seed', product_id: asString(row.source_ext) } : null,
    identity_group_members_count: identityGroupMembersCount,
    catalog_offers_count: catalogOffersCount,
    catalog_offer_merchants_count: Number(row.catalog_offer_merchants_count || 0) || 0,
    runtime_offers_count: runtimeOffersCount,
    runtime_offer_source: runtimeOfferSource || null,
    runtime_status: runtime ? asString(runtime.runtime_status) || null : null,
    runtime_error: runtime ? asString(runtime.runtime_error) || null : null,
    runtime_sellable_item_group_id: runtime ? asString(runtime.runtime_sellable_item_group_id) || null : null,
    content_quality_bucket: contentQualityBucket,
    merge_offer_bucket: bucket,
    blocking_reasons: Array.from(new Set(blockingReasons)),
    identity_group_member_refs: row.identity_group_member_refs || [],
    catalog_offer_refs: row.catalog_offer_refs || [],
  };
}

function summarize(rows) {
  const byBucket = {};
  const byReason = {};
  const byBrand = {};
  const byDomain = {};
  for (const row of rows) {
    inc(byBucket, row.merge_offer_bucket);
    inc(byBrand, row.brand || 'unknown');
    inc(byDomain, row.domain || 'unknown');
    for (const reason of row.blocking_reasons) inc(byReason, reason);
  }
  return {
    scanned: rows.length,
    by_bucket: topEntries(byBucket),
    by_reason: topEntries(byReason),
    top_brands: topEntries(byBrand, 20),
    top_domains: topEntries(byDomain, 20),
  };
}

function writeJson(filePath, data) {
  const target = asString(filePath);
  if (!target) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function main() {
  const options = {
    sig: asString(argValue('sig')),
    externalProductId: asString(argValue('external-product-id')),
    brand: asString(argValue('brand')),
    domain: asString(argValue('domain')),
    market: asString(argValue('market') || 'US'),
    limit: parsePositiveInt(argValue('limit'), 500, { allowZero: true }),
    out: asString(argValue('out')),
    includeInactive: hasArg('include-inactive'),
    probeRuntime: hasArg('probe-runtime'),
    baseUrl: asString(argValue('base-url') || 'https://agent.pivota.cc/api/gateway'),
    debug: hasArg('debug'),
  };
  const rawRows = await fetchRows(options);
  const rows = [];
  for (const row of rawRows) {
    let runtime = null;
    if (options.probeRuntime) {
      // eslint-disable-next-line no-await-in-loop
      runtime = await probeRuntime({
        baseUrl: options.baseUrl,
        sig: asString(row.requested_sig),
        debug: options.debug,
      }).catch((err) => ({
        runtime_status: 'probe_failed',
        runtime_error: err?.message || String(err),
      }));
    }
    rows.push(classifyRow(row, runtime));
  }
  const output = {
    generated_at: new Date().toISOString(),
    source: 'pdp_entity_truth_audit_v1',
    query: options,
    summary: summarize(rows),
    rows,
  };
  writeJson(options.out, output);
  console.log(JSON.stringify(output.summary, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
