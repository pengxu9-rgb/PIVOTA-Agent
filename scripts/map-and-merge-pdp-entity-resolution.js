#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { closePool, query, withClient } = require('../src/db');

const REVIEW_CONFIRM_TOKEN = 'MERGE_CROSS_MERCHANT_PDP';

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function asPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function stableHash(prefix, parts) {
  return `${prefix}_${crypto.createHash('sha1').update(JSON.stringify(parts || [])).digest('hex').slice(0, 24)}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = stableJson(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function isSigId(value) {
  return /^sig_[a-f0-9]{16,64}$/i.test(asString(value));
}

function deriveProductGroupId(contentKey) {
  const key = asString(contentKey);
  if (!key.startsWith('ck_') || key.length < 6) {
    return stableHash('pg', ['content_key', key]);
  }
  return `pg_${key.slice(3)}`;
}

function lifecycleRank(stage) {
  switch (asString(stage).toLowerCase()) {
    case 'published':
      return 4;
    case 'validated':
      return 3;
    case 'candidate':
      return 2;
    case 'draft':
      return 1;
    default:
      return 0;
  }
}

function mintedMs(row) {
  const parsed = Date.parse(asString(row?.pivota_signature_minted_at));
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function comparePrimaryRows(left, right) {
  const leftPrimary = left?.is_primary === true ? 1 : 0;
  const rightPrimary = right?.is_primary === true ? 1 : 0;
  if (leftPrimary !== rightPrimary) return rightPrimary - leftPrimary;
  const leftRank = lifecycleRank(left?.pdp_lifecycle_stage);
  const rightRank = lifecycleRank(right?.pdp_lifecycle_stage);
  if (leftRank !== rightRank) return rightRank - leftRank;
  const leftMinted = mintedMs(left);
  const rightMinted = mintedMs(right);
  if (leftMinted !== rightMinted) return leftMinted - rightMinted;
  return asString(left?.product_key).localeCompare(asString(right?.product_key));
}

function pickPrimaryMember(rows) {
  return [...(rows || [])].sort(comparePrimaryRows)[0] || null;
}

function serializeVariantAxes(value) {
  const obj = asPlainObject(value) || {};
  const cleaned = {};
  for (const [key, raw] of Object.entries(obj)) {
    if (key === 'multi_variant' && raw === false) continue;
    const text = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
    if (text == null || text === '') continue;
    cleaned[key] = text;
  }
  if (!Object.keys(cleaned).length) return '';
  return JSON.stringify(stableJson(cleaned));
}

function extractGtins(value) {
  const strong = asPlainObject(value) || {};
  const candidates = [
    ...asArray(strong.gtins),
    ...asArray(strong.gtin),
    ...asArray(strong.upcs),
    ...asArray(strong.upc),
    ...asArray(strong.ean),
  ];
  return candidates
    .flatMap((item) => (Array.isArray(item) ? item : [item]))
    .map((item) => asString(item).replace(/[^0-9A-Za-z]/g, '').toLowerCase())
    .filter(Boolean);
}

function relationMissing(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return err?.code === '42P01' || message.includes('does not exist') || message.includes('relation');
}

function buildSourceListingRef(row) {
  const sourceRef = asString(row?.source_listing_ref);
  if (sourceRef) return sourceRef;
  const merchantId = asString(row?.merchant_id);
  const productId = asString(row?.source_product_id);
  return merchantId && productId ? `${merchantId}:${productId}` : '';
}

function buildClusterReport(contentKey, rows) {
  const members = [...(rows || [])];
  const merchantIds = Array.from(new Set(members.map((row) => asString(row.merchant_id)).filter(Boolean))).sort();
  const sigIds = Array.from(new Set(members.map((row) => asString(row.pivota_signature_id)).filter(isSigId))).sort();
  const existingGroupIds = Array.from(
    new Set(members.map((row) => asString(row.internal_product_group_id)).filter(Boolean)),
  ).sort();
  const officialUrls = Array.from(
    new Set(members.map((row) => asString(row.official_url || row.canonical_url)).filter(Boolean)),
  ).sort();
  const gtins = Array.from(new Set(members.flatMap((row) => extractGtins(row.strong_identity)))).sort();
  const axisSignatures = Array.from(
    new Set(members.map((row) => serializeVariantAxes(row.variant_axes)).filter(Boolean)),
  ).sort();
  const primary = pickPrimaryMember(members);
  const canonicalSigId = asString(primary?.pivota_signature_id);
  const productGroupId = existingGroupIds.length === 1 ? existingGroupIds[0] : deriveProductGroupId(contentKey);
  const blockers = [];
  const warnings = [];

  if (merchantIds.length < 2) blockers.push('not_cross_merchant');
  if (sigIds.length < 2) blockers.push('not_fragmented_sig');
  if (!isSigId(canonicalSigId)) blockers.push('missing_canonical_sig');
  if (existingGroupIds.length > 1) blockers.push('split_product_group_members');
  if (gtins.length > 1) blockers.push('conflicting_gtin');
  if (axisSignatures.length > 1) blockers.push('conflicting_variant_axes');
  if (officialUrls.length > 1) warnings.push('conflicting_official_url_ignored_for_content_key');

  const isReady = blockers.length === 0;
  const groupMemberUpserts = members.map((row) => {
    const isPrimary =
      asString(row.merchant_id) === asString(primary?.merchant_id) &&
      asString(row.platform) === asString(primary?.platform) &&
      asString(row.source_product_id) === asString(primary?.source_product_id);
    return {
      product_group_id: productGroupId,
      merchant_id: asString(row.merchant_id),
      platform: asString(row.platform),
      platform_product_id: asString(row.source_product_id),
      product_key: asString(row.product_key),
      sig_id: asString(row.pivota_signature_id),
      is_primary: isPrimary,
      existing_product_group_id: asString(row.internal_product_group_id),
      existing_is_primary: row.is_primary === true,
      needs_write:
        asString(row.internal_product_group_id) !== productGroupId || (row.is_primary === true) !== isPrimary,
    };
  });

  const identityAliasUpdates = members
    .map((row) => {
      const sourceListingRef = buildSourceListingRef(row);
      const currentSig = asString(row.sellable_item_group_id || row.pivota_signature_id);
      return {
        source_listing_ref: sourceListingRef,
        merchant_id: asString(row.merchant_id),
        product_id: asString(row.source_product_id),
        product_key: asString(row.product_key),
        source_sig_id: currentSig,
        member_sig_id: asString(row.pivota_signature_id),
        canonical_sig_id: canonicalSigId,
        product_group_id: productGroupId,
        has_identity_listing: Boolean(asString(row.source_listing_ref)),
        needs_update: Boolean(asString(row.source_listing_ref)) && currentSig !== canonicalSigId,
      };
    })
    .filter((row) => row.source_sig_id && row.source_sig_id !== canonicalSigId);

  const memberSigAliases = sigIds
    .filter((sigId) => sigId !== canonicalSigId)
    .map((sigId) => ({
      source_sig_id: sigId,
      canonical_sig_id: canonicalSigId,
      product_group_id: productGroupId,
    }));

  const action = !isReady
    ? 'hold_manual_review'
    : groupMemberUpserts.some((row) => row.needs_write) || identityAliasUpdates.some((row) => row.needs_update)
      ? 'auto_merge_ready'
      : 'already_canonical';

  return {
    content_key: contentKey,
    action,
    blockers,
    warnings,
    canonical_sig_id: canonicalSigId,
    product_group_id: productGroupId,
    primary_product_key: asString(primary?.product_key),
    merchant_count: merchantIds.length,
    sig_count: sigIds.length,
    member_count: members.length,
    offer_count: members.reduce((sum, row) => sum + Number(row.offer_count || 0), 0),
    sku_count: members.reduce((sum, row) => sum + Number(row.sku_count || 0), 0),
    official_url_count: officialUrls.length,
    gtin_count: gtins.length,
    variant_axes_signature_count: axisSignatures.length,
    merchant_ids: merchantIds,
    sig_ids: sigIds,
    existing_product_group_ids: existingGroupIds,
    member_sig_aliases: memberSigAliases,
    product_group_upserts: groupMemberUpserts,
    identity_alias_updates: identityAliasUpdates,
    members: members.map((row) => ({
      product_key: asString(row.product_key),
      merchant_id: asString(row.merchant_id),
      merchant_name: asString(row.merchant_name),
      platform: asString(row.platform),
      source_product_id: asString(row.source_product_id),
      title: asString(row.title),
      brand: asString(row.brand),
      sig_id: asString(row.pivota_signature_id),
      source_listing_ref: asString(row.source_listing_ref),
      identity_sig_id: asString(row.sellable_item_group_id),
      product_group_id: asString(row.internal_product_group_id),
      is_primary: row.is_primary === true,
      lifecycle: asString(row.pdp_lifecycle_stage),
      offer_count: Number(row.offer_count || 0),
      sku_count: Number(row.sku_count || 0),
      variant_axes_signature: serializeVariantAxes(row.variant_axes),
      official_url: asString(row.official_url || row.canonical_url),
    })),
  };
}

function groupRows(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    const key = asString(row.content_key);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return Array.from(grouped.entries()).map(([contentKey, members]) => buildClusterReport(contentKey, members));
}

function buildBaseFilters(alias, options, paramsByName) {
  const filters = [
    `${alias}.content_key IS NOT NULL`,
    `${alias}.pivota_signature_id IS NOT NULL`,
    `${alias}.pivota_signature_id LIKE 'sig_%'`,
  ];
  if (options.activeOnly) {
    filters.push(
      `(${alias}.pdp_lifecycle_stage IS NULL OR ${alias}.pdp_lifecycle_stage NOT IN ('hold', 'archived'))`,
    );
  }
  if (options.contentKey) filters.push(`${alias}.content_key = $${paramsByName.contentKey}`);
  if (options.market && options.market.toLowerCase() !== 'all') {
    filters.push(
      `COALESCE(${alias}.product_payload->>'market', ${alias}.product_payload->>'market_code', ${alias}.product_payload->'snapshot'->>'market', 'US') = $${paramsByName.market}`,
    );
  }
  return filters.join('\n          AND ');
}

async function fetchCrossMerchantClusters(options = {}) {
  const params = [];
  const paramsByName = {};
  if (options.contentKey) {
    paramsByName.contentKey = params.push(options.contentKey);
  }
  if (options.market && options.market.toLowerCase() !== 'all') {
    paramsByName.market = params.push(options.market);
  }
  if (options.merchantId) {
    paramsByName.merchantId = params.push(options.merchantId);
  }
  paramsByName.minMerchants = params.push(options.minMerchants || 2);
  paramsByName.limit = params.push(options.limit || 100);

  const eligibleWhere = buildBaseFilters('cp', options, paramsByName);
  const memberWhere = buildBaseFilters('cp', options, paramsByName);
  const merchantHaving = options.merchantId ? `AND BOOL_OR(cp.merchant_id = $${paramsByName.merchantId})` : '';

  const result = await query(
    `
      WITH eligible AS (
        SELECT
          cp.content_key,
          COUNT(*)::int AS member_count,
          COUNT(DISTINCT cp.merchant_id)::int AS merchant_count,
          COUNT(DISTINCT cp.pivota_signature_id)::int AS sig_count,
          MAX(cp.updated_at) AS latest_updated_at
        FROM catalog_products cp
        WHERE ${eligibleWhere}
        GROUP BY cp.content_key
        HAVING COUNT(DISTINCT cp.merchant_id) >= $${paramsByName.minMerchants}
           AND COUNT(DISTINCT cp.pivota_signature_id) > 1
           ${merchantHaving}
        ORDER BY MAX(cp.updated_at) DESC NULLS LAST, cp.content_key ASC
        LIMIT $${paramsByName.limit}
      ),
      offer_stats AS (
        SELECT
          s.product_key,
          COUNT(DISTINCT s.sku_key)::int AS sku_count,
          COUNT(DISTINCT o.offer_id)::int AS offer_count
        FROM catalog_skus s
        LEFT JOIN catalog_offers o ON o.sku_key = s.sku_key
        WHERE s.product_key IN (
          SELECT cp.product_key
          FROM catalog_products cp
          JOIN eligible e ON e.content_key = cp.content_key
        )
        GROUP BY s.product_key
      )
      SELECT
        cp.content_key,
        cp.product_key,
        cp.merchant_id,
        cp.platform,
        cp.source_product_id,
        cp.title,
        cp.brand,
        cp.category,
        cp.canonical_url,
        cp.pivota_signature_id,
        cp.pivota_canonical_url,
        cp.pivota_signature_minted_at,
        cp.pdp_lifecycle_stage,
        cp.updated_at,
        cm.merchant_name,
        pgm.product_group_id AS internal_product_group_id,
        COALESCE(pgm.is_primary, false) AS is_primary,
        COALESCE(offer_stats.sku_count, 0)::int AS sku_count,
        COALESCE(offer_stats.offer_count, 0)::int AS offer_count,
        pil.source_listing_ref,
        pil.sellable_item_group_id,
        pil.product_line_id,
        pil.identity_status,
        pil.live_read_enabled,
        pil.review_required,
        pil.matched_by_rule,
        pil.match_basis,
        pil.strong_identity,
        pil.variant_axes,
        pil.official_url
      FROM catalog_products cp
      JOIN eligible e ON e.content_key = cp.content_key
      LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
      LEFT JOIN product_group_members pgm
        ON pgm.merchant_id = cp.merchant_id
       AND pgm.platform = cp.platform
       AND pgm.platform_product_id = cp.source_product_id
      LEFT JOIN offer_stats ON offer_stats.product_key = cp.product_key
      LEFT JOIN pdp_identity_listing pil
        ON pil.merchant_id = cp.merchant_id
       AND pil.product_id = cp.source_product_id
      WHERE ${memberWhere}
      ORDER BY
        cp.content_key ASC,
        COALESCE(pgm.is_primary, false) DESC,
        CASE cp.pdp_lifecycle_stage
          WHEN 'published' THEN 0
          WHEN 'validated' THEN 1
          WHEN 'candidate' THEN 2
          WHEN 'draft' THEN 3
          ELSE 9
        END,
        cp.pivota_signature_minted_at ASC NULLS LAST,
        cp.product_key ASC
    `,
    params,
  );
  return groupRows(result.rows);
}

async function applyCluster(client, cluster) {
  const primary = cluster.product_group_upserts.find((row) => row.is_primary) || cluster.product_group_upserts[0];
  let groupWrites = 0;
  let aliasWrites = 0;
  for (const row of cluster.product_group_upserts) {
    await client.query(
      `
        INSERT INTO product_group_members (
          product_group_id,
          merchant_id,
          platform,
          platform_product_id,
          is_primary,
          created_at,
          updated_at
        ) VALUES ($1,$2,$3,$4,$5,now(),now())
        ON CONFLICT (merchant_id, platform, platform_product_id)
        DO UPDATE SET
          product_group_id = EXCLUDED.product_group_id,
          is_primary = EXCLUDED.is_primary,
          updated_at = now()
      `,
      [row.product_group_id, row.merchant_id, row.platform, row.platform_product_id, row.is_primary],
    );
    groupWrites += 1;
  }
  if (primary) {
    await client.query(
      `
        UPDATE product_group_members
        SET is_primary = false,
            updated_at = now()
        WHERE product_group_id = $1
          AND NOT (merchant_id = $2 AND platform = $3 AND platform_product_id = $4)
          AND is_primary = true
      `,
      [cluster.product_group_id, primary.merchant_id, primary.platform, primary.platform_product_id],
    );
  }

  for (const row of cluster.identity_alias_updates.filter((item) => item.needs_update)) {
    const payload = {
      source_listing_ref: row.source_listing_ref,
      source_sellable_item_group_id: row.source_sig_id,
      target_sellable_item_group_id: cluster.canonical_sig_id,
      target_product_group_id: cluster.product_group_id,
      content_key: cluster.content_key,
      reason: 'canonical_content_key_cross_merchant_merge',
      merge_policy: 'gated_auto_merge',
      reviewed_by: 'codex',
    };
    const overrideId = stableHash('ovr', [
      'canonical_content_key_cross_merchant_merge',
      row.source_listing_ref,
      row.source_sig_id,
      cluster.canonical_sig_id,
      cluster.content_key,
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
        ) VALUES ($1,$2,'force_exact_group',$3::jsonb,'codex',true,now())
        ON CONFLICT (id) DO UPDATE SET
          payload = EXCLUDED.payload,
          created_by = EXCLUDED.created_by,
          active = EXCLUDED.active,
          updated_at = now()
      `,
      [overrideId, row.source_listing_ref, JSON.stringify(payload)],
    );
    const basis = [
      `content_key:${cluster.content_key}`,
      `canonical_sig:${cluster.canonical_sig_id}`,
      `product_group_id:${cluster.product_group_id}`,
    ];
    await client.query(
      `
        UPDATE pdp_identity_listing
        SET
          sellable_item_group_id = $2,
          identity_status = 'approved',
          live_read_enabled = true,
          review_required = false,
          review_reason_codes = '[]'::jsonb,
          matched_by_rule = 'canonical_content_key',
          match_basis = COALESCE(match_basis, '[]'::jsonb) || $3::jsonb,
          strong_identity = COALESCE(strong_identity, '{}'::jsonb) || $4::jsonb,
          review_summary = COALESCE(review_summary, '{}'::jsonb) || $5::jsonb,
          updated_at = now()
        WHERE source_listing_ref = $1
          AND sellable_item_group_id = $6
      `,
      [
        row.source_listing_ref,
        cluster.canonical_sig_id,
        JSON.stringify(basis),
        JSON.stringify({
          content_key: cluster.content_key,
          canonical_sig_id: cluster.canonical_sig_id,
          product_group_id: cluster.product_group_id,
        }),
        JSON.stringify({ canonical_content_key_cross_merchant_merge_v1: payload }),
        row.source_sig_id,
      ],
    );
    aliasWrites += 1;
  }
  return { group_writes: groupWrites, identity_alias_writes: aliasWrites };
}

async function applyReadyClusters(clusters, { maxApply = 25 } = {}) {
  const ready = clusters.filter((cluster) => cluster.action === 'auto_merge_ready').slice(0, maxApply);
  const totals = { clusters_applied: 0, group_writes: 0, identity_alias_writes: 0 };
  if (!ready.length) return totals;
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      for (const cluster of ready) {
        const applied = await applyCluster(client, cluster);
        totals.clusters_applied += 1;
        totals.group_writes += applied.group_writes;
        totals.identity_alias_writes += applied.identity_alias_writes;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
  return totals;
}

async function mapAndMerge(options = {}) {
  const clusters = await fetchCrossMerchantClusters(options);
  const ready = clusters.filter((cluster) => cluster.action === 'auto_merge_ready');
  const held = clusters.filter((cluster) => cluster.action === 'hold_manual_review');
  const alreadyCanonical = clusters.filter((cluster) => cluster.action === 'already_canonical');
  const apply =
    options.apply === true &&
    asString(options.confirm) === REVIEW_CONFIRM_TOKEN &&
    ready.length > 0;
  const applied = apply ? await applyReadyClusters(clusters, options) : {
    clusters_applied: 0,
    group_writes: 0,
    identity_alias_writes: 0,
  };
  const summary = {
    generated_at: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry_run',
    apply_requested: options.apply === true,
    apply_confirmed: asString(options.confirm) === REVIEW_CONFIRM_TOKEN,
    scope: {
      market: options.market || 'US',
      active_only: options.activeOnly !== false,
      content_key: options.contentKey || null,
      merchant_id: options.merchantId || null,
      limit: options.limit || 100,
      min_merchants: options.minMerchants || 2,
      max_apply: options.maxApply || 25,
    },
    clusters_seen: clusters.length,
    auto_merge_ready_count: ready.length,
    already_canonical_count: alreadyCanonical.length,
    hold_manual_review_count: held.length,
    product_group_upserts_ready: ready.reduce(
      (sum, cluster) => sum + cluster.product_group_upserts.filter((row) => row.needs_write).length,
      0,
    ),
    identity_alias_updates_ready: ready.reduce(
      (sum, cluster) => sum + cluster.identity_alias_updates.filter((row) => row.needs_update).length,
      0,
    ),
    blockers: held.reduce((acc, cluster) => {
      for (const blocker of cluster.blockers) acc[blocker] = (acc[blocker] || 0) + 1;
      return acc;
    }, {}),
    applied,
  };
  return {
    status: 'success',
    summary,
    clusters,
  };
}

async function main() {
  const limit = clampInt(readArg('limit', '100'), 100, 1, 5000);
  const minMerchants = clampInt(readArg('min-merchants', '2'), 2, 2, 20);
  const maxApply = clampInt(readArg('max-apply', '25'), 25, 1, 500);
  const market = readArg('market', process.env.EXTERNAL_SEED_MARKET || 'US');
  const contentKey = readArg('content-key', '');
  const merchantId = readArg('merchant-id', '');
  const out = readArg('out', '');
  const apply = hasFlag('apply');
  const activeOnly = !hasFlag('include-inactive');
  const confirm = readArg('confirm', '');

  if (apply && confirm !== REVIEW_CONFIRM_TOKEN) {
    process.stderr.write(
      `Refusing to apply without --confirm=${REVIEW_CONFIRM_TOKEN}. Re-run without --apply for dry-run JSON.\n`,
    );
    process.exitCode = 2;
    return;
  }

  try {
    const report = await mapAndMerge({
      limit,
      minMerchants,
      maxApply,
      market,
      contentKey,
      merchantId,
      activeOnly,
      apply,
      confirm,
    });
    const json = JSON.stringify(report, null, 2);
    if (out) {
      await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
      await fs.writeFile(out, `${json}\n`, 'utf8');
    }
    if (hasFlag('json') || !out) {
      process.stdout.write(`${json}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
    }
  } catch (err) {
    if (relationMissing(err)) {
      process.stderr.write(
        `PDP cross-merchant map/merge requires catalog_products, product_group_members, catalog_skus, catalog_offers, and pdp_identity_listing: ${err.message}\n`,
      );
      process.exitCode = 2;
      return;
    }
    throw err;
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  REVIEW_CONFIRM_TOKEN,
  applyReadyClusters,
  buildClusterReport,
  deriveProductGroupId,
  fetchCrossMerchantClusters,
  mapAndMerge,
  serializeVariantAxes,
  _internals: {
    buildBaseFilters,
    buildSourceListingRef,
    comparePrimaryRows,
    extractGtins,
    groupRows,
    isSigId,
    pickPrimaryMember,
    stableHash,
  },
};
