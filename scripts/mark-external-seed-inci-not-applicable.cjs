#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');

const REMEDIATION_VERSION = 'external_seed.ingredient_not_applicable_review.v1';
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
  return String(value || '').replace(/\u0000/g, '').replace(/\\+u0000/gi, '').trim();
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parseDelimited(value) {
  return Array.from(new Set(String(value || '').split(/[\s,]+/).map((item) => item.trim()).filter(Boolean)));
}

function readIdsFile(filePath) {
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

function buildSnapshotContract(existing) {
  return {
    ...ensureObject(existing),
    contract_version: SNAPSHOT_CONTRACT_VERSION,
    source: 'manual_component_level_review',
    authoritative: true,
    structured_fields_authoritative: true,
    legacy_fields_quarantined: true,
    replace_strategy: 'reviewed_not_applicable',
    updated_at: new Date().toISOString(),
  };
}

function patchSeedData(row, options = {}) {
  const seedData = JSON.parse(JSON.stringify(ensureObject(row.seed_data)));
  const snapshot = ensureObject(seedData.snapshot);
  const now = options.reviewedAt || new Date().toISOString();
  const reason = normalizeText(options.reason) || 'product_family_accessory';
  const sourceUrl = normalizeText(options.sourceUrl) || row.canonical_url || row.destination_url || null;
  const family = normalizeText(options.productFamily) || 'accessory';
  const productType = normalizeText(options.productType) || seedData.product_type || snapshot.product_type || '';

  const applicability = {
    status: 'not_applicable',
    reason,
    review_state: 'reviewed',
    source_origin: 'pivota_manual_component_repair',
    source_quality_status: 'high',
    source_url: sourceUrl,
    reviewed_by: normalizeText(options.reviewedBy) || 'codex',
    reviewed_at: now,
    updated_at: now,
  };
  const remediation = {
    contract_version: REMEDIATION_VERSION,
    field: 'ingredients_inci',
    action: 'mark_inci_not_applicable',
    source_origin: 'pivota_manual_component_repair',
    source_quality_status: 'reviewed_not_applicable',
    review_state: 'assistant_reviewed',
    reason,
    source_url: sourceUrl,
    reviewed_by: normalizeText(options.reviewedBy) || 'codex',
    reviewed_at: now,
    updated_at: now,
  };
  const quality = {
    source_origin: 'pivota_manual_component_repair',
    source_quality_status: 'reviewed_not_applicable',
    review_state: 'assistant_reviewed',
    source_url: sourceUrl,
    reason_codes: [reason, 'manual_component_level_not_applicable'],
    updated_at: now,
  };

  const applyTarget = (target) => {
    if (!target || typeof target !== 'object') return;
    target.product_family = family;
    if (productType) target.product_type = productType;
    delete target.pdp_ingredients_raw;
    delete target.raw_ingredient_text_clean;
    delete target.ingredients_inci;
    delete target.inci_list;
    delete target.inciList;
    const intel = ensureObject(target.ingredient_intel);
    delete intel.force_fill_contract;
    delete intel.forceFillContract;
    intel.not_applicable = true;
    intel.inci_applicability = applicability;
    target.ingredient_intel = intel;
    target.ingredient_remediation_v1 = remediation;
    target.pdp_field_quality_summary = {
      ...ensureObject(target.pdp_field_quality_summary),
      ingredients_raw: quality,
      ingredients_inci: quality,
    };
    target.external_seed_snapshot_contract = buildSnapshotContract(target.external_seed_snapshot_contract);
  };

  applyTarget(seedData);
  applyTarget(snapshot);
  seedData.snapshot = snapshot;
  return seedData;
}

function buildServingPayloadPatch(seedData) {
  const snapshot = ensureObject(seedData.snapshot);
  return {
    product_family: seedData.product_family || snapshot.product_family,
    product_type: seedData.product_type || snapshot.product_type,
    ingredient_intel: seedData.ingredient_intel || snapshot.ingredient_intel,
    ingredient_remediation_v1: seedData.ingredient_remediation_v1 || snapshot.ingredient_remediation_v1,
    pdp_field_quality_summary: seedData.pdp_field_quality_summary || snapshot.pdp_field_quality_summary,
    external_seed_snapshot_contract: seedData.external_seed_snapshot_contract || snapshot.external_seed_snapshot_contract,
  };
}

async function fetchRows(ids, market) {
  const res = await query(
    `
      SELECT id, external_product_id, market, domain, title, canonical_url, destination_url,
             COALESCE(seed_data, '{}'::jsonb) AS seed_data
      FROM external_product_seeds
      WHERE status = 'active'
        AND external_product_id = ANY($1::text[])
        AND ($2::text = '' OR upper(market) = upper($2))
      ORDER BY array_position($1::text[], external_product_id::text)
    `,
    [ids, normalizeText(market).toUpperCase()],
  );
  return res.rows || [];
}

async function syncServingMirrors(externalProductId, seedData) {
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

async function main() {
  const ids = [
    ...parseDelimited(argValue('external-product-ids') || argValue('externalProductIds')),
    ...readIdsFile(argValue('external-product-ids-file') || argValue('externalProductIdsFile')),
  ];
  if (!ids.length) throw new Error('missing_external_product_ids');
  const market = normalizeText(argValue('market') || 'US').toUpperCase();
  const dryRun = hasFlag('dry-run') || hasFlag('dryRun') || !hasFlag('apply');
  const outPath = normalizeText(argValue('out'));
  const rows = await fetchRows(ids, market);
  const rowsById = new Map(rows.map((row) => [row.external_product_id, row]));
  const results = [];
  for (const externalProductId of ids) {
    const row = rowsById.get(externalProductId);
    if (!row) {
      results.push({ external_product_id: externalProductId, status: 'missing_seed' });
      continue;
    }
    const seedData = patchSeedData(row, {
      reason: argValue('reason') || 'product_family_accessory',
      sourceUrl: argValue('source-url') || row.canonical_url || row.destination_url,
      productFamily: argValue('product-family') || 'accessory',
      productType: argValue('product-type') || '',
      reviewedBy: argValue('reviewed-by') || 'codex',
    });
    const changed = JSON.stringify(row.seed_data || {}) !== JSON.stringify(seedData);
    const result = {
      external_product_id: externalProductId,
      title: row.title,
      status: dryRun ? (changed ? 'dry_run' : 'unchanged') : (changed ? 'updated' : 'unchanged'),
      reason: argValue('reason') || 'product_family_accessory',
      product_family: argValue('product-family') || 'accessory',
    };
    if (!dryRun && changed) {
      await query(
        `
          UPDATE external_product_seeds
          SET seed_data = $2::jsonb,
              updated_at = NOW()
          WHERE external_product_id = $1
        `,
        [externalProductId, stringifyPostgresJsonb(seedData)],
      );
      result.serving_mirror_sync = await syncServingMirrors(externalProductId, seedData);
    }
    results.push(result);
  }
  const report = {
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    summary: {
      scanned: rows.length,
      dry_run: results.filter((item) => item.status === 'dry_run').length,
      updated: results.filter((item) => item.status === 'updated').length,
      unchanged: results.filter((item) => item.status === 'unchanged').length,
      missing: results.filter((item) => item.status === 'missing_seed').length,
    },
    results,
  };
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report.summary, null, 2));
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error?.stack || error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
    });
}
