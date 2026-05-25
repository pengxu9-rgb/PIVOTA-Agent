#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const CONFIRM_TOKEN = 'APPLY_REVIEWED_EXTERNAL_SEED_GALLERY_PATCH';
const CONTRACT_VERSION = 'external_seed.reviewed_gallery_patch.v1';

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readJson(filePath) {
  const normalized = text(filePath);
  if (!normalized) throw new Error('--manifest is required');
  return JSON.parse(fs.readFileSync(normalized, 'utf8'));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || null)).digest('hex');
}

function sanitizeJson(value) {
  return JSON.stringify(value).replace(/\u0000/g, '').replace(/\\+u0000/gi, '');
}

function imageUrls(value) {
  if (!value) return [];
  if (typeof value === 'string') return [text(value)].filter(Boolean);
  if (Array.isArray(value)) return value.flatMap(imageUrls);
  if (typeof value === 'object') return [value.url, value.src, value.image_url].map(text).filter(Boolean);
  return [];
}

function unique(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = text(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function compilePatterns(values) {
  return asArray(values).map((value) => new RegExp(String(value), 'i'));
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function filterUrls(urls, entry) {
  const allowHosts = new Set(asArray(entry.allow_hosts).map((item) => text(item).toLowerCase().replace(/^www\./, '')));
  const keepPatterns = compilePatterns(entry.keep_url_patterns);
  const dropPatterns = compilePatterns(entry.drop_url_patterns);
  const before = unique(urls);
  const kept = before.filter((url) => {
    const host = hostOf(url);
    if (allowHosts.size && !allowHosts.has(host)) return false;
    if (dropPatterns.length && matchesAny(url, dropPatterns)) return false;
    if (keepPatterns.length && !matchesAny(url, keepPatterns)) return false;
    return true;
  });
  return {
    before,
    kept: unique(kept),
    removed: before.filter((url) => !kept.includes(url)),
  };
}

function variantLabel(variant) {
  return text(variant.display_label || variant.label || variant.title || variant.name || variant.option_value);
}

function patchImageFields(target, kept) {
  target.image_url = kept[0] || '';
  target.image_urls = kept;
  target.images = kept;
}

function patchVariantImages(variant, entry, rootKept) {
  const label = variantLabel(variant);
  const exact = asObject(entry.variant_keep_url_patterns_by_label)[label];
  const strategy = text(entry.variant_strategy || 'preserve').toLowerCase();
  if (!exact && strategy !== 'filter_like_root') {
    return { changed: false, label, before: imageUrls([variant.image_url, variant.image_urls, variant.images]), kept: [], removed: [] };
  }
  const variantEntry = exact
    ? { ...entry, keep_url_patterns: exact }
    : { ...entry, keep_url_patterns: entry.keep_url_patterns, drop_url_patterns: entry.drop_url_patterns };
  const filtered = filterUrls(imageUrls([variant.image_url, variant.image_urls, variant.images]), variantEntry);
  const kept = filtered.kept.length ? filtered.kept : rootKept;
  const beforeHash = digest([variant.image_url, variant.image_urls, variant.images]);
  variant.image_url = kept[0] || '';
  variant.image_urls = kept;
  variant.images = kept;
  return {
    changed: beforeHash !== digest([variant.image_url, variant.image_urls, variant.images]),
    label,
    before: filtered.before,
    kept,
    removed: filtered.removed,
  };
}

function buildNextSeedData(row, entry, now) {
  const seedData = JSON.parse(JSON.stringify(asObject(row.seed_data)));
  const snapshot = asObject(seedData.snapshot);
  seedData.snapshot = snapshot;
  const beforeRoot = unique([
    ...imageUrls(seedData.image_url),
    ...imageUrls(seedData.image_urls),
    ...imageUrls(seedData.images),
    ...imageUrls(snapshot.image_url),
    ...imageUrls(snapshot.image_urls),
    ...imageUrls(snapshot.images),
  ]);
  const filtered = filterUrls(beforeRoot, entry);
  if (filtered.kept.length < Number(entry.min_kept_images || 1)) {
    return {
      status: 'blocked',
      blockers: ['kept_images_below_minimum'],
      changed: false,
      seedData,
      before_root: beforeRoot,
      after_root: filtered.kept,
      removed_root: filtered.removed,
      variant_changes: [],
    };
  }

  patchImageFields(seedData, filtered.kept);
  patchImageFields(snapshot, filtered.kept);

  const variantChanges = [];
  for (const target of [seedData, snapshot]) {
    for (const variant of asArray(target.variants)) {
      variantChanges.push(patchVariantImages(variant, entry, filtered.kept));
    }
  }

  const quarantine = asObject(snapshot.snapshot_quarantine);
  snapshot.snapshot_quarantine = {
    ...quarantine,
    image_assets: {
      ...asObject(quarantine.image_assets),
      reviewed_gallery_patch_removed_urls: unique([
        ...asArray(asObject(quarantine.image_assets).reviewed_gallery_patch_removed_urls),
        ...filtered.removed,
        ...variantChanges.flatMap((item) => item.removed),
      ]),
    },
  };
  seedData.snapshot_quarantine = snapshot.snapshot_quarantine;

  const contract = {
    contract_version: CONTRACT_VERSION,
    source: 'reviewed_source_gallery_patch',
    reviewed_by: text(entry.reviewed_by),
    reviewed_at: now,
    source_url: text(entry.source_url || row.canonical_url || row.destination_url),
    reason: text(entry.reason),
    old_value_hash: digest(beforeRoot),
    new_value_hash: digest(filtered.kept),
  };
  seedData.reviewed_gallery_patch_v1 = contract;
  snapshot.reviewed_gallery_patch_v1 = contract;

  return {
    status: 'ready',
    blockers: [],
    changed: sanitizeJson(seedData) !== sanitizeJson(row.seed_data || {}),
    seedData,
    before_root: beforeRoot,
    after_root: filtered.kept,
    removed_root: filtered.removed,
    variant_changes: variantChanges.filter((item) => item.changed),
  };
}

function readManifestEntries(raw) {
  const root = Array.isArray(raw) ? { entries: raw } : asObject(raw);
  const entries = asArray(root.entries || root.rows);
  if (!entries.length) throw new Error('Manifest must contain entries[]');
  return entries.map((entry) => ({
    ...asObject(entry),
    external_product_id: text(entry.external_product_id),
    market: text(entry.market || root.market || 'US').toUpperCase(),
    reviewed_by: text(entry.reviewed_by || root.reviewed_by || 'codex_manual_gallery_review'),
    reason: text(entry.reason || root.reason || 'reviewed_gallery_trim_product_specific_images'),
    source_url: text(entry.source_url || entry.canonical_url || root.source_url || root.canonical_url),
    allow_hosts: asArray(entry.allow_hosts || root.allow_hosts),
    keep_url_patterns: asArray(entry.keep_url_patterns),
    drop_url_patterns: asArray(entry.drop_url_patterns || root.drop_url_patterns),
    variant_keep_url_patterns_by_label: asObject(entry.variant_keep_url_patterns_by_label),
    min_kept_images: Number(entry.min_kept_images || root.min_kept_images || 1),
    variant_strategy: text(entry.variant_strategy || root.variant_strategy || 'preserve'),
  }));
}

async function fetchRows(client, entries) {
  const ids = entries.map((entry) => entry.external_product_id);
  const res = await client.query(
    `
      SELECT id, external_product_id, market, status, title, canonical_url, destination_url,
             coalesce(seed_data, '{}'::jsonb) AS seed_data
      FROM external_product_seeds
      WHERE external_product_id = ANY($1::text[])
    `,
    [ids],
  );
  return new Map((res.rows || []).map((row) => [row.external_product_id, row]));
}

function buildServingPatch(seedData) {
  return {
    image_url: seedData.image_url || '',
    image_urls: asArray(seedData.image_urls),
    images: asArray(seedData.images),
    reviewed_gallery_patch_v1: seedData.reviewed_gallery_patch_v1,
  };
}

async function applyPlan(client, plan) {
  await client.query('BEGIN');
  try {
    await client.query(
      `
        UPDATE external_product_seeds
        SET seed_data = $2::jsonb,
            updated_at = NOW()
        WHERE external_product_id = $1
      `,
      [plan.external_product_id, sanitizeJson(plan.next_seed_data)],
    );
    const servingPatch = buildServingPatch(plan.next_seed_data);
    const catalog = await client.query(
      `
        UPDATE catalog_products
        SET image_url = COALESCE(NULLIF($2, ''), image_url),
            product_payload = COALESCE(product_payload, '{}'::jsonb) || $3::jsonb,
            updated_at = NOW()
        WHERE merchant_id = 'external_seed'
          AND platform = 'external_seed'
          AND source_product_id = $1
      `,
      [plan.external_product_id, plan.next_seed_data.image_url || '', sanitizeJson(servingPatch)],
    );
    const identity = await client.query(
      `
        UPDATE pdp_identity_listing
        SET source_payload = COALESCE(source_payload, '{}'::jsonb) || $2::jsonb,
            updated_at = NOW()
        WHERE source_listing_ref = $1
      `,
      [`external_seed:${plan.external_product_id}`, sanitizeJson(servingPatch)],
    );
    await client.query('COMMIT');
    return {
      external_product_id: plan.external_product_id,
      seed_updates: 1,
      catalog_product_updates: Number(catalog.rowCount || 0),
      identity_updates: Number(identity.rowCount || 0),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function summarize(plans, applyResults) {
  return {
    scanned_rows: plans.length,
    blocked_rows: plans.filter((plan) => plan.status === 'blocked').length,
    change_candidates: plans.filter((plan) => plan.status === 'ready' && plan.changed).length,
    updated_rows: applyResults.length,
    catalog_product_updates: applyResults.reduce((sum, item) => sum + Number(item.catalog_product_updates || 0), 0),
    identity_updates: applyResults.reduce((sum, item) => sum + Number(item.identity_updates || 0), 0),
  };
}

async function main() {
  const manifestPath = argValue('manifest');
  const out = argValue('out');
  const write = hasFlag('write');
  const confirm = argValue('confirm');
  if (write && confirm !== CONFIRM_TOKEN) {
    throw new Error(`--write requires --confirm ${CONFIRM_TOKEN}`);
  }
  const entries = readManifestEntries(readJson(manifestPath));
  const now = new Date().toISOString();
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await client.connect();
  try {
    const rowsById = await fetchRows(client, entries);
    const plans = entries.map((entry) => {
      const row = rowsById.get(entry.external_product_id);
      if (!row) {
        return { external_product_id: entry.external_product_id, status: 'blocked', changed: false, blockers: ['missing_external_seed'] };
      }
      if (row.status !== 'active') {
        return { external_product_id: entry.external_product_id, status: 'blocked', changed: false, blockers: [`seed_status_${row.status || 'unknown'}`] };
      }
      if (entry.market && text(row.market).toUpperCase() !== entry.market) {
        return { external_product_id: entry.external_product_id, status: 'blocked', changed: false, blockers: [`market_mismatch_${row.market || 'unknown'}`] };
      }
      const next = buildNextSeedData(row, entry, now);
      return {
        external_product_id: entry.external_product_id,
        seed_id: row.id,
        title: row.title,
        canonical_url: row.canonical_url || row.destination_url,
        status: next.status,
        changed: next.changed,
        blockers: next.blockers,
        before: {
          root_count: next.before_root.length,
          root_hash: digest(next.before_root),
        },
        after: {
          root_count: next.after_root.length,
          root_hash: digest(next.after_root),
        },
        removed_root_count: next.removed_root.length,
        removed_variant_image_count: next.variant_changes.reduce((sum, item) => sum + item.removed.length, 0),
        variant_changes: next.variant_changes.map((item) => ({
          label: item.label,
          before_count: item.before.length,
          after_count: item.kept.length,
          removed_count: item.removed.length,
        })),
        removed_root_sample: next.removed_root.slice(0, 8),
        next_seed_data: next.seedData,
      };
    });
    const applyResults = [];
    if (write) {
      for (const plan of plans) {
        if (plan.status !== 'ready' || !plan.changed) continue;
        // eslint-disable-next-line no-await-in-loop
        applyResults.push(await applyPlan(client, plan));
      }
    }
    const report = {
      generated_at: now,
      dry_run: !write,
      manifest: manifestPath,
      summary: summarize(plans, applyResults),
      apply_results: applyResults,
      plans: plans.map(({ next_seed_data: _nextSeedData, ...plan }) => plan),
    };
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
