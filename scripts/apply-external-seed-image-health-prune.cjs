#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { closePool, query, withClient } = require('../src/db');
const { collectSeedImageUrls } = require('./audit-external-seed-image-health');

const PATCH_VERSION = 'external_seed.image_health_prune.v1';
const DROP = Symbol('drop');

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function stableJson(value) {
  return JSON.stringify(value);
}

function uniq(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = asString(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function collectBadUrlMap(report, options = {}) {
  const includeLowResolution = options.includeLowResolution === true;
  const byProduct = new Map();
  for (const row of asArray(report.results)) {
    const id = asString(row.external_product_id);
    if (!id) continue;
    const urls = [
      ...asArray(row.broken_urls).map((item) => item?.url),
      ...(includeLowResolution ? asArray(row.low_resolution_urls).map((item) => item?.url) : []),
    ];
    const bad = uniq(urls);
    if (bad.length) byProduct.set(id, bad);
  }
  return byProduct;
}

function collectBadUrlSetFromCheckpoint(checkpointPath, options = {}) {
  const filePath = asString(checkpointPath);
  if (!filePath) return null;
  const checkpoint = readJson(filePath);
  const checked = asObject(checkpoint.checked_urls);
  const includeLowResolution = options.includeLowResolution === true;
  const bad = new Set();
  for (const [url, result] of Object.entries(checked)) {
    if (!result || typeof result !== 'object') continue;
    if (result.ok === false || (includeLowResolution && result.low_resolution === true)) bad.add(url);
  }
  return bad;
}

function isBadUrl(value, badSet) {
  const text = asString(value);
  return text && badSet.has(text);
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isEmptyObject(value) {
  return isPlainObject(value) && Object.keys(value).length === 0;
}

const IMAGE_VALUE_KEYS = new Set([
  'url',
  'src',
  'image',
  'image_url',
  'thumbnail_url',
  'primary_image_url',
  'swatch_image_url',
  'label_image_url',
]);

const IMAGE_ARRAY_KEYS = new Set([
  'images',
  'image_urls',
  'media',
  'gallery',
  'content_image_urls',
  'line_preview_images',
]);

function pruneValue(value, badSet, contextKey = '') {
  if (typeof value === 'string') {
    return isBadUrl(value, badSet) ? DROP : value;
  }
  if (Array.isArray(value)) {
    const next = [];
    for (const item of value) {
      const pruned = pruneValue(item, badSet, contextKey);
      if (pruned === DROP || pruned == null) continue;
      if (isEmptyObject(pruned)) continue;
      next.push(pruned);
    }
    return next;
  }
  if (!isPlainObject(value)) return value;

  const next = {};
  let removedImageProp = false;
  let hadImageUrlProp = false;
  for (const [key, raw] of Object.entries(value)) {
    const imageKey = IMAGE_VALUE_KEYS.has(key);
    if (imageKey) hadImageUrlProp = true;
    const pruned = pruneValue(raw, badSet, key);
    if (pruned === DROP) {
      if (imageKey || IMAGE_ARRAY_KEYS.has(key) || contextKey === 'media') removedImageProp = true;
      continue;
    }
    if (Array.isArray(pruned) && pruned.length === 0 && IMAGE_ARRAY_KEYS.has(key)) {
      removedImageProp = true;
      continue;
    }
    if (isEmptyObject(pruned)) continue;
    next[key] = pruned;
  }

  if (contextKey === 'media' && hadImageUrlProp && removedImageProp && !hasAnyImageUrl(next)) return DROP;
  return next;
}

function hasAnyImageUrl(value) {
  if (typeof value === 'string') return /^https?:\/\//i.test(value);
  if (Array.isArray(value)) return value.some(hasAnyImageUrl);
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, item]) => {
    if (IMAGE_VALUE_KEYS.has(key) || IMAGE_ARRAY_KEYS.has(key)) return hasAnyImageUrl(item);
    return false;
  });
}

function collectGoodImageUrls(value, out = []) {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectGoodImageUrls(item, out));
    return out;
  }
  if (!isPlainObject(value)) return out;
  for (const key of [...IMAGE_VALUE_KEYS, ...IMAGE_ARRAY_KEYS]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) collectGoodImageUrls(value[key], out);
  }
  return out;
}

function repairPrimaryImages(seedData) {
  const snapshot = asObject(seedData.snapshot);
  const rootGood = uniq(collectGoodImageUrls([
    seedData.image_urls,
    seedData.images,
    seedData.media,
    seedData.variants,
    seedData.line_preview_images,
  ]));
  if (!asString(seedData.image_url) && rootGood.length) seedData.image_url = rootGood[0];
  if (!asArray(seedData.image_urls).length && rootGood.length) seedData.image_urls = rootGood;
  if (!asArray(seedData.images).length && rootGood.length) seedData.images = rootGood;

  const snapshotGood = uniq(collectGoodImageUrls([
    snapshot.image_urls,
    snapshot.images,
    snapshot.media,
    snapshot.variants,
    snapshot.line_preview_images,
  ]));
  if (!asString(snapshot.image_url) && snapshotGood.length) snapshot.image_url = snapshotGood[0];
  if (!asArray(snapshot.image_urls).length && snapshotGood.length) snapshot.image_urls = snapshotGood;
  if (!asArray(snapshot.images).length && snapshotGood.length) snapshot.images = snapshotGood;
  seedData.snapshot = snapshot;
}

function buildSeedPatch(row, badUrls, options = {}) {
  if (!badUrls.length) {
    const count = uniq(collectSeedImageUrls({ seed_data: row.seed_data })).length;
    return {
      changed: false,
      reason: 'no_bad_urls_present_in_seed_data',
      before_image_count: count,
      after_image_count: count,
    };
  }
  const badSet = new Set(badUrls);
  const before = asObject(row.seed_data);
  const next = pruneValue(before, badSet);
  if (next === DROP || !isPlainObject(next)) {
    return { changed: false, reason: 'seed_data_pruned_empty' };
  }
  repairPrimaryImages(next);
  const marker = {
    contract_version: PATCH_VERSION,
    generated_at: options.generatedAt,
    source_report: options.reportLabel || null,
    reviewer: 'codex_manual_review',
    removed_url_count: badUrls.length,
    reason_codes: ['broken_image_url'],
  };
  next.image_health_prune_v1 = marker;
  next.snapshot = {
    ...asObject(next.snapshot),
    image_health_prune_v1: marker,
  };
  const changed = stableJson(before) !== stableJson(next);
  const beforeImageCount = uniq(collectSeedImageUrls({ seed_data: before })).length;
  const afterImageCount = uniq(collectSeedImageUrls({ seed_data: next })).length;
  if (changed && afterImageCount === 0 && beforeImageCount > 0) {
    return {
      changed: false,
      reason: 'blocked_prune_would_remove_all_images',
      before_image_count: beforeImageCount,
      after_image_count: afterImageCount,
    };
  }
  return {
    changed,
    reason: changed ? 'pruned_broken_image_urls' : 'no_bad_urls_present_in_seed_data',
    before_image_count: beforeImageCount,
    after_image_count: afterImageCount,
    next_seed_data: next,
    marker,
  };
}

function buildServingPatch(seedData) {
  const snapshot = asObject(seedData.snapshot);
  const patch = {};
  for (const key of [
    'image_url',
    'image_urls',
    'images',
    'media',
    'content_image_urls',
    'line_preview_images',
    'variants',
    'image_health_prune_v1',
  ]) {
    if (seedData[key] !== undefined) patch[key] = seedData[key];
    else if (snapshot[key] !== undefined) patch[key] = snapshot[key];
  }
  return patch;
}

async function fetchRows(externalProductIds) {
  if (!externalProductIds.length) return [];
  const result = await query(
    `
      SELECT id, external_product_id, seed_data
      FROM external_product_seeds
      WHERE external_product_id = ANY($1)
    `,
    [externalProductIds],
  );
  return result.rows || [];
}

async function applyPlan(plan) {
  const payloadPatch = buildServingPatch(plan.next_seed_data);
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(
        `
          UPDATE external_product_seeds
          SET seed_data = $2::jsonb,
              updated_at = NOW()
          WHERE id = $1
        `,
        [plan.seed_id, JSON.stringify(plan.next_seed_data)],
      );
      await client.query(
        `
          UPDATE catalog_products
          SET product_payload = COALESCE(product_payload, '{}'::jsonb) || $2::jsonb,
              image_url = CASE WHEN $3 <> '' THEN $3 ELSE image_url END,
              updated_at = NOW()
          WHERE merchant_id = 'external_seed'
            AND platform = 'external_seed'
            AND source_product_id = $1
        `,
        [plan.external_product_id, JSON.stringify(payloadPatch), asString(payloadPatch.image_url)],
      );
      await client.query(
        `
          UPDATE pdp_identity_listing
          SET source_payload = COALESCE(source_payload, '{}'::jsonb) || $2::jsonb,
              updated_at = NOW()
          WHERE source_listing_ref = $1
        `,
        [`external_seed:${plan.external_product_id}`, JSON.stringify(payloadPatch)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

async function main() {
  const reportPath = argValue('report');
  if (!reportPath) throw new Error('Provide --report');
  const apply = hasFlag('apply');
  const outPath = argValue('out', path.join('reports', 'external-seed-image-health-prune.json'));
  const includeLowResolution = hasFlag('include-low-resolution');
  const report = readJson(reportPath);
  const checkpointBadSet = collectBadUrlSetFromCheckpoint(argValue('checkpoint'), { includeLowResolution });
  const badByProduct = collectBadUrlMap(report, { includeLowResolution });
  const rows = await fetchRows(Array.from(badByProduct.keys()));
  const generatedAt = new Date().toISOString();
  const plans = rows.map((row) => {
    const badUrls = checkpointBadSet
      ? uniq(collectSeedImageUrls(row).filter((url) => checkpointBadSet.has(url)))
      : badByProduct.get(row.external_product_id) || [];
    const patch = buildSeedPatch(row, badUrls, {
      generatedAt,
      reportLabel: path.basename(reportPath),
    });
    return {
      seed_id: String(row.id),
      external_product_id: row.external_product_id,
      bad_url_count: badUrls.length,
      changed: patch.changed,
      reason: patch.reason,
      before_image_count: patch.before_image_count || 0,
      after_image_count: patch.after_image_count || 0,
      next_seed_data: patch.next_seed_data,
    };
  });
  const changedPlans = plans.filter((plan) => plan.changed);
  if (apply) {
    for (let idx = 0; idx < changedPlans.length; idx += 1) {
      await applyPlan(changedPlans[idx]);
      if ((idx + 1) % 50 === 0 || idx + 1 === changedPlans.length) {
        process.stderr.write(`[image-health-prune] applied ${idx + 1}/${changedPlans.length}\n`);
      }
    }
  }
  const output = {
    generated_at: generatedAt,
    source: PATCH_VERSION,
    mode: apply ? 'apply' : 'dry_run',
    input_report: reportPath,
      input_checkpoint: argValue('checkpoint') || null,
    summary: {
      products_with_bad_urls: badByProduct.size,
      rows_found: rows.length,
      changed_products: changedPlans.length,
      total_bad_urls: plans.reduce((sum, plan) => sum + plan.bad_url_count, 0),
    },
    plans: plans.map(({ next_seed_data: _nextSeedData, ...plan }) => plan),
  };
  writeJson(outPath, output);
  process.stdout.write(`${JSON.stringify({ status: 'ok', out: outPath, summary: output.summary }, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => closePool().catch(() => {}));
}

module.exports = {
  buildSeedPatch,
  collectBadUrlMap,
  pruneValue,
};
