#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { query, closePool, withClient } = require('../src/db');

const CONFIRM_TOKEN = 'APPLY_REVIEWED_EXTERNAL_SEED_CATEGORY_PATCH';
const OVERWRITE_CONFIRM_TOKEN = 'APPLY_REVIEWED_EXTERNAL_SEED_CATEGORY_OVERWRITE';
const CATEGORY_CONTRACT_VERSION = 'external_seed.reviewed_category_patch.v1';
const SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';

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
  return String(value || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sanitizeJson(value) {
  return JSON.stringify(value).replace(/\u0000/g, '');
}

function readJson(filePath) {
  const normalized = text(filePath);
  if (!normalized) throw new Error('--manifest is required');
  return JSON.parse(fs.readFileSync(normalized, 'utf8'));
}

function normalizeCategory(value) {
  return text(value)
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeCategoryPath(value) {
  return text(value)
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\s*\/\s*/g, '/')
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/-/g, '/')
    .replace(/-\//g, '/');
}

function categoryPathParts(value) {
  return normalizeCategoryPath(value).split('/').filter(Boolean);
}

function normalizeComparable(value) {
  return text(value).toLowerCase();
}

function normalizePathComparable(value) {
  return normalizeCategoryPath(value);
}

function normalizeTitleTokens(value) {
  return Array.from(
    new Set(
      text(value)
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 && !['the', 'and', 'with', 'for', 'copy', 'pack', 'set'].includes(token)),
    ),
  );
}

function scoreTitleMatch(left, right) {
  const leftTokens = normalizeTitleTokens(left);
  const rightTokens = new Set(normalizeTitleTokens(right));
  if (!leftTokens.length || !rightTokens.size) return 1;
  const shared = leftTokens.filter((token) => rightTokens.has(token)).length;
  return shared / Math.max(1, leftTokens.length);
}

function uniqueStrings(values) {
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

function readManifestEntries(raw) {
  const root = Array.isArray(raw) ? { entries: raw } : asObject(raw);
  const entries = asArray(root.entries || root.patches || root.rows);
  if (!entries.length) throw new Error('Manifest must contain entries[]');
  return entries.map((entry) => {
    const item = asObject(entry);
    const categoryPath = normalizeCategoryPath(item.category_path || item.catalog_category_path);
    return {
      ...item,
      external_product_id: text(item.external_product_id),
      market: text(item.market || root.market || 'US').toUpperCase(),
      title: text(item.title),
      canonical_url: text(item.canonical_url || item.destination_url),
      category: normalizeCategory(item.category || item.product_type),
      product_type: normalizeCategory(item.product_type || item.category),
      category_path: categoryPath,
      catalog_category_path: normalizeCategoryPath(item.catalog_category_path || categoryPath),
      source_url: text(item.source_url || item.canonical_url),
      source_kind: text(item.source_kind || root.source_kind || 'official_pdp_title_url_review'),
      evidence: text(item.evidence || root.evidence),
      reviewed_by: text(item.reviewed_by || root.reviewed_by || 'codex_review'),
      reason: text(item.reason || root.reason || 'reviewed_source_backed_category_patch'),
      confidence: Number(item.confidence || root.confidence || 0),
    };
  });
}

function validateEntry(entry) {
  const blockers = [];
  if (!entry.external_product_id) blockers.push('missing_external_product_id');
  if (!entry.category) blockers.push('missing_category');
  if (!entry.category_path) blockers.push('missing_category_path');
  if (entry.category_path && !/^beauty(?:\/|$)/.test(entry.category_path)) blockers.push('category_path_not_beauty');
  if (entry.catalog_category_path && !/^beauty(?:\/|$)/.test(entry.catalog_category_path)) {
    blockers.push('catalog_category_path_not_beauty');
  }
  if (entry.source_url && !/^https?:\/\//i.test(entry.source_url)) blockers.push('invalid_source_url');
  if (!entry.source_url) blockers.push('missing_source_url');
  if (!entry.evidence || entry.evidence.length < 20) blockers.push('missing_review_evidence');
  if (!entry.reviewed_by) blockers.push('missing_reviewer');
  if (entry.confidence && entry.confidence < 0.8) blockers.push('confidence_below_review_threshold');
  return blockers;
}

function collectExistingCategoryValues(seedData) {
  const snapshot = asObject(seedData.snapshot);
  const derived = asObject(seedData.derived);
  const recall = asObject(derived.recall);
  return {
    categories: [
      ['seed_data.category', seedData.category],
      ['snapshot.category', snapshot.category],
      ['derived.recall.category', recall.category],
    ],
    paths: [
      ['seed_data.category_path', seedData.category_path],
      ['snapshot.category_path', snapshot.category_path],
      ['seed_data.catalog_category_path', seedData.catalog_category_path],
      ['snapshot.catalog_category_path', snapshot.catalog_category_path],
    ],
  };
}

function findConflicts(seedData, entry) {
  const conflicts = [];
  const existing = collectExistingCategoryValues(seedData);
  const nextCategory = normalizeComparable(entry.category);
  const nextPaths = new Set([
    normalizePathComparable(entry.category_path),
    normalizePathComparable(entry.catalog_category_path),
  ].filter(Boolean));

  for (const [field, value] of existing.categories) {
    const current = normalizeComparable(value);
    if (current && current !== nextCategory) conflicts.push(`${field}:${text(value)}`);
  }
  for (const [field, value] of existing.paths) {
    const current = normalizePathComparable(value);
    if (current && !nextPaths.has(current)) conflicts.push(`${field}:${text(value)}`);
  }
  return conflicts;
}

function buildQualitySummary(seedData, entry, fields, now) {
  const snapshot = asObject(seedData.snapshot);
  const quality = {
    ...asObject(snapshot.pdp_field_quality_summary),
    ...asObject(seedData.pdp_field_quality_summary),
  };
  const meta = {
    source_origin: 'reviewed_source_backed_category_patch',
    source_quality_status: 'high',
    source_kinds: uniqueStrings([entry.source_kind]),
    source_url: entry.source_url,
    reviewed_by: entry.reviewed_by,
    reason: entry.reason,
    evidence: entry.evidence,
    updated_at: now,
  };
  for (const field of fields) {
    if (field === 'category' || field === 'product_type') quality[field] = meta;
    if (field === 'category_path' || field === 'catalog_category_path') quality[field] = meta;
  }
  return quality;
}

function buildSnapshotContract(existing, now) {
  return {
    ...asObject(existing),
    contract_version: SNAPSHOT_CONTRACT_VERSION,
    source: 'reviewed_source_backed_category_patch',
    authoritative: true,
    structured_fields_authoritative: true,
    legacy_fields_quarantined: true,
    replace_strategy: 'replace_not_merge',
    updated_at: now,
  };
}

function buildReviewContract(entry, fields, before, now) {
  return {
    contract_version: CATEGORY_CONTRACT_VERSION,
    review_state: 'assistant_reviewed',
    reviewed_by: entry.reviewed_by,
    reviewed_at: now,
    reason: entry.reason,
    evidence: entry.evidence,
    source_url: entry.source_url,
    source_kind: entry.source_kind,
    category: entry.category,
    category_path: entry.category_path,
    catalog_category_path: entry.catalog_category_path,
    patched_fields: fields,
    previous_values: before,
  };
}

function setReviewedField(target, key, value, fields, options = {}) {
  if (!target || typeof target !== 'object') return;
  const current = target[key];
  const normalizedCurrent = key.includes('category_path') ? normalizePathComparable(current) : normalizeComparable(current);
  const normalizedNext = key.includes('category_path') ? normalizePathComparable(value) : normalizeComparable(value);
  if (!normalizedNext) return;
  if (!normalizedCurrent || normalizedCurrent === normalizedNext || options.allowOverwrite) {
    if (target[key] !== value) {
      target[key] = value;
      fields.add(key);
    }
  }
}

function buildCategoryPatchPlanForRow(row, entry, options = {}) {
  const normalizedEntry = readManifestEntries({ entries: [entry] })[0];
  const validation = validateEntry(normalizedEntry);
  const seedData = JSON.parse(JSON.stringify(asObject(row?.seed_data)));
  const snapshot = asObject(seedData.snapshot);
  seedData.snapshot = snapshot;
  const before = {
    category: text(seedData.category || snapshot.category || asObject(asObject(seedData.derived).recall).category),
    category_path: text(seedData.category_path || snapshot.category_path),
    catalog_category_path: text(seedData.catalog_category_path || snapshot.catalog_category_path),
    product_type: text(seedData.product_type || snapshot.product_type),
  };

  if (validation.length) {
    return {
      external_product_id: normalizedEntry.external_product_id || row?.external_product_id || '',
      title: row?.title || normalizedEntry.title || '',
      status: 'blocked',
      changed: false,
      blocking_reasons: validation,
      before,
    };
  }

  if (normalizedEntry.title && row?.title && scoreTitleMatch(normalizedEntry.title, row.title) < 0.55) {
    return {
      external_product_id: normalizedEntry.external_product_id,
      title: row.title,
      status: 'blocked',
      changed: false,
      blocking_reasons: ['title_mismatch'],
      before,
    };
  }

  const conflicts = options.allowOverwrite ? [] : findConflicts(seedData, normalizedEntry);
  if (conflicts.length) {
    return {
      external_product_id: normalizedEntry.external_product_id,
      title: row?.title || normalizedEntry.title || '',
      status: 'blocked',
      changed: false,
      blocking_reasons: conflicts.map((conflict) => `existing_category_conflict:${conflict}`),
      before,
    };
  }

  const fields = new Set();
  const derived = asObject(seedData.derived);
  const recall = asObject(derived.recall);
  seedData.derived = derived;
  derived.recall = recall;

  setReviewedField(seedData, 'category', normalizedEntry.category, fields, options);
  setReviewedField(snapshot, 'category', normalizedEntry.category, fields, options);
  setReviewedField(recall, 'category', normalizedEntry.category, fields, options);
  if (!text(seedData.product_type) || options.allowOverwrite) {
    setReviewedField(seedData, 'product_type', normalizedEntry.product_type || normalizedEntry.category, fields, options);
  }
  if (!text(snapshot.product_type) || options.allowOverwrite) {
    setReviewedField(snapshot, 'product_type', normalizedEntry.product_type || normalizedEntry.category, fields, options);
  }
  setReviewedField(seedData, 'category_path', normalizedEntry.category_path, fields, options);
  setReviewedField(snapshot, 'category_path', normalizedEntry.category_path, fields, options);
  setReviewedField(seedData, 'catalog_category_path', normalizedEntry.catalog_category_path, fields, options);
  setReviewedField(snapshot, 'catalog_category_path', normalizedEntry.catalog_category_path, fields, options);

  const fieldList = Array.from(fields);
  const now = options.now || new Date().toISOString();
  if (fieldList.length) {
    const quality = buildQualitySummary(seedData, normalizedEntry, fieldList, now);
    seedData.pdp_field_quality_summary = quality;
    snapshot.pdp_field_quality_summary = quality;
    seedData.external_seed_snapshot_contract = buildSnapshotContract(seedData.external_seed_snapshot_contract, now);
    snapshot.external_seed_snapshot_contract = buildSnapshotContract(snapshot.external_seed_snapshot_contract, now);
    const reviewContract = buildReviewContract(normalizedEntry, fieldList, before, now);
    seedData.reviewed_category_patch_v1 = reviewContract;
    snapshot.reviewed_category_patch_v1 = reviewContract;
  }

  const after = {
    category: text(seedData.category || snapshot.category || recall.category),
    category_path: text(seedData.category_path || snapshot.category_path),
    catalog_category_path: text(seedData.catalog_category_path || snapshot.catalog_category_path),
    product_type: text(seedData.product_type || snapshot.product_type),
  };
  const changed = sanitizeJson(seedData) !== sanitizeJson(row?.seed_data || {});

  return {
    id: row?.id,
    external_product_id: row?.external_product_id || normalizedEntry.external_product_id,
    title: row?.title || normalizedEntry.title,
    canonical_url: row?.canonical_url || row?.destination_url || normalizedEntry.canonical_url,
    status: changed ? 'planned' : 'unchanged',
    changed,
    patch_keys: fieldList,
    before,
    after,
    next_seed_data: seedData,
  };
}

function buildServingPatch(seedData, fields = []) {
  const fieldSet = new Set(fields);
  const patch = {
    pdp_field_quality_summary: seedData.pdp_field_quality_summary,
    external_seed_snapshot_contract: seedData.external_seed_snapshot_contract,
    reviewed_category_patch_v1: seedData.reviewed_category_patch_v1,
  };
  for (const field of ['category', 'product_type', 'category_path', 'catalog_category_path']) {
    if (fieldSet.has(field) && seedData[field]) patch[field] = seedData[field];
  }
  if (fieldSet.has('category_path') && seedData.category_path) {
    patch.category_path_parts = categoryPathParts(seedData.category_path);
  }
  return patch;
}

function summarizePlans(plans) {
  const summary = {
    scanned: plans.length,
    planned: plans.filter((plan) => plan.status === 'planned').length,
    unchanged: plans.filter((plan) => plan.status === 'unchanged').length,
    blocked: plans.filter((plan) => plan.status === 'blocked').length,
    missing: plans.filter((plan) => plan.status === 'missing').length,
    updated: 0,
    catalog_product_updates: 0,
    identity_updates: 0,
    by_patch_key: {},
    blocking_reasons: {},
  };
  for (const plan of plans) {
    for (const key of plan.patch_keys || []) {
      summary.by_patch_key[key] = (summary.by_patch_key[key] || 0) + 1;
    }
    for (const reason of plan.blocking_reasons || []) {
      summary.blocking_reasons[reason] = (summary.blocking_reasons[reason] || 0) + 1;
    }
  }
  return summary;
}

async function fetchRows(entries, market) {
  const ids = Array.from(new Set(entries.map((entry) => entry.external_product_id).filter(Boolean)));
  if (!ids.length) return new Map();
  const res = await query(
    `
      SELECT id, external_product_id, market, status, title, domain, canonical_url, destination_url,
             coalesce(seed_data, '{}'::jsonb) AS seed_data
      FROM external_product_seeds
      WHERE external_product_id = ANY($1::text[])
        AND ($2::text = '' OR market = $2::text)
    `,
    [ids, market || ''],
  );
  return new Map((res.rows || []).map((row) => [row.external_product_id, row]));
}

async function applyPlan(plan) {
  const servingPatch = buildServingPatch(plan.next_seed_data, plan.patch_keys);
  const category = plan.next_seed_data.category || null;
  const productType = plan.next_seed_data.product_type || category;
  const categoryPath = plan.next_seed_data.category_path || null;
  const patchJson = sanitizeJson(servingPatch);
  return withClient(async (client) => {
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
      const catalog = await client.query(
        `
          UPDATE catalog_products
          SET category = CASE
                WHEN coalesce(category, '') = '' OR lower(category) = lower($2::text) THEN $2
                ELSE category
              END,
              product_type = CASE
                WHEN coalesce(product_type, '') = '' OR lower(product_type) = lower($3::text) THEN $3
                ELSE product_type
              END,
              category_path = CASE
                WHEN coalesce(category_path, '') = '' OR lower(category_path) = lower($4::text) THEN $4
                ELSE category_path
              END,
              product_payload = COALESCE(product_payload, '{}'::jsonb) || $5::jsonb,
              updated_at = NOW()
          WHERE merchant_id = 'external_seed'
            AND platform = 'external_seed'
            AND source_product_id = $1
        `,
        [plan.external_product_id, category, productType, categoryPath, patchJson],
      );
      const identity = await client.query(
        `
          UPDATE pdp_identity_listing
          SET source_payload = COALESCE(source_payload, '{}'::jsonb) || $2::jsonb,
              updated_at = NOW()
          WHERE source_listing_ref = $1
        `,
        [`external_seed:${plan.external_product_id}`, patchJson],
      );
      await client.query('COMMIT');
      return {
        external_product_id: plan.external_product_id,
        seed_updates: 1,
        catalog_product_updates: Number(catalog.rowCount || 0),
        identity_updates: Number(identity.rowCount || 0),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

async function main() {
  const manifestPath = argValue('manifest');
  const out = argValue('out');
  const write = hasFlag('write');
  const allowOverwrite = hasFlag('allow-overwrite');
  const confirm = argValue('confirm');
  const confirmOverwrite = argValue('confirm-overwrite');
  if (write && confirm !== CONFIRM_TOKEN) {
    throw new Error(`--write requires --confirm ${CONFIRM_TOKEN}`);
  }
  if (write && allowOverwrite && confirmOverwrite !== OVERWRITE_CONFIRM_TOKEN) {
    throw new Error(`--allow-overwrite in write mode requires --confirm-overwrite ${OVERWRITE_CONFIRM_TOKEN}`);
  }

  const entries = readManifestEntries(readJson(manifestPath));
  const market = text(argValue('market', entries[0]?.market || 'US')).toUpperCase();
  const rowsById = await fetchRows(entries, market);
  const plans = entries.map((entry) => {
    const row = rowsById.get(entry.external_product_id);
    if (!row) {
      return {
        external_product_id: entry.external_product_id,
        title: entry.title,
        status: 'missing',
        changed: false,
        blocking_reasons: ['row_not_found'],
      };
    }
    if (row.status !== 'active') {
      return {
        external_product_id: entry.external_product_id,
        title: row.title || entry.title,
        status: 'blocked',
        changed: false,
        blocking_reasons: [`seed_status_${row.status || 'unknown'}`],
      };
    }
    if (entry.market && text(row.market).toUpperCase() !== entry.market) {
      return {
        external_product_id: entry.external_product_id,
        title: row.title || entry.title,
        status: 'blocked',
        changed: false,
        blocking_reasons: [`market_mismatch_${row.market || 'unknown'}`],
      };
    }
    return buildCategoryPatchPlanForRow(row, entry, { allowOverwrite });
  });

  const applyResults = [];
  if (write) {
    for (const plan of plans) {
      if (plan.status !== 'planned' || !plan.changed) continue;
      // eslint-disable-next-line no-await-in-loop
      applyResults.push(await applyPlan(plan));
    }
  }
  const summary = summarizePlans(plans);
  summary.updated = applyResults.length;
  summary.catalog_product_updates = applyResults.reduce((sum, item) => sum + Number(item.catalog_product_updates || 0), 0);
  summary.identity_updates = applyResults.reduce((sum, item) => sum + Number(item.identity_updates || 0), 0);

  const report = {
    generated_at: new Date().toISOString(),
    dry_run: !write,
    manifest: manifestPath,
    market,
    allow_overwrite: allowOverwrite,
    overwrite_confirmed: Boolean(write && allowOverwrite),
    summary,
    apply_results: applyResults,
    plans: plans.map(({ next_seed_data: _nextSeedData, ...plan }) => plan),
  };
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      if (process.exitCode) process.exit(process.exitCode);
    });
}

module.exports = {
  _internals: {
    buildCategoryPatchPlanForRow,
    buildServingPatch,
    normalizeCategoryPath,
    readManifestEntries,
    scoreTitleMatch,
    summarizePlans,
    validateEntry,
  },
};
