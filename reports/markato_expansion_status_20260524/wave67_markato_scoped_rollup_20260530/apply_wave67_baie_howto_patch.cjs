#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../../../src/db');

const EXTERNAL_PRODUCT_ID = 'ext_60ded78effb04e9d6389bfce';
const MARKET = 'US';
const CONTRACT_VERSION = 'external_seed.reviewed_official_how_to_patch.v1';
const SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';
const PDP_CONTENT_ASSET_VERSION = 'pivota.pdp_content_asset.v1';
const SOURCE_URL = 'https://usa.baiebotanique.com/products/rose-cupuacu-enzyme-cleanser-120ml';
const SOURCE_URL_UK = 'https://www.baiebotanique.com/products/rose-cupuacu-enzyme-cleanser';
const HOW_TO_USE =
  'Massage over face and neck, add a little water and massage further, wash off with a warm damp cloth. Can also be used on cotton wool pads to cleanse skin and remove make up.';

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return '';
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) return '';
  return String(value).trim();
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

function hashContent(value) {
  return crypto.createHash('sha256').update(normalizeText(value)).digest('hex');
}

function stringifyJsonb(value) {
  return JSON.stringify(value || {}).replace(/\\+u0000/gi, '').replace(/\u0000/g, '');
}

function buildSnapshotContract(existing) {
  return {
    ...ensureObject(existing),
    contract_version: SNAPSHOT_CONTRACT_VERSION,
    source: 'catalog_intelligence',
    authoritative: true,
    structured_fields_authoritative: true,
    legacy_fields_quarantined: true,
    replace_strategy: 'replace_not_merge',
    updated_at: new Date().toISOString(),
  };
}

function mergeQualitySummary(existing) {
  const now = new Date().toISOString();
  return {
    ...ensureObject(existing),
    how_to_use_raw: {
      source_origin: 'official_html',
      source_quality_status: 'high',
      source_kinds: ['official_pdp_how_to_use'],
      source_url: SOURCE_URL,
      corroborating_source_url: SOURCE_URL_UK,
      reason_codes: ['reviewed_product_specific_how_to_visible_on_official_baie_pdp'],
      updated_at: now,
    },
  };
}

function mergeContentAsset(existing) {
  const now = new Date().toISOString();
  return {
    contract_version: PDP_CONTENT_ASSET_VERSION,
    owner: 'pivota',
    fields: {
      ...ensureObject(ensureObject(existing).fields),
      how_to_use_raw: {
        review_state: 'assistant_reviewed',
        overwrite_policy: 'preserve_best_available',
        source_quality_status: 'high',
        source_origin: 'official_html',
        source_kind: 'official_pdp_how_to_use',
        source_url: SOURCE_URL,
        corroborating_source_url: SOURCE_URL_UK,
        content_hash: hashContent(HOW_TO_USE),
        updated_at: now,
      },
    },
  };
}

function hasSourceBackedHowTo(seedData) {
  const snapshot = ensureObject(seedData.snapshot);
  const value = normalizeText(seedData.pdp_how_to_use_raw || snapshot.pdp_how_to_use_raw);
  return value.length >= 40 && /\b(?:massage|rinse|wash off|cleanse|apply|use)\b/i.test(value);
}

function buildPatch(row) {
  const seedData = JSON.parse(JSON.stringify(ensureObject(row.seed_data)));
  const snapshot = ensureObject(seedData.snapshot);
  const beforeHowTo = normalizeText(seedData.pdp_how_to_use_raw || snapshot.pdp_how_to_use_raw);
  if (hasSourceBackedHowTo(seedData)) {
    return {
      status: 'blocked',
      reason: 'source_backed_how_to_already_present',
      before_how_to_len: beforeHowTo.length,
    };
  }

  const now = new Date().toISOString();
  seedData.pdp_how_to_use_raw = HOW_TO_USE;
  snapshot.pdp_how_to_use_raw = HOW_TO_USE;
  seedData.pdp_field_quality_summary = mergeQualitySummary(seedData.pdp_field_quality_summary || snapshot.pdp_field_quality_summary);
  snapshot.pdp_field_quality_summary = seedData.pdp_field_quality_summary;
  seedData.pdp_content_asset_v1 = mergeContentAsset(seedData.pdp_content_asset_v1 || snapshot.pdp_content_asset_v1);
  snapshot.pdp_content_asset_v1 = seedData.pdp_content_asset_v1;
  seedData.external_seed_snapshot_contract = buildSnapshotContract(seedData.external_seed_snapshot_contract);
  snapshot.external_seed_snapshot_contract = buildSnapshotContract(snapshot.external_seed_snapshot_contract);
  seedData.reviewed_official_how_to_patch_v1 = {
    contract_version: CONTRACT_VERSION,
    reviewed_at: now,
    reviewer: 'codex_wave67_human_review',
    external_product_id: EXTERNAL_PRODUCT_ID,
    source_origin: 'official_html',
    source_url: SOURCE_URL,
    corroborating_source_url: SOURCE_URL_UK,
    patched_fields: ['pdp_how_to_use_raw'],
    evidence: {
      official_page_section: 'How to use',
      official_page_product: 'Rose + Cupuacu Enzyme Cleanser',
      official_page_also_exposes_full_ingredients: true,
    },
    reason_codes: ['official_product_specific_usage_directions_found_after_wave57_hold'],
  };
  snapshot.reviewed_official_how_to_patch_v1 = seedData.reviewed_official_how_to_patch_v1;
  seedData.snapshot = snapshot;

  return {
    status: 'planned',
    patch_keys: ['pdp_how_to_use_raw'],
    before_how_to_len: beforeHowTo.length,
    after_how_to_len: HOW_TO_USE.length,
    next_seed_data: seedData,
  };
}

function buildServingPayloadPatch(seedData) {
  return {
    pdp_how_to_use_raw: seedData.pdp_how_to_use_raw,
    pdp_field_quality_summary: seedData.pdp_field_quality_summary,
    pdp_content_asset_v1: seedData.pdp_content_asset_v1,
    external_seed_snapshot_contract: seedData.external_seed_snapshot_contract,
    reviewed_official_how_to_patch_v1: seedData.reviewed_official_how_to_patch_v1,
  };
}

async function fetchTargetRow() {
  const result = await query(
    `
      SELECT
        eps.id,
        eps.external_product_id,
        eps.title,
        eps.domain,
        eps.market,
        eps.status,
        eps.canonical_url,
        eps.destination_url,
        eps.seed_data,
        cp.product_key,
        cp.content_key,
        ips.serving_eligible,
        pil.identity_status,
        pil.live_read_enabled,
        pil.review_required,
        pil.sellable_item_group_id,
        kb.kb_key
      FROM external_product_seeds eps
      LEFT JOIN catalog_products cp
        ON cp.merchant_id = 'external_seed'
       AND cp.platform = 'external_seed'
       AND cp.source_system = 'external_product_seeds_mirror_v1'
       AND cp.source_product_id = eps.external_product_id
      LEFT JOIN index_pipeline_state ips
        ON ips.content_key = cp.content_key
      LEFT JOIN pdp_identity_listing pil
        ON pil.merchant_id = 'external_seed'
       AND pil.product_id = eps.external_product_id
      LEFT JOIN aurora_product_intel_kb kb
        ON kb.kb_key = ('product:' || eps.external_product_id)
      WHERE eps.external_product_id = $1
        AND eps.market = $2
      ORDER BY cp.updated_at DESC NULLS LAST, cp.product_key DESC NULLS LAST
      LIMIT 1
    `,
    [EXTERNAL_PRODUCT_ID, MARKET],
  );
  return result.rows[0] || null;
}

async function applyPatch(nextSeedData) {
  const seedJson = stringifyJsonb(nextSeedData);
  const payloadJson = stringifyJsonb(buildServingPayloadPatch(nextSeedData));
  const seedResult = await query(
    `
      UPDATE external_product_seeds
      SET seed_data = $2::jsonb,
          updated_at = NOW()
      WHERE external_product_id = $1
        AND market = $3
    `,
    [EXTERNAL_PRODUCT_ID, seedJson, MARKET],
  );
  const catalogResult = await query(
    `
      UPDATE catalog_products
      SET product_payload = COALESCE(product_payload, '{}'::jsonb) || $2::jsonb,
          updated_at = NOW()
      WHERE merchant_id = 'external_seed'
        AND platform = 'external_seed'
        AND source_product_id = $1
    `,
    [EXTERNAL_PRODUCT_ID, payloadJson],
  );
  const identityResult = await query(
    `
      UPDATE pdp_identity_listing
      SET source_payload = COALESCE(source_payload, '{}'::jsonb) || $2::jsonb,
          updated_at = NOW()
      WHERE source_listing_ref = $1
    `,
    [`external_seed:${EXTERNAL_PRODUCT_ID}`, payloadJson],
  );
  return {
    external_product_seeds: Number(seedResult.rowCount || 0),
    catalog_products: Number(catalogResult.rowCount || 0),
    pdp_identity_listing: Number(identityResult.rowCount || 0),
  };
}

async function postcheck() {
  const result = await query(
    `
      SELECT
        eps.external_product_id,
        length(coalesce(eps.seed_data->>'pdp_how_to_use_raw', eps.seed_data->'snapshot'->>'pdp_how_to_use_raw', '')) AS seed_how_to_len,
        eps.seed_data->'pdp_field_quality_summary'->'how_to_use_raw'->>'source_quality_status' AS seed_how_to_quality,
        length(coalesce(cp.product_payload->>'pdp_how_to_use_raw', '')) AS catalog_payload_how_to_len,
        length(coalesce(pil.source_payload->>'pdp_how_to_use_raw', '')) AS identity_payload_how_to_len
      FROM external_product_seeds eps
      LEFT JOIN catalog_products cp
        ON cp.merchant_id = 'external_seed'
       AND cp.platform = 'external_seed'
       AND cp.source_product_id = eps.external_product_id
      LEFT JOIN pdp_identity_listing pil
        ON pil.source_listing_ref = ('external_seed:' || eps.external_product_id)
      WHERE eps.external_product_id = $1
        AND eps.market = $2
      ORDER BY cp.updated_at DESC NULLS LAST
      LIMIT 1
    `,
    [EXTERNAL_PRODUCT_ID, MARKET],
  );
  return result.rows[0] || null;
}

async function main() {
  const dryRun = hasFlag('dry-run') || hasFlag('dryRun');
  const outDir = normalizeText(argValue('out-dir') || argValue('outDir')) || __dirname;
  fs.mkdirSync(outDir, { recursive: true });

  const row = await fetchTargetRow();
  if (!row) throw new Error(`target row not found: ${EXTERNAL_PRODUCT_ID}`);
  const plan = buildPatch(row);
  const report = {
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    target: {
      external_product_id: row.external_product_id,
      title: row.title,
      domain: row.domain,
      market: row.market,
      status: row.status,
      canonical_url: row.canonical_url,
      destination_url: row.destination_url,
      catalog_attached: Boolean(row.product_key),
      content_key: row.content_key,
      db_serving_eligible: row.serving_eligible === true,
      identity_ready: Boolean(
        row.identity_status === 'approved' &&
          row.live_read_enabled === true &&
          row.review_required !== true &&
          normalizeText(row.sellable_item_group_id),
      ),
      product_intel_exists: Boolean(row.kb_key),
    },
    source_review: {
      source_url: SOURCE_URL,
      corroborating_source_url: SOURCE_URL_UK,
      how_to_use: HOW_TO_USE,
      decision: 'source_backed_how_to_patch_allowed',
    },
    plan: {
      status: plan.status,
      reason: plan.reason || '',
      patch_keys: plan.patch_keys || [],
      before_how_to_len: plan.before_how_to_len || 0,
      after_how_to_len: plan.after_how_to_len || 0,
    },
  };

  if (plan.status === 'planned' && !dryRun) {
    report.apply_result = await applyPatch(plan.next_seed_data);
    report.postcheck = await postcheck();
  } else if (plan.status === 'planned') {
    report.apply_result = { planned: true };
  }

  const outFile = path.join(outDir, dryRun ? 'dry-run.json' : 'apply.json');
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    dry_run: report.dry_run,
    status: report.plan.status,
    patch_keys: report.plan.patch_keys,
    before_how_to_len: report.plan.before_how_to_len,
    after_how_to_len: report.plan.after_how_to_len,
    apply_result: report.apply_result || null,
    postcheck: report.postcheck || null,
    out_file: outFile,
  }, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
