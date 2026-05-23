#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { query, closePool } = require('../src/db');

const CONTRACT_VERSION = 'external_seed.same_canonical_pdp_fields.v1';
const PDP_CONTENT_ASSET_VERSION = 'pivota.pdp_content_asset.v1';
const SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';

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

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseDelimited(value) {
  return Array.from(new Set(String(value || '').split(/[\s,]+/).map((item) => item.trim()).filter(Boolean)));
}

function readListFile(filePath) {
  const normalized = normalizeText(filePath);
  if (!normalized) return [];
  return parseDelimited(fs.readFileSync(normalized, 'utf8'));
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

function firstNonEmpty(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value;
    if (normalizeText(value)) return value;
  }
  return '';
}

function pickRowUrl(row) {
  const seedData = ensureObject(row.seed_data);
  const snapshot = ensureObject(seedData.snapshot);
  return firstNonEmpty(
    row.canonical_url,
    row.destination_url,
    seedData.canonical_url,
    snapshot.canonical_url,
    seedData.destination_url,
    snapshot.destination_url,
  );
}

function urlKey(value) {
  const raw = normalizeText(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().toLowerCase();
  } catch {
    return raw.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  }
}

function qualityFromSources(row, key, assetKey = key) {
  const seedData = ensureObject(row.seed_data);
  const snapshot = ensureObject(seedData.snapshot);
  const payload = ensureObject(row.product_payload);
  const listing = ensureObject(row.source_payload);
  const sources = [
    ensureObject(seedData.pdp_field_quality_summary),
    ensureObject(snapshot.pdp_field_quality_summary),
    ensureObject(payload.pdp_field_quality_summary),
    ensureObject(listing.pdp_field_quality_summary),
    ensureObject(ensureObject(seedData.pdp_content_asset_v1).fields),
    ensureObject(ensureObject(snapshot.pdp_content_asset_v1).fields),
    ensureObject(ensureObject(payload.pdp_content_asset_v1).fields),
    ensureObject(ensureObject(listing.pdp_content_asset_v1).fields),
  ];
  for (const source of sources) {
    const item = ensureObject(source[key] || source[assetKey]);
    const sourceOrigin = normalizeText(item.source_origin || item.sourceOrigin);
    const sourceQuality = normalizeText(item.source_quality_status || item.sourceQualityStatus || item.quality_status);
    if (sourceOrigin || sourceQuality) return { ...item, source_origin: sourceOrigin, source_quality_status: sourceQuality };
  }
  return {};
}

function readScalar(row, ...keys) {
  const seedData = ensureObject(row.seed_data);
  const snapshot = ensureObject(seedData.snapshot);
  const payload = ensureObject(row.product_payload);
  const listing = ensureObject(row.source_payload);
  for (const source of [seedData, snapshot, payload, listing]) {
    for (const key of keys) {
      const value = source[key];
      if (normalizeText(value)) return normalizeText(value);
    }
  }
  return '';
}

function readArray(row, ...keys) {
  const seedData = ensureObject(row.seed_data);
  const snapshot = ensureObject(seedData.snapshot);
  const payload = ensureObject(row.product_payload);
  const listing = ensureObject(row.source_payload);
  for (const source of [seedData, snapshot, payload, listing]) {
    for (const key of keys) {
      const value = source[key];
      if (Array.isArray(value) && value.length) return value;
    }
  }
  return [];
}

function lower(value) {
  return normalizeText(value).toLowerCase();
}

function isWeakQuality(quality) {
  const joined = `${lower(quality.source_origin || quality.sourceOrigin)} ${lower(
    quality.source_quality_status || quality.sourceQualityStatus || quality.quality_status,
  )}`;
  if (!joined.trim()) return true;
  return /\b(force|fallback|synthetic|generic|pending|unknown|mock|low)\b|pivota_force_fill|force_fill/.test(joined);
}

function isOfficialHighQuality(quality) {
  const joined = `${lower(quality.source_origin || quality.sourceOrigin)} ${lower(
    quality.source_quality_status || quality.sourceQualityStatus || quality.quality_status,
  )}`;
  if (isWeakQuality(quality)) return false;
  return /official|pdp_section|shopify_json|authoritative|high/.test(joined);
}

function looksLikeIngredientText(value) {
  const text = normalizeText(value);
  if (text.length < 80) return false;
  const items = text.split(/[,;]\s*/).map((item) => item.trim()).filter(Boolean);
  if (items.length < 5) return false;
  if (/\b(add to cart|shop now|customer reviews|wishlist|complete your routine|shipping|returns)\b/i.test(text)) {
    return false;
  }
  return /\b(water|aqua|alcohol|fragrance|parfum|glycerin|dimethicone|silica|wax|oxide|titanium|mica|extract|acid|glycol|limonene|linalool|citronellol)\b/i.test(text);
}

function looksLikeHowToUse(value) {
  const text = normalizeText(value);
  if (text.length < 20 || text.length > 1200) return false;
  if (/\b(add to cart|shop now|customer reviews|wishlist|complete your routine|shipping|returns)\b/i.test(text)) {
    return false;
  }
  return /\b(apply|use|spray|smooth|blend|dispense|massage|swipe|draw|line|brush|diffuse|layer)\b/i.test(text);
}

function currentFieldCanBeFilled(row, fieldName) {
  if (fieldName === 'pdp_ingredients_raw') {
    const value = readScalar(row, 'pdp_ingredients_raw', 'raw_ingredient_text_clean', 'ingredients_raw');
    const quality = qualityFromSources(row, 'ingredients_raw', 'ingredients_inci');
    return !looksLikeIngredientText(value) || isWeakQuality(quality);
  }
  if (fieldName === 'pdp_active_ingredients_raw') {
    const value = readScalar(row, 'pdp_active_ingredients_raw');
    const items = readArray(row, 'active_ingredients');
    const quality = qualityFromSources(row, 'active_ingredients_raw');
    return !(value.length >= 20 || items.length > 0) || isWeakQuality(quality);
  }
  if (fieldName === 'pdp_how_to_use_raw') {
    const value = readScalar(row, 'pdp_how_to_use_raw');
    const quality = qualityFromSources(row, 'how_to_use_raw');
    return !looksLikeHowToUse(value) || isWeakQuality(quality);
  }
  if (fieldName === 'pdp_details_sections') {
    const value = readArray(row, 'pdp_details_sections');
    const quality = qualityFromSources(row, 'details_sections');
    return value.length === 0 || isWeakQuality(quality);
  }
  return false;
}

function readDonorFields(row) {
  const ingredients = readScalar(row, 'pdp_ingredients_raw', 'raw_ingredient_text_clean', 'ingredients_raw');
  const ingredientsQuality = qualityFromSources(row, 'ingredients_raw', 'ingredients_inci');
  const active = readScalar(row, 'pdp_active_ingredients_raw');
  const activeQuality = qualityFromSources(row, 'active_ingredients_raw');
  const howTo = readScalar(row, 'pdp_how_to_use_raw');
  const howToQuality = qualityFromSources(row, 'how_to_use_raw');
  const details = readArray(row, 'pdp_details_sections');
  const detailsQuality = qualityFromSources(row, 'details_sections');
  return {
    pdp_ingredients_raw: looksLikeIngredientText(ingredients) && isOfficialHighQuality(ingredientsQuality) ? ingredients : '',
    pdp_active_ingredients_raw: normalizeText(active).length >= 20 && isOfficialHighQuality(activeQuality) ? active : '',
    active_ingredients: readArray(row, 'active_ingredients'),
    pdp_how_to_use_raw: looksLikeHowToUse(howTo) && isOfficialHighQuality(howToQuality) ? howTo : '',
    pdp_details_sections: details.length && isOfficialHighQuality(detailsQuality) ? details : [],
  };
}

function buildSnapshotContract(existing) {
  return {
    ...ensureObject(existing),
    contract_version: SNAPSHOT_CONTRACT_VERSION,
    source: 'same_canonical_official_sibling_projection',
    authoritative: true,
    structured_fields_authoritative: true,
    legacy_fields_quarantined: true,
    replace_strategy: 'missing_or_weak_only_preserve_best_available',
    updated_at: new Date().toISOString(),
  };
}

function mergeQualitySummary(existing, patchKeys, donorRow, sourceUrl) {
  const next = { ...ensureObject(existing) };
  const now = new Date().toISOString();
  const set = (key, sourceKind, donorQuality) => {
    next[key] = {
      ...ensureObject(donorQuality),
      source_origin: normalizeText(donorQuality.source_origin) || 'official_html',
      source_quality_status: normalizeText(donorQuality.source_quality_status) || 'high',
      source_kinds: Array.from(new Set([...(asArray(donorQuality.source_kinds)), sourceKind])),
      source_url: sourceUrl,
      source_external_product_id: donorRow.external_product_id,
      projection_method: 'same_canonical_official_sibling',
      reason_codes: Array.from(new Set([...(asArray(donorQuality.reason_codes)), 'same_canonical_official_sibling_projection'])),
      updated_at: now,
    };
  };
  if (patchKeys.includes('pdp_ingredients_raw')) {
    const donorQuality = qualityFromSources(donorRow, 'ingredients_raw', 'ingredients_inci');
    set('ingredients_raw', 'official_pdp_full_ingredients', donorQuality);
    set('ingredients_inci', 'official_pdp_full_ingredients', donorQuality);
  }
  if (patchKeys.includes('pdp_active_ingredients_raw')) {
    set('active_ingredients_raw', 'official_pdp_key_ingredients', qualityFromSources(donorRow, 'active_ingredients_raw'));
  }
  if (patchKeys.includes('pdp_how_to_use_raw')) {
    set('how_to_use_raw', 'official_pdp_how_to_use', qualityFromSources(donorRow, 'how_to_use_raw'));
  }
  if (patchKeys.includes('pdp_details_sections')) {
    set('details_sections', 'official_pdp_details_section', qualityFromSources(donorRow, 'details_sections'));
  }
  return next;
}

function mergeContentAsset(existing, patch, patchKeys, donorRow, sourceUrl) {
  const next = {
    contract_version: PDP_CONTENT_ASSET_VERSION,
    owner: 'pivota',
    fields: { ...ensureObject(ensureObject(existing).fields) },
  };
  const now = new Date().toISOString();
  const set = (fieldKey, value, sourceKind) => {
    next.fields[fieldKey] = {
      review_state: 'assistant_reviewed',
      overwrite_policy: 'preserve_best_available',
      source_quality_status: 'high',
      source_origin: 'official_html',
      source_kind: sourceKind,
      source_url: sourceUrl,
      source_external_product_id: donorRow.external_product_id,
      projection_method: 'same_canonical_official_sibling',
      content_hash: hashContent(value),
      updated_at: now,
    };
  };
  if (patchKeys.includes('pdp_ingredients_raw')) set('ingredients_raw', patch.pdp_ingredients_raw, 'official_pdp_full_ingredients');
  if (patchKeys.includes('pdp_active_ingredients_raw')) set('active_ingredients_raw', patch.pdp_active_ingredients_raw, 'official_pdp_key_ingredients');
  if (patchKeys.includes('pdp_how_to_use_raw')) set('how_to_use_raw', patch.pdp_how_to_use_raw, 'official_pdp_how_to_use');
  if (patchKeys.includes('pdp_details_sections')) set('details_sections', patch.pdp_details_sections, 'official_pdp_details_section');
  return next;
}

function clearForceFillIngredientIntel(container) {
  const intel = ensureObject(container.ingredient_intel);
  if (!Object.keys(intel).length) return;
  delete intel.force_fill_contract;
  delete intel.forceFillContract;
  container.ingredient_intel = Object.keys(intel).length ? intel : undefined;
}

function buildSeedDataPatch(targetRow, donorRow) {
  const seedData = JSON.parse(JSON.stringify(ensureObject(targetRow.seed_data)));
  const snapshot = ensureObject(seedData.snapshot);
  const donor = readDonorFields(donorRow);
  const sourceUrl = pickRowUrl(donorRow);
  const patchKeys = [];
  const oldHashes = {};
  const newHashes = {};

  const setHash = (field, oldValue, newValue) => {
    oldHashes[field] = hashContent(oldValue);
    newHashes[field] = hashContent(newValue);
  };

  if (donor.pdp_ingredients_raw && currentFieldCanBeFilled(targetRow, 'pdp_ingredients_raw')) {
    setHash('pdp_ingredients_raw', readScalar(targetRow, 'pdp_ingredients_raw', 'raw_ingredient_text_clean'), donor.pdp_ingredients_raw);
    seedData.pdp_ingredients_raw = donor.pdp_ingredients_raw;
    seedData.raw_ingredient_text_clean = donor.pdp_ingredients_raw;
    snapshot.pdp_ingredients_raw = donor.pdp_ingredients_raw;
    snapshot.raw_ingredient_text_clean = donor.pdp_ingredients_raw;
    patchKeys.push('pdp_ingredients_raw');
    clearForceFillIngredientIntel(seedData);
    clearForceFillIngredientIntel(snapshot);
  }
  if (donor.pdp_active_ingredients_raw && currentFieldCanBeFilled(targetRow, 'pdp_active_ingredients_raw')) {
    setHash('pdp_active_ingredients_raw', readScalar(targetRow, 'pdp_active_ingredients_raw'), donor.pdp_active_ingredients_raw);
    seedData.pdp_active_ingredients_raw = donor.pdp_active_ingredients_raw;
    snapshot.pdp_active_ingredients_raw = donor.pdp_active_ingredients_raw;
    const activeItems = donor.active_ingredients.length
      ? donor.active_ingredients
      : Array.from(new Set(donor.pdp_active_ingredients_raw.split(/,|;|\n/).map(normalizeText).filter(Boolean)));
    if (activeItems.length) {
      seedData.active_ingredients = activeItems;
      snapshot.active_ingredients = activeItems;
    }
    patchKeys.push('pdp_active_ingredients_raw');
  }
  if (donor.pdp_how_to_use_raw && currentFieldCanBeFilled(targetRow, 'pdp_how_to_use_raw')) {
    setHash('pdp_how_to_use_raw', readScalar(targetRow, 'pdp_how_to_use_raw'), donor.pdp_how_to_use_raw);
    seedData.pdp_how_to_use_raw = donor.pdp_how_to_use_raw;
    snapshot.pdp_how_to_use_raw = donor.pdp_how_to_use_raw;
    patchKeys.push('pdp_how_to_use_raw');
  }
  if (donor.pdp_details_sections.length && currentFieldCanBeFilled(targetRow, 'pdp_details_sections')) {
    setHash('pdp_details_sections', readArray(targetRow, 'pdp_details_sections'), donor.pdp_details_sections);
    seedData.pdp_details_sections = donor.pdp_details_sections;
    snapshot.pdp_details_sections = donor.pdp_details_sections;
    patchKeys.push('pdp_details_sections');
  }

  if (patchKeys.length) {
    const quality = mergeQualitySummary(seedData.pdp_field_quality_summary || snapshot.pdp_field_quality_summary, patchKeys, donorRow, sourceUrl);
    seedData.pdp_field_quality_summary = quality;
    snapshot.pdp_field_quality_summary = quality;
    seedData.pdp_content_asset_v1 = mergeContentAsset(seedData.pdp_content_asset_v1 || snapshot.pdp_content_asset_v1, seedData, patchKeys, donorRow, sourceUrl);
    snapshot.pdp_content_asset_v1 = seedData.pdp_content_asset_v1;
    seedData.external_seed_snapshot_contract = buildSnapshotContract(seedData.external_seed_snapshot_contract);
    snapshot.external_seed_snapshot_contract = buildSnapshotContract(snapshot.external_seed_snapshot_contract);
    seedData.same_canonical_pdp_fields_v1 = {
      contract_version: CONTRACT_VERSION,
      source_origin: 'official_html',
      source_url: sourceUrl,
      source_external_product_id: donorRow.external_product_id,
      source_canonical_url: urlKey(sourceUrl),
      authority_scope: 'same_canonical_exact_product_official_sibling',
      fields: patchKeys,
      updated_at: new Date().toISOString(),
    };
    snapshot.same_canonical_pdp_fields_v1 = seedData.same_canonical_pdp_fields_v1;
  }

  seedData.snapshot = snapshot;
  return { seedData, patchKeys, oldHashes, newHashes };
}

function buildServingPayloadPatch(seedData, patchKeys) {
  const snapshot = ensureObject(seedData.snapshot);
  const patch = {};
  const copyFirst = (targetKey, ...sourceKeys) => {
    for (const key of sourceKeys) {
      if (seedData[key] !== undefined) {
        patch[targetKey] = seedData[key];
        return;
      }
      if (snapshot[key] !== undefined) {
        patch[targetKey] = snapshot[key];
        return;
      }
    }
  };
  if (patchKeys.includes('pdp_ingredients_raw')) {
    copyFirst('pdp_ingredients_raw', 'pdp_ingredients_raw');
    copyFirst('raw_ingredient_text_clean', 'raw_ingredient_text_clean', 'pdp_ingredients_raw');
    copyFirst('ingredient_intel', 'ingredient_intel');
  }
  if (patchKeys.includes('pdp_active_ingredients_raw')) {
    copyFirst('pdp_active_ingredients_raw', 'pdp_active_ingredients_raw');
    copyFirst('active_ingredients', 'active_ingredients');
  }
  if (patchKeys.includes('pdp_how_to_use_raw')) copyFirst('pdp_how_to_use_raw', 'pdp_how_to_use_raw');
  if (patchKeys.includes('pdp_details_sections')) copyFirst('pdp_details_sections', 'pdp_details_sections');
  copyFirst('pdp_field_quality_summary', 'pdp_field_quality_summary');
  copyFirst('pdp_content_asset_v1', 'pdp_content_asset_v1');
  copyFirst('same_canonical_pdp_fields_v1', 'same_canonical_pdp_fields_v1');
  copyFirst('external_seed_snapshot_contract', 'external_seed_snapshot_contract');
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

async function syncServingMirrors(externalProductId, seedData, patchKeys) {
  const payloadPatch = buildServingPayloadPatch(seedData, patchKeys);
  if (!Object.keys(payloadPatch).length) return { catalog_products: 0, pdp_identity_listing: 0 };
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
  const identityRes = await query(
    `
      UPDATE pdp_identity_listing
      SET source_payload = COALESCE(source_payload, '{}'::jsonb) || $2::jsonb,
          updated_at = NOW()
      WHERE source_listing_ref = $1
    `,
    [`external_seed:${externalProductId}`, payloadJson],
  );
  return {
    catalog_products: Number(catalogRes.rowCount || 0),
    pdp_identity_listing: Number(identityRes.rowCount || 0),
  };
}

async function fetchRows({ market, domains, externalProductIds }) {
  const params = [market, domains, externalProductIds];
  const res = await query(
    `
      SELECT
        eps.id,
        eps.external_product_id,
        eps.market,
        eps.domain,
        eps.title,
        eps.canonical_url,
        eps.destination_url,
        eps.seed_data,
        NULL::jsonb AS product_payload,
        NULL::jsonb AS source_payload
      FROM external_product_seeds eps
      WHERE eps.status = 'active'
        AND eps.market = $1
        AND eps.domain = ANY($2::text[])
        AND (cardinality($3::text[]) = 0 OR eps.external_product_id = ANY($3::text[]))
      ORDER BY eps.domain, eps.title, eps.external_product_id
    `,
    params,
  );
  return res.rows || [];
}

function chooseDonor(rows) {
  const candidates = rows
    .map((row) => ({ row, fields: readDonorFields(row) }))
    .filter((item) => item.fields.pdp_ingredients_raw)
    .sort((left, right) => {
      const leftScore =
        left.fields.pdp_ingredients_raw.length +
        (left.fields.pdp_how_to_use_raw ? 250 : 0) +
        (left.fields.pdp_details_sections.length ? 250 : 0) +
        (left.fields.pdp_active_ingredients_raw ? 100 : 0);
      const rightScore =
        right.fields.pdp_ingredients_raw.length +
        (right.fields.pdp_how_to_use_raw ? 250 : 0) +
        (right.fields.pdp_details_sections.length ? 250 : 0) +
        (right.fields.pdp_active_ingredients_raw ? 100 : 0);
      return rightScore - leftScore;
    });
  return candidates[0]?.row || null;
}

function targetNeedsPatch(row) {
  return (
    currentFieldCanBeFilled(row, 'pdp_ingredients_raw') ||
    currentFieldCanBeFilled(row, 'pdp_active_ingredients_raw') ||
    currentFieldCanBeFilled(row, 'pdp_how_to_use_raw') ||
    currentFieldCanBeFilled(row, 'pdp_details_sections')
  );
}

async function main() {
  const market = normalizeText(argValue('market') || 'US').toUpperCase();
  const domains = parseDelimited(argValue('domains') || argValue('domain') || 'www.tomfordbeauty.com,www.guerlain.com');
  const externalProductIds = [
    ...parseDelimited(argValue('external-product-ids') || argValue('externalProductIds')),
    ...readListFile(argValue('external-product-ids-file') || argValue('externalProductIdsFile')),
  ];
  const dryRun = hasFlag('dry-run') || hasFlag('dryRun') || !hasFlag('apply');
  const outDir = normalizeText(argValue('out-dir') || argValue('outDir'));
  const limit = Number.parseInt(argValue('limit') || '0', 10) || 0;

  const rows = await fetchRows({ market, domains, externalProductIds });
  const byUrl = new Map();
  for (const row of rows) {
    const key = urlKey(pickRowUrl(row));
    if (!key) continue;
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(row);
  }

  const results = [];
  for (const [canonicalUrl, groupRows] of byUrl) {
    const donor = chooseDonor(groupRows);
    if (!donor) continue;
    for (const target of groupRows) {
      if (target.external_product_id === donor.external_product_id) continue;
      if (!targetNeedsPatch(target)) continue;
      const { seedData, patchKeys, oldHashes, newHashes } = buildSeedDataPatch(target, donor);
      if (!patchKeys.length) continue;
      const result = {
        external_product_id: target.external_product_id,
        title: target.title,
        canonical_url: canonicalUrl,
        donor_external_product_id: donor.external_product_id,
        donor_title: donor.title,
        status: dryRun ? 'dry_run' : 'updated',
        patch_keys: patchKeys,
        old_value_hash: oldHashes,
        new_value_hash: newHashes,
      };
      if (!dryRun) {
        await query(
          `
            UPDATE external_product_seeds
            SET seed_data = $2::jsonb,
                updated_at = NOW()
            WHERE external_product_id = $1
          `,
          [target.external_product_id, stringifyPostgresJsonb(seedData)],
        );
        result.serving_mirror_sync = await syncServingMirrors(target.external_product_id, seedData, patchKeys);
      } else {
        result.serving_mirror_sync = { planned: true };
      }
      results.push(result);
      if (limit > 0 && results.length >= limit) break;
    }
    if (limit > 0 && results.length >= limit) break;
  }

  const summary = {
    scanned: rows.length,
    groups: byUrl.size,
    dry_run: results.filter((item) => item.status === 'dry_run').length,
    updated: results.filter((item) => item.status === 'updated').length,
    by_field: results.reduce((acc, item) => {
      for (const key of item.patch_keys || []) acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };
  const report = {
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    market,
    domains,
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
      console.error(error?.stack || error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool();
    });
}
