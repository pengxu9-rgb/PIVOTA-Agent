#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, withClient } = require('../../../src/db');
const { ensureJsonObject } = require('../../../src/services/externalSeedProducts');

const TARGETS = Object.freeze([
  {
    external_product_id: 'ext_1e27467ab07ddb83ad74c213',
    title: 'PROPOWAX Antioxidant Shampoo 300ml',
    category: 'Shampoo',
    product_type: 'Shampoo',
    category_path: 'beauty/haircare/shampoo',
    catalog_category_path: 'beauty/haircare/shampoo',
    recall_vertical: 'haircare',
    source_url: 'https://www.apiceuticals.com/shop/propowax-antioxidant-shampoo/',
  },
  {
    external_product_id: 'ext_4e95b920b4c6a5295d55aa46',
    title: 'PROPOWAX Antioxidant Conditioner 300ml',
    category: 'Conditioner',
    product_type: 'Conditioner',
    category_path: 'beauty/haircare/conditioner',
    catalog_category_path: 'beauty/haircare/conditioner',
    recall_vertical: 'haircare',
    source_url: 'https://www.apiceuticals.com/shop/propowax-antioxidant-conditioner/',
  },
  {
    external_product_id: 'ext_d17dfc05f98d0400d5129f1c',
    title: 'PROPOWAX Antioxidant Shower Gel 300ml',
    category: 'Body Wash',
    product_type: 'Body Wash',
    category_path: 'beauty/bodycare/body-wash',
    catalog_category_path: 'beauty/bodycare/body-wash',
    recall_vertical: 'bodycare',
    source_url: 'https://www.apiceuticals.com/shop/propowax-antioxidant-shower-gel/',
  },
  {
    external_product_id: 'ext_c0e5209513c083e2c649c1a1',
    title: 'PROPOWAX Antioxidant Body Lotion 300ml',
    category: 'Body Lotion',
    product_type: 'Body Lotion',
    category_path: 'beauty/bodycare/body-lotion',
    catalog_category_path: 'beauty/bodycare/body-lotion',
    recall_vertical: 'bodycare',
    source_url: 'https://www.apiceuticals.com/shop/propowax-antioxidant-body-lotion/',
  },
  {
    external_product_id: 'ext_d3d708f481903ba2a6f9b732',
    title: 'PROPOWAX Antioxidant Dry Oil 100ml',
    category: 'Body Oil',
    product_type: 'Body Oil',
    category_path: 'beauty/bodycare/body-oil',
    catalog_category_path: 'beauty/bodycare/body-oil',
    recall_vertical: 'bodycare',
    source_url: 'https://www.apiceuticals.com/shop/propowax-antioxidant-dry-oil/',
  },
]);

const CONTRACT_VERSION = 'wave12_apiceuticals_category_path_repair_v1';

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJson(filePath, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const target = normalizeNonEmptyString(filePath);
  if (!target) {
    process.stdout.write(body);
    return;
  }
  ensureParentDir(target);
  fs.writeFileSync(target, body, 'utf8');
  process.stdout.write(body);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value && typeof value === 'object' ? value : {}));
}

function comparableJson(value) {
  if (Array.isArray(value)) return value.map((item) => comparableJson(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = comparableJson(value[key]);
    return out;
  }
  return value;
}

function jsonChanged(left, right) {
  return JSON.stringify(comparableJson(left || {})) !== JSON.stringify(comparableJson(right || {}));
}

function buildPatch(target, now) {
  return {
    category: target.category,
    product_type: target.product_type,
    category_path: target.category_path,
    catalog_category_path: target.catalog_category_path,
    category_path_parts: target.category_path.split('/').filter(Boolean),
    reviewed_category_path_repair_v1: {
      contract_version: CONTRACT_VERSION,
      source: 'official_pdp_title_url_review',
      source_url: target.source_url,
      reviewed_by: 'codex_review',
      reviewed_at: now,
      reason: 'wave12_similar_recall_leaf_category_repair',
      evidence: `${target.title} is an official Apiceuticals PDP with reviewed product kind ${target.category}.`,
    },
  };
}

function patchSeedData(seedData, target, patch, now) {
  const next = cloneJson(seedData);
  const snapshot = ensureJsonObject(next.snapshot);
  next.snapshot = snapshot;
  const derived = ensureJsonObject(next.derived);
  const recall = ensureJsonObject(derived.recall);
  next.derived = derived;
  derived.recall = recall;

  for (const container of [next, snapshot]) {
    container.category = target.category;
    container.product_type = target.product_type;
    container.category_path = target.category_path;
    container.catalog_category_path = target.catalog_category_path;
  }
  recall.category = target.category;
  recall.vertical = target.recall_vertical;
  recall.reviewed_override = {
    source: 'wave12_apiceuticals_official_pdp_review',
    reason: 'exact_target_product_kind_review',
    updated_at: now,
  };

  const quality = {
    ...ensureJsonObject(snapshot.pdp_field_quality_summary),
    ...ensureJsonObject(next.pdp_field_quality_summary),
  };
  const qualityMeta = {
    source_origin: 'official_pdp_title_url_review',
    source_quality_status: 'high',
    source_url: target.source_url,
    reviewed_by: 'codex_review',
    reason: 'wave12_similar_recall_leaf_category_repair',
    updated_at: now,
  };
  for (const field of ['category', 'product_type', 'category_path', 'catalog_category_path']) {
    quality[field] = qualityMeta;
  }
  next.pdp_field_quality_summary = quality;
  snapshot.pdp_field_quality_summary = quality;
  next.reviewed_category_path_repair_v1 = patch.reviewed_category_path_repair_v1;
  snapshot.reviewed_category_path_repair_v1 = patch.reviewed_category_path_repair_v1;

  return next;
}

async function fetchState(client) {
  const externalIds = TARGETS.map((target) => target.external_product_id);
  const seedRes = await client.query(
    `
      SELECT id, external_product_id, status, title, seed_data
      FROM external_product_seeds
      WHERE external_product_id = ANY($1::text[])
      ORDER BY array_position($1::text[], external_product_id)
    `,
    [externalIds],
  );
  const catalogRes = await client.query(
    `
      SELECT source_product_id AS external_product_id, product_key, category, product_type, category_path, product_payload
      FROM catalog_products
      WHERE merchant_id = 'external_seed'
        AND platform = 'external_seed'
        AND source_product_id = ANY($1::text[])
      ORDER BY array_position($1::text[], source_product_id)
    `,
    [externalIds],
  );
  const identityRes = await client.query(
    `
      SELECT replace(source_listing_ref, 'external_seed:', '') AS external_product_id, source_listing_ref, source_payload
      FROM pdp_identity_listing
      WHERE source_listing_ref = ANY($1::text[])
      ORDER BY array_position($1::text[], replace(source_listing_ref, 'external_seed:', ''))
    `,
    [externalIds.map((id) => `external_seed:${id}`)],
  );
  return {
    seedById: new Map((seedRes.rows || []).map((row) => [row.external_product_id, row])),
    catalogById: new Map((catalogRes.rows || []).map((row) => [row.external_product_id, row])),
    identityById: new Map((identityRes.rows || []).map((row) => [row.external_product_id, row])),
  };
}

function buildPlan(state, now) {
  return TARGETS.map((target) => {
    const seed = state.seedById.get(target.external_product_id);
    const catalog = state.catalogById.get(target.external_product_id);
    const identity = state.identityById.get(target.external_product_id);
    const blockers = [];
    if (!seed) blockers.push('seed_row_missing');
    if (seed && seed.status !== 'active') blockers.push(`seed_status_${seed.status || 'unknown'}`);
    if (!catalog) blockers.push('catalog_product_missing');
    if (!identity) blockers.push('identity_listing_missing');

    const patch = buildPatch(target, now);
    const previousSeedData = ensureJsonObject(seed?.seed_data);
    const nextSeedData = seed ? patchSeedData(previousSeedData, target, patch, now) : null;
    const catalogPayload = ensureJsonObject(catalog?.product_payload);
    const nextCatalogPayload = catalog ? { ...catalogPayload, ...patch } : null;
    const identityPayload = ensureJsonObject(identity?.source_payload);
    const nextIdentityPayload = identity ? { ...identityPayload, ...patch } : null;

    const before = {
      seed_category: previousSeedData.category || ensureJsonObject(previousSeedData.snapshot).category || null,
      seed_product_type: previousSeedData.product_type || ensureJsonObject(previousSeedData.snapshot).product_type || null,
      seed_category_path: previousSeedData.category_path || ensureJsonObject(previousSeedData.snapshot).category_path || null,
      seed_catalog_category_path:
        previousSeedData.catalog_category_path || ensureJsonObject(previousSeedData.snapshot).catalog_category_path || null,
      recall_category: ensureJsonObject(ensureJsonObject(previousSeedData.derived).recall).category || null,
      recall_vertical: ensureJsonObject(ensureJsonObject(previousSeedData.derived).recall).vertical || null,
      catalog_category: catalog?.category || null,
      catalog_product_type: catalog?.product_type || null,
      catalog_category_path: catalog?.category_path || null,
    };
    const after = {
      category: target.category,
      product_type: target.product_type,
      category_path: target.category_path,
      catalog_category_path: target.catalog_category_path,
      recall_category: target.category,
      recall_vertical: target.recall_vertical,
    };
    const changes = {
      seed_data: seed ? jsonChanged(previousSeedData, nextSeedData) : false,
      catalog_product:
        Boolean(catalog) &&
        (catalog.category !== target.category ||
          catalog.product_type !== target.product_type ||
          catalog.category_path !== target.catalog_category_path ||
          jsonChanged(catalogPayload, nextCatalogPayload)),
      identity_payload: identity ? jsonChanged(identityPayload, nextIdentityPayload) : false,
    };
    return {
      target,
      seed_id: seed?.id || null,
      product_key: catalog?.product_key || null,
      source_listing_ref: identity?.source_listing_ref || null,
      status: blockers.length ? 'blocked' : Object.values(changes).some(Boolean) ? 'planned' : 'unchanged',
      blockers,
      before,
      after,
      changes,
      nextSeedData,
      nextCatalogPayload,
      nextIdentityPayload,
    };
  });
}

async function applyPlan(client, plan) {
  const target = plan.target;
  await client.query(
    `
      UPDATE external_product_seeds
      SET seed_data = $2::jsonb,
          updated_at = NOW()
      WHERE external_product_id = $1
    `,
    [target.external_product_id, JSON.stringify(plan.nextSeedData)],
  );
  await client.query(
    `
      UPDATE catalog_products
      SET category = $2,
          product_type = $3,
          category_path = $4,
          product_payload = $5::jsonb,
          updated_at = NOW()
      WHERE merchant_id = 'external_seed'
        AND platform = 'external_seed'
        AND source_product_id = $1
    `,
    [
      target.external_product_id,
      target.category,
      target.product_type,
      target.catalog_category_path,
      JSON.stringify(plan.nextCatalogPayload),
    ],
  );
  await client.query(
    `
      UPDATE pdp_identity_listing
      SET source_payload = $2::jsonb,
          updated_at = NOW()
      WHERE source_listing_ref = $1
    `,
    [`external_seed:${target.external_product_id}`, JSON.stringify(plan.nextIdentityPayload)],
  );
}

async function main() {
  const dryRun = hasFlag('dry-run') || hasFlag('dryRun');
  const out = argValue('out');
  const now = new Date().toISOString();
  const output = await withClient(async (client) => {
    const state = await fetchState(client);
    const plans = buildPlan(state, now);
    if (!dryRun) {
      await client.query('BEGIN');
      try {
        for (const plan of plans) {
          if (plan.status !== 'planned') continue;
          await applyPlan(client, plan);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }
    const summary = {
      dry_run: dryRun,
      scanned: plans.length,
      blocked: plans.filter((plan) => plan.status === 'blocked').length,
      planned: plans.filter((plan) => plan.status === 'planned').length,
      unchanged: plans.filter((plan) => plan.status === 'unchanged').length,
      updated: dryRun ? 0 : plans.filter((plan) => plan.status === 'planned').length,
      seed_data_change_count: plans.filter((plan) => plan.changes.seed_data).length,
      catalog_product_change_count: plans.filter((plan) => plan.changes.catalog_product).length,
      identity_payload_change_count: plans.filter((plan) => plan.changes.identity_payload).length,
      blockers: plans.flatMap((plan) => plan.blockers),
    };
    return {
      generated_at: now,
      ...summary,
      plans: plans.map(({ nextSeedData, nextCatalogPayload, nextIdentityPayload, ...plan }) => plan),
    };
  });
  writeJson(out, output);
  if (output.blocked > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
