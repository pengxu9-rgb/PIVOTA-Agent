#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');
const { classifyExternalSeedProductKind } = require('../src/services/externalSeedProductKind');

const APPLICABILITY_CONTRACT_VERSION = 'external_seed.ingredient_applicability.v1';
const REVIEW_QUEUE_CONTRACT_VERSION = 'external_seed.ingredient_source_review_queue.v1';
const REMEDIATION_CONTRACT_VERSION = 'external_seed.ingredient_remediation.v1';

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return '';
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : '';
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  return String(value || '').replace(/\u0000/g, '').replace(/\\+u0000/gi, '').replace(/\s+/g, ' ').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sanitizeJsonValue(value) {
  if (typeof value === 'string') return value.replace(/\u0000/g, '').replace(/\\+u0000/gi, '');
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        String(key).replace(/\u0000/g, '').replace(/\\+u0000/gi, ''),
        sanitizeJsonValue(item),
      ]),
    );
  }
  return value;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readJson(filePath) {
  const normalized = asString(filePath);
  if (!normalized) throw new Error('--readiness-json is required');
  return JSON.parse(fs.readFileSync(normalized, 'utf8'));
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = asString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function stripHtml(value) {
  return asString(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function readInciText(seedData) {
  const snapshot = asObject(seedData.snapshot);
  return [
    seedData.pdp_ingredients_raw,
    snapshot.pdp_ingredients_raw,
    seedData.ingredients_raw,
    snapshot.ingredients_raw,
    seedData.raw_ingredient_text_clean,
    snapshot.raw_ingredient_text_clean,
  ]
    .map(stripHtml)
    .find(Boolean) || '';
}

function hasStructuredInci(seedData) {
  const snapshot = asObject(seedData.snapshot);
  return [
    seedData.ingredients_inci,
    snapshot.ingredients_inci,
    seedData.inci_list,
    snapshot.inci_list,
    asObject(seedData.ingredient_intel).inci_list,
    asObject(snapshot.ingredient_intel).inci_list,
  ].some((value) => asArray(value).length > 0);
}

function qualityStatus(seedData, key) {
  const snapshot = asObject(seedData.snapshot);
  const quality = {
    ...asObject(snapshot.pdp_field_quality_summary),
    ...asObject(seedData.pdp_field_quality_summary),
  };
  const item = asObject(quality[key]);
  return {
    status: asString(item.source_quality_status).toLowerCase(),
    origin: asString(item.source_origin).toLowerCase(),
  };
}

function hasForceFilledInci(seedData) {
  return ['ingredients_raw', 'ingredients_inci'].some((key) => {
    const quality = qualityStatus(seedData, key);
    return quality.status.startsWith('force_filled') || quality.origin === 'pivota_force_fill';
  });
}

function shouldIncludeReadinessRow(row) {
  return !Number(row?.coverage?.inci_chars || 0);
}

function loadTargetIds(readinessPayload, productIdFilter) {
  const productIds = productIdFilter ? productIdFilter.split(',').map(asString).filter(Boolean) : [];
  if (productIds.length) return productIds;
  return uniqueStrings(asArray(readinessPayload.rows).filter(shouldIncludeReadinessRow).map((row) => row.external_product_id));
}

async function fetchRows(ids, { market = '', domain = '' } = {}) {
  const rows = [];
  for (let index = 0; index < ids.length; index += 500) {
    const chunk = ids.slice(index, index + 500);
    const res = await query(
      `
        SELECT id, external_product_id, market, domain, title, canonical_url, destination_url,
               coalesce(seed_data, '{}'::jsonb) AS seed_data
        FROM external_product_seeds
        WHERE status = 'active'
          AND external_product_id = ANY($1::text[])
          AND ($2::text = '' OR upper(market) = upper($2))
          AND ($3::text = '' OR domain = $3)
        ORDER BY external_product_id
      `,
      [chunk, asString(market).toUpperCase(), asString(domain)],
    );
    rows.push(...(res.rows || []));
  }
  return rows;
}

function mergeQuality(seedData, key, patch) {
  const snapshot = asObject(seedData.snapshot);
  const existing = {
    ...asObject(snapshot.pdp_field_quality_summary),
    ...asObject(seedData.pdp_field_quality_summary),
  };
  const next = {
    ...existing,
    [key]: {
      ...asObject(existing[key]),
      ...patch,
    },
  };
  seedData.pdp_field_quality_summary = next;
  snapshot.pdp_field_quality_summary = next;
}

function mergeSnapshotContract(seedData, generatedAt) {
  const snapshot = asObject(seedData.snapshot);
  const existing = {
    ...asObject(snapshot.external_seed_snapshot_contract),
    ...asObject(seedData.external_seed_snapshot_contract),
  };
  const next = {
    ...existing,
    contract_version: existing.contract_version || 'external_seed.snapshot_contract.v1',
    authoritative: true,
    structured_fields_authoritative: true,
    legacy_fields_quarantined: true,
    replace_strategy: existing.replace_strategy || 'replace_not_merge',
    updated_at: generatedAt,
  };
  seedData.external_seed_snapshot_contract = next;
  snapshot.external_seed_snapshot_contract = next;
}

function patchBothIngredientIntel(seedData, patch) {
  const snapshot = asObject(seedData.snapshot);
  seedData.ingredient_intel = {
    ...asObject(seedData.ingredient_intel),
    ...patch,
  };
  snapshot.ingredient_intel = {
    ...asObject(snapshot.ingredient_intel),
    ...patch,
  };
}

function patchBothRemediation(seedData, remediation) {
  const snapshot = asObject(seedData.snapshot);
  seedData.ingredient_remediation_v1 = remediation;
  snapshot.ingredient_remediation_v1 = remediation;
}

function buildApplicability(row, family, generatedAt) {
  return {
    contract_version: APPLICABILITY_CONTRACT_VERSION,
    field: 'ingredients_inci',
    status: 'not_applicable',
    reason: `product_family_${family}`,
    reason_codes: [`product_family_${family}`],
    source_origin: 'pivota_manual_component_repair',
    review_state: 'reviewed',
    external_product_id: row.external_product_id,
    reviewed_at: generatedAt,
    updated_at: generatedAt,
  };
}

function buildReviewQueue(row, family, status, reasonCodes, generatedAt) {
  return {
    contract_version: REVIEW_QUEUE_CONTRACT_VERSION,
    field: 'ingredients_inci',
    status,
    product_family: family,
    reason_codes: reasonCodes,
    source_origin: 'pivota_manual_component_repair',
    review_state: 'queued',
    queue_id: `ingredient_source_review:${row.external_product_id}`,
    external_product_id: row.external_product_id,
    title: asString(row.title),
    canonical_url: asString(row.canonical_url || row.destination_url),
    created_at: generatedAt,
    updated_at: generatedAt,
  };
}

function buildRemediation(row, family, action, reasonCodes, generatedAt) {
  return {
    contract_version: REMEDIATION_CONTRACT_VERSION,
    field: 'ingredients_inci',
    action,
    product_family: family,
    reason_codes: reasonCodes,
    source_origin: 'pivota_manual_component_repair',
    external_product_id: row.external_product_id,
    updated_at: generatedAt,
  };
}

function existingManualRemediation(seedData) {
  const snapshot = asObject(seedData.snapshot);
  const remediation = {
    ...asObject(snapshot.ingredient_remediation_v1),
    ...asObject(seedData.ingredient_remediation_v1),
  };
  if (
    remediation.field !== 'ingredients_inci'
    || remediation.source_origin !== 'pivota_manual_component_repair'
  ) {
    return null;
  }
  return remediation;
}

function existingIngredientIntelStatus(seedData) {
  const snapshot = asObject(seedData.snapshot);
  const rootIntel = asObject(seedData.ingredient_intel);
  const snapshotIntel = asObject(snapshot.ingredient_intel);
  const applicability = {
    ...asObject(snapshotIntel.inci_applicability),
    ...asObject(rootIntel.inci_applicability),
  };
  const queue = {
    ...asObject(snapshotIntel.source_review_queue),
    ...asObject(rootIntel.source_review_queue),
  };
  return {
    applicabilityStatus: applicability.status || '',
    queueStatus: queue.status || '',
  };
}

function existingBundleComponentRefs(seedData) {
  const snapshot = asObject(seedData.snapshot);
  return asArray(seedData.bundle_component_refs).length
    ? asArray(seedData.bundle_component_refs)
    : asArray(snapshot.bundle_component_refs);
}

function buildPlan(row, options = {}) {
  const generatedAt = options.generatedAt;
  const seedData = sanitizeJsonValue(JSON.parse(JSON.stringify(asObject(row.seed_data))));
  seedData.snapshot = asObject(seedData.snapshot);
  const family = classifyExternalSeedProductKind({ ...row, seed_data: seedData }).family;
  const before = JSON.stringify(seedData);
  const currentInci = readInciText(seedData);
  const currentStructuredInci = hasStructuredInci(seedData);
  const forceFilledInci = hasForceFilledInci(seedData);
  const result = {
    external_product_id: row.external_product_id,
    title: row.title,
    family,
    status: 'unchanged',
    action: null,
    reason_codes: [],
  };

  if ((currentInci || currentStructuredInci) && !forceFilledInci) {
    result.status = 'skipped_current_has_inci';
    return { result, nextSeedData: seedData, changed: false };
  }

  const existingRemediation = existingManualRemediation(seedData);
  const existingIntelStatus = existingIngredientIntelStatus(seedData);
  const existingComponentRefs = existingBundleComponentRefs(seedData);
  if (
    existingRemediation?.action === 'mark_inci_not_applicable'
    && existingIntelStatus.applicabilityStatus === 'not_applicable'
  ) {
    result.status = 'already_remediated';
    result.action = existingRemediation.action;
    result.reason_codes = asArray(existingRemediation.reason_codes);
    return { result, nextSeedData: seedData, changed: false };
  }
  if (
    ['component_refs_linked', 'manual_source_review_required'].includes(existingRemediation?.action)
    && existingIntelStatus.queueStatus === existingRemediation.action
  ) {
    result.status = 'already_remediated';
    result.action = existingRemediation.action;
    result.reason_codes = asArray(existingRemediation.reason_codes);
    return { result, nextSeedData: seedData, changed: false };
  }
  if (
    existingRemediation?.action === 'component_ref_review_required'
    && existingIntelStatus.queueStatus === existingRemediation.action
    && !existingComponentRefs.length
  ) {
    result.status = 'already_remediated';
    result.action = existingRemediation.action;
    result.reason_codes = asArray(existingRemediation.reason_codes);
    return { result, nextSeedData: seedData, changed: false };
  }

  if (family === 'accessory' || family === 'non_merch') {
    const applicability = buildApplicability(row, family, generatedAt);
    patchBothIngredientIntel(seedData, { inci_applicability: applicability });
    patchBothRemediation(
      seedData,
      buildRemediation(row, family, 'mark_inci_not_applicable', applicability.reason_codes, generatedAt),
    );
    mergeQuality(seedData, 'ingredients_inci', {
      source_origin: 'pivota_manual_component_repair',
      source_quality_status: 'not_applicable',
      reason_codes: applicability.reason_codes,
      updated_at: generatedAt,
    });
    result.action = 'mark_inci_not_applicable';
    result.reason_codes = applicability.reason_codes;
  } else if (family === 'set_or_collection') {
    const componentRefs = existingComponentRefs;
    const status = componentRefs.length ? 'component_refs_linked' : 'component_ref_review_required';
    const reasonCodes = componentRefs.length
      ? ['bundle_component_refs_linked']
      : ['bundle_component_refs_required'];
    const queue = buildReviewQueue(row, family, status, reasonCodes, generatedAt);
    patchBothIngredientIntel(seedData, { source_review_queue: queue });
    patchBothRemediation(
      seedData,
      buildRemediation(row, family, status, reasonCodes, generatedAt),
    );
    result.action = status;
    result.reason_codes = reasonCodes;
  } else {
    const reasonCodes = family === 'unknown_product'
      ? ['product_family_review_required', 'manual_ingredient_source_review_required']
      : ['manual_ingredient_source_review_required'];
    const queue = buildReviewQueue(row, family, 'manual_source_review_required', reasonCodes, generatedAt);
    patchBothIngredientIntel(seedData, { source_review_queue: queue });
    patchBothRemediation(
      seedData,
      buildRemediation(row, family, 'manual_source_review_required', reasonCodes, generatedAt),
    );
    mergeQuality(seedData, 'ingredients_raw', {
      source_origin: 'manual_source_review_required',
      source_quality_status: 'blocked',
      reason_codes: reasonCodes,
      updated_at: generatedAt,
    });
    mergeQuality(seedData, 'ingredients_inci', {
      source_origin: 'manual_source_review_required',
      source_quality_status: 'blocked',
      reason_codes: reasonCodes,
      updated_at: generatedAt,
    });
    result.action = 'manual_source_review_required';
    result.reason_codes = reasonCodes;
  }

  if (result.action) mergeSnapshotContract(seedData, generatedAt);
  const changed = before !== JSON.stringify(seedData);
  result.status = changed ? (options.apply ? 'pending_apply' : 'dry_run') : 'unchanged';
  return { result, nextSeedData: seedData, changed };
}

function buildServingBlockPatch(seedData) {
  const snapshot = asObject(seedData.snapshot);
  const patch = {};
  for (const key of [
    'pdp_field_quality_summary',
    'ingredient_intel',
    'ingredient_remediation_v1',
    'external_seed_snapshot_contract',
    'strict_pdp_source_blocker_v1',
  ]) {
    if (seedData[key] !== undefined) patch[key] = seedData[key];
    else if (snapshot[key] !== undefined) patch[key] = snapshot[key];
  }
  return patch;
}

async function syncIngredientBlockerServingMirrors(externalProductId, seedData) {
  const payloadPatch = buildServingBlockPatch(seedData);
  if (!Object.keys(payloadPatch).length) return { catalog_products: 0, pdp_identity_listing: 0 };
  const payloadJson = JSON.stringify(payloadPatch).replace(/\u0000/g, '').replace(/\\+u0000/gi, '');
  const removeKeys = [
    'pdp_ingredients_raw',
    'raw_ingredient_text_clean',
    'ingredients_inci',
    'ingredient_text',
    'ingredient_intel_legacy',
    'ingredient_names',
    'ingredientNames',
    'key_ingredients',
    'keyIngredients',
  ];
  const catalogRes = await query(
    `
      UPDATE catalog_products
      SET product_payload = (
            COALESCE(product_payload, '{}'::jsonb)
            - 'pdp_ingredients_raw'
            - 'raw_ingredient_text_clean'
            - 'ingredients_inci'
            - 'ingredient_text'
            - 'ingredient_intel_legacy'
            - 'ingredient_names'
            - 'ingredientNames'
            - 'key_ingredients'
            - 'keyIngredients'
          ) || $2::jsonb,
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
      SET source_payload = (
            COALESCE(source_payload, '{}'::jsonb)
            - 'pdp_ingredients_raw'
            - 'raw_ingredient_text_clean'
            - 'ingredients_inci'
            - 'ingredient_text'
            - 'ingredient_intel_legacy'
            - 'ingredient_names'
            - 'ingredientNames'
            - 'key_ingredients'
            - 'keyIngredients'
          ) || $2::jsonb,
          updated_at = NOW()
      WHERE source_listing_ref = $3
    `,
    [externalProductId, payloadJson, `external_seed:${externalProductId}`],
  );
  return {
    catalog_products: Number(catalogRes.rowCount || 0),
    pdp_identity_listing: Number(identityRes.rowCount || 0),
    remove_keys: removeKeys,
  };
}

async function main() {
  const productIdFilter = argValue('product-ids');
  const readinessPayload = productIdFilter ? { rows: [] } : readJson(argValue('readiness-json'));
  const productIds = loadTargetIds(readinessPayload, productIdFilter);
  const options = {
    apply: hasFlag('apply'),
    market: argValue('market') || 'US',
    domain: argValue('domain'),
    out: argValue('out'),
    generatedAt: new Date().toISOString(),
  };
  const rows = await fetchRows(productIds, options);
  const plans = rows.map((row) => buildPlan(row, options));
  let updatedRows = 0;
  const applyErrors = [];
  const mirrorSync = [];

  if (options.apply) {
    for (const plan of plans) {
      if (plan.changed) {
        const payloadJson = JSON.stringify(plan.nextSeedData).replace(/\u0000/g, '').replace(/\\+u0000/gi, '');
        if (payloadJson.includes('\u0000') || /\\+u0000/i.test(payloadJson)) {
          throw new Error(`payload still contains NUL marker (external_product_id=${plan.result.external_product_id})`);
        }
        let res;
        try {
          res = await query(
            `
              UPDATE external_product_seeds
              SET seed_data = $2::jsonb,
                  updated_at = NOW()
              WHERE external_product_id = $1
                AND status = 'active'
                AND seed_data IS DISTINCT FROM $2::jsonb
            `,
            [plan.result.external_product_id, payloadJson],
          );
        } catch (error) {
          plan.result.status = 'apply_failed';
          plan.result.error = String(error?.message || error);
          applyErrors.push({
            external_product_id: plan.result.external_product_id,
            title: plan.result.title,
            action: plan.result.action,
            error: plan.result.error,
          });
          continue;
        }
        updatedRows += Number(res.rowCount || 0);
        if (res.rowCount > 0) plan.result.status = 'updated';
      }
      if (['manual_source_review_required', 'component_refs_linked', 'component_ref_review_required'].includes(plan.result.action)) {
        try {
          const sync = await syncIngredientBlockerServingMirrors(plan.result.external_product_id, plan.nextSeedData);
          plan.result.serving_mirror_sync = sync;
          mirrorSync.push({ external_product_id: plan.result.external_product_id, ...sync });
        } catch (error) {
          plan.result.status = 'apply_failed';
          plan.result.error = String(error?.message || error);
          applyErrors.push({
            external_product_id: plan.result.external_product_id,
            title: plan.result.title,
            action: plan.result.action,
            error: plan.result.error,
          });
        }
      }
    }
  }

  const results = plans.map((plan) => plan.result);
  const summary = {
    dry_run: !options.apply,
    input_target_ids: productIds.length,
    fetched_rows: rows.length,
    changed_rows: plans.filter((plan) => plan.changed).length,
    updated_rows: updatedRows,
    failed_rows: applyErrors.length,
    serving_mirror_catalog_updates: mirrorSync.reduce((sum, item) => sum + Number(item.catalog_products || 0), 0),
    serving_mirror_identity_updates: mirrorSync.reduce((sum, item) => sum + Number(item.pdp_identity_listing || 0), 0),
    by_action: results.reduce((acc, item) => {
      const key = item.action || item.status || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    by_status: results.reduce((acc, item) => {
      const key = item.status || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    by_family: results.reduce((acc, item) => {
      const key = item.family || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };
  const report = {
    generated_at: options.generatedAt,
    options,
    summary,
    apply_errors: applyErrors,
    results,
  };
  if (options.out) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
