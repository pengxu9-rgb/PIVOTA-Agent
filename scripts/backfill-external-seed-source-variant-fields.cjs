#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');

const CONTRACT_VERSION = 'external_seed.source_variant_fields.v1';
const PDP_CONTENT_ASSET_VERSION = 'pivota.pdp_content_asset.v1';
const SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';

const TRUSTED_SOURCE_HOSTS = new Set([
  '786cosmetics.com',
  'guerlain.com',
  'fentybeauty.com',
  'beautyofjoseon.com',
  'roundlab.com',
  'skin1004.com',
  'tirtir.global',
  'kyliecosmetics.com',
  'rarebeauty.com',
  'tomfordbeauty.com',
  'sokoglam.com',
  'ohlolly.com',
  'bloomingkoco.com',
  'stylekorean.com',
  'yesstyle.com',
  'oliveyoung.com',
  'ulta.com',
  'sephora.com',
  'sephora.co.uk',
  'boots.com',
  'iherb.com',
  'peachandlily.com',
  'harveynichols.com',
  'parfymeri.no',
  'douglas.nl',
  'douglas.cz',
  'douglas.hu',
  'isolee.com',
  'spacenk.com',
  'violetgrey.com',
  'costco.com',
  'harrods.com',
  'holtrenfrew.com',
]);

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return '';
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? String(value).trim() : '';
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeCompact(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function looksLikeRealSku(value) {
  const text = normalizeText(value);
  if (!text) return false;
  if (/\d/.test(text)) return true;
  return /^[A-Z0-9][A-Z0-9_-]{3,}$/.test(text) && /[_-]/.test(text);
}

function normalizeSkuLikeValue(primary, fallback, variantId, displayLabel, rawOptions) {
  const raw = normalizeText(primary || fallback);
  if (!raw) return variantId;
  const compactRaw = normalizeCompact(raw);
  const displayValues = [
    displayLabel.includes(':') ? displayLabel.split(':').pop() : displayLabel,
    ...rawOptions.map((option) => option.value),
  ].map(normalizeCompact).filter(Boolean);
  if (!looksLikeRealSku(raw) && displayValues.includes(compactRaw)) return variantId;
  return raw;
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringifyPostgresJsonb(value) {
  let text = JSON.stringify(value || {});
  let previous = '';
  while (text !== previous) {
    previous = text;
    text = text.replace(/\\+u0000/gi, '').replace(/\u0000/g, '');
  }
  return text;
}

function hashContent(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || '')).digest('hex');
}

function hostFromUrl(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function normalizeSourceQualityStatus(value) {
  return normalizeText(value).toLowerCase();
}

function isWeakVariantQuality(seedData, snapshot, productPayload, identityPayload) {
  const summaries = [
    ensureObject(seedData.pdp_field_quality_summary),
    ensureObject(snapshot.pdp_field_quality_summary),
    ensureObject(productPayload.pdp_field_quality_summary),
    ensureObject(identityPayload.pdp_field_quality_summary),
    ensureObject(ensureObject(seedData.pdp_content_asset_v1).fields),
    ensureObject(ensureObject(snapshot.pdp_content_asset_v1).fields),
    ensureObject(ensureObject(productPayload.pdp_content_asset_v1).fields),
    ensureObject(ensureObject(identityPayload.pdp_content_asset_v1).fields),
  ];
  for (const summary of summaries) {
    const item = ensureObject(summary.variants || summary.variant_detail_label);
    const status = normalizeSourceQualityStatus(item.source_quality_status);
    const origin = normalizeSourceQualityStatus(item.source_origin);
    if (!status && !origin) continue;
    if (status.startsWith('force_filled') || ['blocked', 'quarantined', 'low', 'unknown'].includes(status)) return true;
    if (/pivota_force_fill|force_fill/.test(origin)) return true;
    return false;
  }
  return true;
}

function variantOptionIsDisplayable(option) {
  const name = normalizeText(option?.name || option?.option_name);
  const value = normalizeText(option?.value || option?.option_value);
  if (!name || !value) return false;
  if (/^(default|default title|title|variant|selection|option)$/i.test(name)) return false;
  if (/^(default|default title|single|single item|one size|n\/a)$/i.test(value)) return false;
  return true;
}

function variantIsDisplayable(variant) {
  const quality = normalizeSourceQualityStatus(variant?.source_quality_status || variant?.sourceQualityStatus);
  if (['blocked', 'quarantined', 'low'].includes(quality)) return false;
  const options = asArray(variant?.options).filter(variantOptionIsDisplayable);
  if (options.length) return true;
  const displayLabel = normalizeText(variant?.display_label || variant?.displayLabel);
  if (displayLabel && !/^(?:default|default title|single item|format:\s*single item)$/i.test(displayLabel)) return true;
  const title = normalizeText(variant?.title || variant?.name);
  return Boolean(title && !/^(default|default title|single item|variant \d+)$/i.test(title));
}

function existingVariantIsProtected(seedData, snapshot, productPayload, identityPayload) {
  const sources = [
    seedData.variants,
    snapshot.variants,
    productPayload.variants,
    identityPayload.variants,
  ];
  const hasDisplayable = sources.some((variants) => asArray(variants).some(variantIsDisplayable));
  if (!hasDisplayable) return false;
  return !isWeakVariantQuality(seedData, snapshot, productPayload, identityPayload);
}

function numericPrice(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function variantPriceAmount(variant) {
  return numericPrice(variant?.price_amount ?? variant?.price);
}

function variantProductUrl(variant) {
  return normalizeText(variant?.product_url || variant?.deep_link || variant?.url);
}

function priceAmountsDiffer(left, right) {
  const leftPrice = variantPriceAmount(left);
  const rightPrice = variantPriceAmount(right);
  if (leftPrice == null || rightPrice == null) return false;
  return Math.abs(leftPrice - rightPrice) >= 0.01;
}

function hasLocalizedProductUrlDrift(existingVariant, sourceUrl) {
  const existingUrl = variantProductUrl(existingVariant);
  if (!existingUrl || !sourceUrl) return false;
  try {
    const existing = new URL(existingUrl);
    const source = new URL(sourceUrl);
    const existingPath = existing.pathname.replace(/\/$/, '');
    const sourcePath = source.pathname.replace(/\/$/, '');
    if (existing.hostname.replace(/^www\./, '') !== source.hostname.replace(/^www\./, '')) return true;
    if (existingPath === sourcePath) return false;
    return /^\/[a-z]{2}(?:-[a-z]{2})?\//i.test(existingPath) && existingPath.endsWith(sourcePath);
  } catch {
    return false;
  }
}

function existingVariantNeedsTrustedPriceUrlCorrection(seedData, mapping, variants, sourceUrl, sourceOrigin) {
  if (mapping.allow_price_url_correction !== true) return false;
  if (sourceOrigin !== 'official_pdp') return false;
  const existingVariants = asArray(seedData.variants);
  if (existingVariants.length !== 1 || variants.length !== 1) return false;
  const existing = existingVariants[0];
  const incoming = variants[0];
  if (!variantIsDisplayable(existing) || !variantIsDisplayable(incoming)) return false;
  return priceAmountsDiffer(existing, incoming) || hasLocalizedProductUrlDrift(existing, sourceUrl);
}

function existingVariantNeedsTrustedScalarLabelCorrection(seedData, snapshot, mapping) {
  if (mapping.allow_scalar_variant_label_correction !== true) return false;
  const label = normalizeText(mapping.variant_detail_label);
  if (!label) return false;
  const staleLabels = [
    seedData.variant_title,
    snapshot.variant_title,
    seedData.variant_detail_label,
    snapshot.variant_detail_label,
    seedData.size_detail_label,
    snapshot.size_detail_label,
    seedData.volume,
    snapshot.volume,
  ].map(normalizeText).filter(Boolean);
  return staleLabels.some((value) => value !== label);
}

function optionValuesForVariant(variant) {
  return [
    normalizeText(variant?.option_value),
    ...asArray(variant?.options).map((option) => normalizeText(option?.value || option?.option_value)),
  ].map(normalizeCompact).filter(Boolean);
}

function existingVariantNeedsTrustedSkuOptionValueCorrection(seedData, variants, sourceOrigin) {
  if (sourceOrigin !== 'official_pdp') return false;
  const existingVariants = asArray(seedData.variants);
  if (existingVariants.length !== 1 || variants.length !== 1) return false;
  const existing = existingVariants[0];
  const incoming = variants[0];
  if (!variantIsDisplayable(existing) || !variantIsDisplayable(incoming)) return false;
  const existingLabel = normalizeCompact(existing.display_label || existing.title);
  const incomingLabel = normalizeCompact(incoming.display_label || incoming.title);
  if (!existingLabel || existingLabel !== incomingLabel) return false;
  const existingSku = normalizeText(existing.sku || existing.sku_id);
  const incomingSku = normalizeText(incoming.sku || incoming.sku_id);
  if (!existingSku || !incomingSku || normalizeCompact(existingSku) === normalizeCompact(incomingSku)) return false;
  const optionValues = new Set([...optionValuesForVariant(existing), ...optionValuesForVariant(incoming)]);
  return optionValues.has(normalizeCompact(existingSku)) && !optionValues.has(normalizeCompact(incomingSku));
}

function normalizeVariant(input, sourceUrl, sourceOrigin) {
  const object = ensureObject(input);
  const rawOptions = asArray(object.options)
    .map((option) => ({
      name: normalizeText(option?.name || option?.option_name),
      value: normalizeText(option?.value || option?.option_value),
      axis_kind: normalizeText(option?.axis_kind || option?.axisKind) || undefined,
    }))
    .filter(variantOptionIsDisplayable);
  const displayLabel =
    normalizeText(object.display_label || object.displayLabel) ||
    rawOptions.map((option) => `${option.name}: ${option.value}`).join(' / ');
  const variantId =
    normalizeText(object.variant_id || object.id || object.sku || object.sku_id) ||
    crypto.createHash('sha1').update(`${sourceUrl}\n${displayLabel}`).digest('hex').slice(0, 12);
  const sku = normalizeSkuLikeValue(object.sku, object.sku_id, variantId, displayLabel, rawOptions);
  const skuId = normalizeSkuLikeValue(object.sku_id, object.sku, variantId, displayLabel, rawOptions);
  const normalized = {
    id: variantId,
    variant_id: variantId,
    sku,
    sku_id: skuId,
    title: normalizeText(object.title || object.name || displayLabel) || displayLabel,
    options: rawOptions,
    option_name: rawOptions.length === 1 ? rawOptions[0].name : undefined,
    option_value: rawOptions.length === 1 ? rawOptions[0].value : undefined,
    display_label: displayLabel,
    axis_kind: normalizeText(object.axis_kind || object.axisKind || rawOptions[0]?.axis_kind) || undefined,
    price: object.price ?? object.price_amount ?? undefined,
    price_amount: object.price_amount ?? object.price ?? undefined,
    currency: normalizeText(object.currency || object.price_currency).toUpperCase() || undefined,
    available: typeof object.available === 'boolean' ? object.available : undefined,
    in_stock: typeof object.in_stock === 'boolean' ? object.in_stock : undefined,
    image_url: normalizeText(object.image_url || object.image) || undefined,
    image_urls: asArray(object.image_urls || object.images).map(normalizeText).filter(Boolean).slice(0, 8),
    label_image_url: normalizeText(object.label_image_url || object.swatch_image_url) || undefined,
    swatch_image_url: normalizeText(object.swatch_image_url) || undefined,
    color_hex: normalizeText(object.color_hex || object.swatch_color || object.shade_hex) || undefined,
    product_url: normalizeText(object.product_url || object.url) || sourceUrl,
    deep_link: normalizeText(object.deep_link || object.url || object.product_url) || sourceUrl,
    source_origin: sourceOrigin,
    source_quality_status: normalizeText(object.source_quality_status || 'high'),
    source_url: sourceUrl,
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined && value !== ''));
}

function buildSnapshotContract(existing, sourceOrigin) {
  return {
    ...ensureObject(existing),
    contract_version: SNAPSHOT_CONTRACT_VERSION,
    source: sourceOrigin,
    authoritative: true,
    structured_fields_authoritative: true,
    legacy_fields_quarantined: true,
    replace_strategy: 'replace_force_or_weak_variant_only',
    updated_at: new Date().toISOString(),
  };
}

function mergeQualitySummary(existing, sourceUrl, sourceOrigin) {
  const now = new Date().toISOString();
  const item = {
    source_origin: sourceOrigin,
    source_quality_status: sourceOrigin === 'official_pdp' ? 'high' : 'medium',
    source_kinds: [sourceOrigin === 'official_pdp' ? 'official_variant_axes' : 'retailer_variant_axes'],
    source_url: sourceUrl,
    reason_codes: ['replace_force_filled_variant_with_source_backed_axes'],
    updated_at: now,
  };
  return {
    ...ensureObject(existing),
    variants: item,
    variant_detail_label: item,
  };
}

function mergeContentAsset(existing, variants, sourceUrl, sourceOrigin) {
  const next = {
    contract_version: PDP_CONTENT_ASSET_VERSION,
    owner: 'pivota',
    fields: { ...ensureObject(ensureObject(existing).fields) },
  };
  next.fields.variants = {
    review_state: 'assistant_reviewed',
    overwrite_policy: 'replace_force_or_weak_only',
    source_quality_status: sourceOrigin === 'official_pdp' ? 'high' : 'medium',
    source_origin: sourceOrigin,
    source_kind: sourceOrigin === 'official_pdp' ? 'official_variant_axes' : 'retailer_variant_axes',
    source_url: sourceUrl,
    content_hash: hashContent(variants),
    updated_at: new Date().toISOString(),
  };
  return next;
}

function buildPatch(row, mapping) {
  const seedData = JSON.parse(JSON.stringify(ensureObject(row.seed_data)));
  const snapshot = ensureObject(seedData.snapshot);
  const productPayload = ensureObject(row.product_payload);
  const identityPayload = ensureObject(row.source_payload);
  const sourceUrl = normalizeText(mapping.source_url);
  const sourceOrigin = normalizeText(mapping.source_origin || mapping.sourceOrigin || 'retail_pdp');
  const variants = asArray(mapping.variants)
    .map((variant) => normalizeVariant(variant, sourceUrl, sourceOrigin))
    .filter(variantIsDisplayable);
  if (!variants.length) {
    return { patchKeys: [], reason: 'no_displayable_source_variants' };
  }
  const protectedVariant = existingVariantIsProtected(seedData, snapshot, productPayload, identityPayload);
  const trustedPriceUrlCorrection = existingVariantNeedsTrustedPriceUrlCorrection(
    seedData,
    mapping,
    variants,
    sourceUrl,
    sourceOrigin,
  );
  const trustedScalarLabelCorrection = existingVariantNeedsTrustedScalarLabelCorrection(seedData, snapshot, mapping);
  const trustedSkuOptionValueCorrection = existingVariantNeedsTrustedSkuOptionValueCorrection(seedData, variants, sourceOrigin);
  if (protectedVariant && !trustedPriceUrlCorrection && !trustedScalarLabelCorrection && !trustedSkuOptionValueCorrection) {
    return { patchKeys: [], reason: 'blocked_protect_high_quality_variant' };
  }
  seedData.variants = variants;
  snapshot.variants = variants;
  if (mapping.variant_detail_label) {
    seedData.variant_detail_label = normalizeText(mapping.variant_detail_label);
    snapshot.variant_detail_label = seedData.variant_detail_label;
    seedData.variant_title = seedData.variant_detail_label;
    snapshot.variant_title = seedData.variant_detail_label;
    seedData.size_detail_label = seedData.variant_detail_label;
    snapshot.size_detail_label = seedData.variant_detail_label;
    seedData.volume = seedData.variant_detail_label;
    snapshot.volume = seedData.variant_detail_label;
  }
  const quality = mergeQualitySummary(seedData.pdp_field_quality_summary || snapshot.pdp_field_quality_summary, sourceUrl, sourceOrigin);
  seedData.pdp_field_quality_summary = quality;
  snapshot.pdp_field_quality_summary = quality;
  seedData.pdp_content_asset_v1 = mergeContentAsset(seedData.pdp_content_asset_v1 || snapshot.pdp_content_asset_v1, variants, sourceUrl, sourceOrigin);
  snapshot.pdp_content_asset_v1 = seedData.pdp_content_asset_v1;
  seedData.external_seed_snapshot_contract = buildSnapshotContract(seedData.external_seed_snapshot_contract, sourceOrigin);
  snapshot.external_seed_snapshot_contract = buildSnapshotContract(snapshot.external_seed_snapshot_contract, sourceOrigin);
  const marker = {
    contract_version: CONTRACT_VERSION,
    source_origin: sourceOrigin,
    source_url: sourceUrl,
    updated_at: new Date().toISOString(),
    fields: ['variants'],
    authority_scope: 'source_backed_variant_axes_exact_product_match',
  };
  seedData.source_variant_fields_v1 = marker;
  snapshot.source_variant_fields_v1 = marker;
  seedData.snapshot = snapshot;
  return {
    seedData,
    variants,
    patchKeys: ['variants'],
    reason: trustedPriceUrlCorrection
      ? 'replace_high_quality_variant_price_url_correction'
      : trustedScalarLabelCorrection
        ? 'replace_high_quality_variant_scalar_label_correction'
      : 'replace_force_or_weak_variant',
  };
}

function buildServingPayloadPatch(seedData) {
  const snapshot = ensureObject(seedData.snapshot);
  const patch = {};
  const copyFirst = (key) => {
    if (seedData[key] !== undefined) patch[key] = seedData[key];
    else if (snapshot[key] !== undefined) patch[key] = snapshot[key];
  };
  patch.snapshot = snapshot;
  [
    'variants',
    'variant_detail_label',
    'variant_title',
    'size_detail_label',
    'volume',
    'pdp_field_quality_summary',
    'pdp_content_asset_v1',
    'source_variant_fields_v1',
    'external_seed_snapshot_contract',
  ].forEach(copyFirst);
  patch.seed_data = seedData;
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

function readMappings() {
  const mappingFile = normalizeText(argValue('mapping-file') || argValue('mappingFile'));
  if (!mappingFile) throw new Error('missing_mapping_file');
  const parsed = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
  return (Array.isArray(parsed) ? parsed : asArray(parsed.mappings)).map((item) => ({
    target_id: item.target_id || item.external_product_id,
    source_url: item.source_url || item.candidate_url,
    source_origin: item.source_origin || item.sourceOrigin || '',
    variants: asArray(item.variants),
    variant_detail_label: item.variant_detail_label || '',
    variant_axes: item.variant_axes || null,
    match_basis: item.match_basis || null,
    allow_price_url_correction: item.allow_price_url_correction === true,
    allow_scalar_variant_label_correction: item.allow_scalar_variant_label_correction === true,
  })).filter((item) => item.target_id && item.source_url);
}

async function fetchRows(ids, market) {
  const result = await query(
    `
      SELECT eps.external_product_id,
             eps.title,
             eps.market,
             eps.domain,
             eps.canonical_url,
             eps.destination_url,
             COALESCE(eps.seed_data, '{}'::jsonb) AS seed_data,
             COALESCE(cp.product_payload, '{}'::jsonb) AS product_payload,
             COALESCE(pil.source_payload, '{}'::jsonb) AS source_payload
      FROM external_product_seeds eps
      LEFT JOIN catalog_products cp
        ON cp.merchant_id = 'external_seed'
       AND cp.platform = 'external_seed'
       AND cp.source_product_id = eps.external_product_id
      LEFT JOIN pdp_identity_listing pil
        ON pil.source_listing_ref = 'external_seed:' || eps.external_product_id
      WHERE eps.status = 'active'
        AND eps.external_product_id = ANY($1::text[])
        AND ($2::text = '' OR upper(eps.market) = upper($2))
      ORDER BY array_position($1::text[], eps.external_product_id::text)
    `,
    [ids, normalizeText(market).toUpperCase()],
  );
  return result.rows || [];
}

async function syncServingMirrors(externalProductId, seedData, mapping) {
  const payloadPatch = buildServingPayloadPatch(seedData);
  const payloadJson = stringifyPostgresJsonb(payloadPatch);
  const catalogRes = await query(
    `
      UPDATE catalog_products
      SET product_payload = COALESCE(product_payload, '{}'::jsonb) || $2::jsonb,
          updated_at = NOW()
      WHERE merchant_id = 'external_seed'
        AND platform = 'external_seed'
        AND source_product_id = $1
    `,
    [externalProductId, payloadJson],
  );
  const variantAxesJson = mapping.variant_axes ? stringifyPostgresJsonb(mapping.variant_axes) : null;
  const matchBasisJson = mapping.match_basis ? stringifyPostgresJsonb(mapping.match_basis) : null;
  const identityRes = await query(
    `
      UPDATE pdp_identity_listing
      SET source_payload = COALESCE(source_payload, '{}'::jsonb) || $2::jsonb,
          variant_axes = CASE WHEN $3::jsonb IS NULL THEN variant_axes ELSE $3::jsonb END,
          match_basis = CASE WHEN $4::jsonb IS NULL THEN match_basis ELSE $4::jsonb END,
          updated_at = NOW()
      WHERE source_listing_ref = $1
    `,
    [`external_seed:${externalProductId}`, payloadJson, variantAxesJson, matchBasisJson],
  );
  return {
    catalog_products: Number(catalogRes.rowCount || 0),
    pdp_identity_listing: Number(identityRes.rowCount || 0),
  };
}

async function main() {
  const mappings = readMappings();
  const dryRun = hasFlag('dry-run') || hasFlag('dryRun') || !hasFlag('apply');
  const resyncServingMirrors = hasFlag('resync-serving-mirrors') || hasFlag('resyncServingMirrors');
  const market = normalizeText(argValue('market') || 'US').toUpperCase();
  const outDir = normalizeText(argValue('out-dir') || argValue('outDir'));
  const rows = await fetchRows(Array.from(new Set(mappings.map((item) => item.target_id))), market);
  const rowsById = new Map(rows.map((row) => [row.external_product_id, row]));
  const results = [];

  for (const mapping of mappings) {
    const sourceHost = hostFromUrl(mapping.source_url);
    const row = rowsById.get(mapping.target_id);
    const result = {
      external_product_id: mapping.target_id,
      title: row?.title || '',
      source_url: mapping.source_url,
      source_host: sourceHost,
      status: 'skipped',
      patch_keys: [],
    };
    if (!row) {
      result.reason = 'target_not_found';
      results.push(result);
      continue;
    }
    if (!TRUSTED_SOURCE_HOSTS.has(sourceHost)) {
      result.reason = 'untrusted_source_host';
      results.push(result);
      continue;
    }
    const beforeHash = hashContent(row.seed_data);
    const patch = buildPatch(row, mapping);
    result.reason = patch.reason;
    result.patch_keys = patch.patchKeys || [];
    result.before_hash = beforeHash;
    if (!patch.patchKeys?.length) {
      if (resyncServingMirrors && patch.reason === 'blocked_protect_high_quality_variant') {
        const currentSeedData = ensureObject(row.seed_data);
        const currentVariants = asArray(currentSeedData.variants);
        result.reason = 'resync_serving_mirror_from_current_seed_snapshot';
        result.patch_keys = ['serving_mirror_snapshot'];
        result.after_hash = beforeHash;
        result.variant_count = currentVariants.length;
        result.variant_labels = currentVariants
          .map((variant) => normalizeText(variant?.display_label || variant?.title || variant?.option_value))
          .filter(Boolean);
        result.status = dryRun ? 'dry_run' : 'updated';
        if (!dryRun) {
          result.serving_mirror_sync = await syncServingMirrors(row.external_product_id, currentSeedData, mapping);
        } else {
          result.serving_mirror_sync = { planned: true };
        }
      }
      results.push(result);
      continue;
    }
    result.after_hash = hashContent(patch.seedData);
    result.variant_count = patch.variants.length;
    result.variant_labels = patch.variants.map((variant) => variant.display_label || variant.title).filter(Boolean);
    result.status = dryRun ? 'dry_run' : 'updated';
    if (!dryRun) {
      await query(
        `
          UPDATE external_product_seeds
          SET seed_data = $2::jsonb,
              updated_at = NOW()
          WHERE external_product_id = $1
        `,
        [row.external_product_id, stringifyPostgresJsonb(patch.seedData)],
      );
      result.serving_mirror_sync = await syncServingMirrors(row.external_product_id, patch.seedData, mapping);
    } else {
      result.serving_mirror_sync = { planned: true };
    }
    results.push(result);
  }

  const summary = {
    scanned: rows.length,
    dry_run: results.filter((item) => item.status === 'dry_run').length,
    updated: results.filter((item) => item.status === 'updated').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    failed: results.filter((item) => item.status === 'failed').length,
    by_field: results.reduce((acc, item) => {
      for (const key of item.patch_keys || []) acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };
  const report = {
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    market,
    contract_version: CONTRACT_VERSION,
    summary,
    results,
  };
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, dryRun ? 'dry-run.json' : 'apply.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool();
    });
}
