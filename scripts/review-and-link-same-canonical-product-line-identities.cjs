#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { closePool, query, withClient } = require('../src/db');

const REVIEW_CONFIRM_TOKEN = 'LINK_REVIEWED_SAME_CANONICAL_PRODUCT_LINE';

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return '';
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : '';
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  return String(value || '').replace(/\u0000/g, '').replace(/\\+u0000/gi, '').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function uniqueStrings(values, limit = 5000) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = asString(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function stableHash(prefix, parts) {
  return `${prefix}_${crypto.createHash('sha1').update(JSON.stringify(parts || [])).digest('hex').slice(0, 24)}`;
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

function normalizeProductLineTitleKey(value) {
  return normalizeTextKey(value)
    .replace(/\b\d+(?:\.\d+)?\s*(?:fl\s*oz|floz|oz|ml|m l|g|gram|grams|ct|count|pc|pcs)\b/g, ' ')
    .replace(/\b(?:mini|travel|jumbo|refill|standard|full\s*size|value\s*size)\b/g, ' ')
    .replace(/\b(?:pack\s*of\s*)?\d+\s*(?:pack|piece|pieces|count|ct)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function seedBrand(row) {
  const seedData = asObject(row?.seed_data);
  const snapshot = asObject(seedData.snapshot);
  return (
    asString(seedData.brand) ||
    asString(seedData.vendor) ||
    asString(seedData.brand_name) ||
    asString(snapshot.brand) ||
    asString(snapshot.vendor) ||
    asString(snapshot.brand_name)
  );
}

function seedCanonicalUrl(row) {
  const seedData = asObject(row?.seed_data);
  const snapshot = asObject(seedData.snapshot);
  return asString(row?.canonical_url || snapshot.canonical_url || seedData.canonical_url || row?.destination_url);
}

function serializeVariantAxes(value) {
  const obj = asObject(value);
  const cleaned = {};
  for (const [key, raw] of Object.entries(obj)) {
    if (key === 'multi_variant' && raw === false) continue;
    const text = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
    if (text == null || text === '') continue;
    cleaned[key] = text;
  }
  if (!Object.keys(cleaned).length) return '';
  return JSON.stringify(
    Object.keys(cleaned)
      .sort()
      .reduce((acc, key) => {
        acc[key] = cleaned[key];
        return acc;
      }, {}),
  );
}

function buildProductLineReview({ seeds, identities, targetExternalProductId, reviewedBy = 'codex' }) {
  const blockers = [];
  const warnings = [];
  const seedById = new Map(seeds.map((row) => [asString(row.external_product_id), row]));
  const identityById = new Map(identities.map((row) => [asString(row.product_id), row]));
  const externalProductIds = uniqueStrings([...seedById.keys(), ...identityById.keys()]);
  const targetSeed = seedById.get(targetExternalProductId);
  const targetIdentity = identityById.get(targetExternalProductId);

  if (externalProductIds.length < 2) blockers.push('not_fragmented');
  if (!targetExternalProductId) blockers.push('missing_target_external_product_id');
  if (!targetSeed) blockers.push('missing_target_seed');
  if (!targetIdentity) blockers.push('missing_target_identity');

  const missingSeeds = externalProductIds.filter((id) => !seedById.has(id));
  const missingIdentities = externalProductIds.filter((id) => !identityById.has(id));
  if (missingSeeds.length) blockers.push('missing_seed_rows');
  if (missingIdentities.length) blockers.push('missing_identity_rows');

  const canonicalUrls = uniqueStrings(seeds.map((row) => normalizeUrlForCompare(seedCanonicalUrl(row))));
  if (canonicalUrls.length !== 1) blockers.push('conflicting_seed_canonical_url');
  const rawCanonicalUrl = seedCanonicalUrl(targetSeed || seeds[0]);

  const brandKeys = uniqueStrings(seeds.map((row) => normalizeTextKey(seedBrand(row))).filter(Boolean));
  if (brandKeys.length > 1) blockers.push('conflicting_brand');

  const rawTitleKeys = uniqueStrings(seeds.map((row) => normalizeTextKey(row.title)).filter(Boolean));
  const titleLineKeys = uniqueStrings(seeds.map((row) => normalizeProductLineTitleKey(row.title)).filter(Boolean));
  if (titleLineKeys.length > 1) blockers.push('conflicting_title_core');
  if (rawTitleKeys.length > 1 && titleLineKeys.length === 1) warnings.push('raw_titles_differ_by_variant_axis');

  const marketKeys = uniqueStrings(seeds.map((row) => asString(row.market).toUpperCase()).filter(Boolean));
  if (marketKeys.length > 1) warnings.push('mixed_market_rows_reviewed_as_same_product_line');

  const domains = uniqueStrings(seeds.map((row) => asString(row.domain).toLowerCase()).filter(Boolean));
  if (domains.length > 1) blockers.push('conflicting_domain');

  const sourceTiers = uniqueStrings(identities.map((row) => asString(row.source_tier).toLowerCase()).filter(Boolean));
  if (sourceTiers.some((tier) => tier && tier !== 'brand')) warnings.push('non_brand_source_tier_present');

  const axisSignatures = uniqueStrings(identities.map((row) => serializeVariantAxes(row.variant_axes)));
  const nonEmptyAxisSignatures = axisSignatures.filter(Boolean);
  const sigIds = uniqueStrings(identities.map((row) => asString(row.sellable_item_group_id)).filter(Boolean));
  if (sigIds.length < 2) warnings.push('already_single_sig_or_missing_sig');
  if (nonEmptyAxisSignatures.length < 2 && sigIds.length > 1) {
    blockers.push('exact_merge_review_required');
    warnings.push('variant_axes_do_not_prove_distinct_sellable_items');
  }

  const targetProductLineId = asString(targetIdentity?.product_line_id);
  const targetReviewFamilyId = asString(targetIdentity?.review_family_id || targetProductLineId);
  if (!targetProductLineId) blockers.push('target_missing_product_line_id');

  const candidates = identities
    .filter((row) => asString(row.product_id) !== targetExternalProductId)
    .map((row) => {
      const sourceRef = asString(row.source_listing_ref);
      const sourceProductLineId = asString(row.product_line_id);
      const sourceReviewFamilyId = asString(row.review_family_id);
      const needsUpdate =
        sourceProductLineId !== targetProductLineId ||
        sourceReviewFamilyId !== targetReviewFamilyId ||
        normalizeUrlForCompare(row.official_url) !== normalizeUrlForCompare(rawCanonicalUrl);
      return {
        source_listing_ref: sourceRef,
        external_product_id: asString(row.product_id),
        source_sellable_item_group_id: asString(row.sellable_item_group_id),
        source_product_line_id: sourceProductLineId,
        target_product_line_id: targetProductLineId,
        source_review_family_id: sourceReviewFamilyId,
        target_review_family_id: targetReviewFamilyId,
        official_url_before: asString(row.official_url),
        official_url_after: rawCanonicalUrl,
        variant_axis_signature: serializeVariantAxes(row.variant_axes),
        needs_update: needsUpdate,
      };
    });

  return {
    action: blockers.length ? 'hold_manual_review' : candidates.some((item) => item.needs_update) ? 'link_ready' : 'already_linked',
    blockers,
    warnings,
    reviewed_by: reviewedBy,
    target_external_product_id: targetExternalProductId,
    target_source_listing_ref: targetExternalProductId ? `external_seed:${targetExternalProductId}` : '',
    canonical_url: rawCanonicalUrl,
    normalized_canonical_url: canonicalUrls[0] || '',
    brand_key: brandKeys[0] || '',
    raw_title_keys: rawTitleKeys,
    title_line_key: titleLineKeys[0] || '',
    axis_signatures: axisSignatures,
    sig_ids: sigIds,
    target_sellable_item_group_id: asString(targetIdentity?.sellable_item_group_id),
    target_product_line_id: targetProductLineId,
    target_review_family_id: targetReviewFamilyId,
    candidates,
  };
}

async function fetchRows(externalProductIds, market = '') {
  const seeds = (
    await query(
      `
        SELECT id, external_product_id, market, domain, title, canonical_url, destination_url,
               coalesce(seed_data, '{}'::jsonb) AS seed_data
        FROM external_product_seeds
        WHERE status = 'active'
          AND external_product_id = ANY($1::text[])
          AND ($2::text = '' OR upper(market) = upper($2))
        ORDER BY external_product_id
      `,
      [externalProductIds, asString(market).toUpperCase()],
    )
  ).rows || [];
  const refs = externalProductIds.map((id) => `external_seed:${id}`);
  const identities = (
    await query(
      `
        SELECT source_listing_ref, merchant_id, product_id, source_tier, live_read_enabled,
               sellable_item_group_id, product_line_id, review_family_id, identity_status,
               matched_by_rule, match_basis, strong_identity, variant_axes, review_summary,
               official_url, review_required, review_reason_codes, updated_at
        FROM pdp_identity_listing
        WHERE source_listing_ref = ANY($1::text[])
        ORDER BY product_id
      `,
      [refs],
    )
  ).rows || [];
  return { seeds, identities };
}

async function applyProductLineLink(review, { reviewedBy = 'codex' } = {}) {
  const ready = review.action === 'link_ready';
  if (!ready) return { identity_rows_updated: 0, overrides_written: 0 };
  const reviewedAt = new Date().toISOString();
  const candidates = review.candidates.filter((item) => item.needs_update);
  let identityRowsUpdated = 0;
  let overridesWritten = 0;
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout = '10000ms'");
      await client.query("SET LOCAL statement_timeout = '60000ms'");
      for (const candidate of candidates) {
        const payload = {
          source_listing_ref: candidate.source_listing_ref,
          source_sellable_item_group_id: candidate.source_sellable_item_group_id,
          target_product_line_id: review.target_product_line_id,
          target_review_family_id: review.target_review_family_id || review.target_product_line_id,
          target_source_listing_ref: review.target_source_listing_ref,
          target_external_product_id: review.target_external_product_id,
          canonical_url: review.canonical_url,
          reason: 'reviewed_same_canonical_url_product_line_link',
          reviewed_by: reviewedBy,
          reviewed_at: reviewedAt,
        };
        const overrideId = stableHash('ovr', [
          'reviewed_same_canonical_url_product_line_link',
          candidate.source_listing_ref,
          review.target_product_line_id,
          review.normalized_canonical_url,
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
            ) VALUES ($1,$2,'force_product_line',$3::jsonb,$4,true,now())
            ON CONFLICT (id) DO UPDATE SET
              payload = EXCLUDED.payload,
              created_by = EXCLUDED.created_by,
              active = EXCLUDED.active,
              updated_at = now()
          `,
          [overrideId, candidate.source_listing_ref, JSON.stringify(payload), reviewedBy],
        );
        overridesWritten += 1;

        const basis = [
          `reviewed_same_canonical_product_line:${review.normalized_canonical_url}`,
          `target_source_listing_ref:${review.target_source_listing_ref}`,
          `target_product_line_id:${review.target_product_line_id}`,
        ];
        const strongPatch = {
          reviewed_same_canonical_product_line_v1: {
            canonical_url: review.canonical_url,
            normalized_canonical_url: review.normalized_canonical_url,
            target_source_listing_ref: review.target_source_listing_ref,
            target_external_product_id: review.target_external_product_id,
            target_sellable_item_group_id: review.target_sellable_item_group_id || null,
            target_product_line_id: review.target_product_line_id,
            target_review_family_id: review.target_review_family_id || review.target_product_line_id,
            reviewed_by: reviewedBy,
            reviewed_at: reviewedAt,
          },
          canonical_url: review.canonical_url,
          canonical_product_line_id: review.target_product_line_id,
        };
        const summaryPatch = {
          reviewed_same_canonical_product_line_v1: payload,
        };
        const res = await client.query(
          `
            UPDATE pdp_identity_listing
            SET
              product_line_id = $2,
              review_family_id = COALESCE(NULLIF($3, ''), $2, review_family_id),
              identity_status = 'approved',
              live_read_enabled = true,
              review_required = false,
              review_reason_codes = '[]'::jsonb,
              matched_by_rule = 'reviewed_same_canonical_product_line',
              match_basis = COALESCE(match_basis, '[]'::jsonb) || $4::jsonb,
              strong_identity = COALESCE(strong_identity, '{}'::jsonb) || $5::jsonb,
              review_summary = COALESCE(review_summary, '{}'::jsonb) || $6::jsonb,
              official_url = COALESCE(NULLIF($7, ''), official_url),
              updated_at = now()
            WHERE source_listing_ref = $1
          `,
          [
            candidate.source_listing_ref,
            review.target_product_line_id,
            review.target_review_family_id || review.target_product_line_id || '',
            JSON.stringify(basis),
            JSON.stringify(strongPatch),
            JSON.stringify(summaryPatch),
            review.canonical_url || '',
          ],
        );
        identityRowsUpdated += Number(res.rowCount || 0);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
  return { identity_rows_updated: identityRowsUpdated, overrides_written: overridesWritten };
}

async function run(options) {
  const externalProductIds = uniqueStrings(
    asString(options.externalProductIds)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  if (externalProductIds.length < 2) throw new Error('--external-product-ids requires at least two ids');
  const targetExternalProductId = asString(options.targetExternalProductId);
  if (!targetExternalProductId) throw new Error('--target-external-product-id is required');
  if (!externalProductIds.includes(targetExternalProductId)) {
    throw new Error('--target-external-product-id must be included in --external-product-ids');
  }
  const { seeds, identities } = await fetchRows(externalProductIds, options.market || '');
  const review = buildProductLineReview({
    seeds,
    identities,
    targetExternalProductId,
    reviewedBy: options.reviewedBy || 'codex',
  });
  const write =
    options.write === true &&
    asString(options.confirm) === REVIEW_CONFIRM_TOKEN &&
    review.action === 'link_ready';
  const applyResult = write
    ? await applyProductLineLink(review, { reviewedBy: options.reviewedBy || 'codex' })
    : {
        identity_rows_updated: 0,
        overrides_written: 0,
      };
  return {
    generated_at: new Date().toISOString(),
    dry_run: !write,
    write_requested: options.write === true,
    write_confirmed: asString(options.confirm) === REVIEW_CONFIRM_TOKEN,
    filters: {
      external_product_ids: externalProductIds,
      target_external_product_id: targetExternalProductId,
      market: options.market || null,
    },
    summary: {
      seeds_seen: seeds.length,
      identities_seen: identities.length,
      action: review.action,
      blocker_count: review.blockers.length,
      warning_count: review.warnings.length,
      candidates_to_update: review.candidates.filter((item) => item.needs_update).length,
      identity_rows_updated: applyResult.identity_rows_updated || 0,
      overrides_written: applyResult.overrides_written || 0,
    },
    review,
  };
}

function writeReport(report, outPath) {
  const out = asString(outPath);
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
}

async function main() {
  if (hasFlag('write') && argValue('confirm') !== REVIEW_CONFIRM_TOKEN) {
    throw new Error(`Refusing to write without --confirm ${REVIEW_CONFIRM_TOKEN}`);
  }
  const report = await run({
    externalProductIds: argValue('external-product-ids'),
    targetExternalProductId: argValue('target-external-product-id'),
    market: argValue('market'),
    reviewedBy: argValue('reviewed-by') || 'codex',
    write: hasFlag('write'),
    confirm: argValue('confirm'),
  });
  writeReport(report, argValue('out'));
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
  REVIEW_CONFIRM_TOKEN,
  buildProductLineReview,
  normalizeProductLineTitleKey,
  normalizeUrlForCompare,
  run,
  serializeVariantAxes,
};
