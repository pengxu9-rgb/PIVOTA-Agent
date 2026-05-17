#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query, withClient } = require('../src/db');

const CONTRACT_VERSION = 'external_seed.reviewed_active_ingredients.v1';
const STRUCTURED_INGREDIENT_REMEDIATION_VERSION = 'external_seed.structured_ingredient_remediation.v1';

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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = asString(value).replace(/\s+/g, ' ');
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function parseActiveIngredients(value) {
  return uniqueStrings(
    asString(value)
      .split(/[,\n|;]/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function normalizeEvidenceText(value) {
  return asString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function evidenceText(seedData, extraEvidence = '') {
  const snapshot = asObject(seedData.snapshot);
  return [
    extraEvidence,
    seedData.pdp_active_ingredients_raw,
    snapshot.pdp_active_ingredients_raw,
    seedData.active_ingredients_raw,
    snapshot.active_ingredients_raw,
    seedData.pdp_ingredients_raw,
    snapshot.pdp_ingredients_raw,
    seedData.ingredients_raw,
    snapshot.ingredients_raw,
    seedData.description,
    snapshot.description,
    seedData.pdp_description,
    snapshot.pdp_description,
  ]
    .map(asString)
    .filter(Boolean)
    .join('\n');
}

function activeEvidenceStatus(seedData, activeIngredients, extraEvidence = '') {
  const haystack = normalizeEvidenceText(evidenceText(seedData, extraEvidence));
  const missing = [];
  for (const active of activeIngredients) {
    const needle = normalizeEvidenceText(active);
    if (!needle) continue;
    const words = asString(active)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2);
    const wordBacked = words.length > 0 && words.every((word) => haystack.includes(word));
    if (!haystack.includes(needle) && !wordBacked) missing.push(active);
  }
  return {
    backed: missing.length === 0,
    missing,
    evidence_chars: haystack.length,
  };
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

function summarizeSeedData(seedData) {
  const snapshot = asObject(seedData.snapshot);
  return {
    active_ingredients: asArray(seedData.active_ingredients),
    snapshot_active_ingredients: asArray(snapshot.active_ingredients),
    ingredient_intel_active_ingredients: asArray(asObject(seedData.ingredient_intel).active_ingredients),
    ingredient_tokens: asArray(seedData.ingredient_tokens),
    key_ingredients: asArray(seedData.key_ingredients),
    ingredient_intel_key_ingredients: asArray(asObject(seedData.ingredient_intel).key_ingredients),
    ingredient_intel_has_inci:
      Boolean(asString(asObject(seedData.ingredient_intel).inci_list)) ||
      Boolean(asString(asObject(seedData.ingredient_intel).inci_raw)) ||
      asArray(asObject(seedData.ingredient_intel).inci_normalized).length > 0,
    active_raw_len: asString(seedData.pdp_active_ingredients_raw || snapshot.pdp_active_ingredients_raw).length,
    review_contract: asObject(seedData.reviewed_active_ingredients_v1).contract_version || null,
    structured_ingredient_remediation:
      asObject(seedData.structured_ingredient_remediation_v1).contract_version || null,
  };
}

function clearStaleStructuredIngredientFields(seedData, metadata) {
  const clearedAt = metadata.reviewed_at || new Date().toISOString();
  const remediation = {
    contract_version: STRUCTURED_INGREDIENT_REMEDIATION_VERSION,
    status: 'non_active_ingredient_fields_cleared',
    reason: metadata.reason || 'reviewed_stale_structured_ingredient_fields',
    source_url: metadata.source_url || null,
    reviewed_by: metadata.reviewed_by || 'codex',
    reviewed_at: clearedAt,
    updated_at: clearedAt,
  };
  const clearTarget = (target) => {
    if (!target || typeof target !== 'object') return;
    for (const field of [
      'raw_ingredient_text_clean',
      'inci_list',
      'inciList',
      'ingredients_inci',
      'ingredientsInci',
      'ingredient_tokens',
      'key_ingredients',
      'keyIngredients',
    ]) {
      delete target[field];
    }
    const intel = asObject(target.ingredient_intel);
    const activeIngredients = asArray(intel.active_ingredients);
    target.ingredient_intel = activeIngredients.length ? { active_ingredients: activeIngredients } : {};
    target.structured_ingredient_remediation_v1 = remediation;
  };
  clearTarget(seedData);
  clearTarget(seedData.snapshot);
  mergeQuality(seedData, 'ingredients_inci', {
    source_origin: 'pivota_reviewed_source_backed_patch',
    source_quality_status: 'cleared_stale_non_source_backed',
    review_state: 'assistant_reviewed',
    source_url: metadata.source_url || null,
    updated_at: clearedAt,
  });
}

function patchSeedData(seedData, activeIngredients, metadata) {
  const next = JSON.parse(JSON.stringify(asObject(seedData)));
  next.snapshot = asObject(next.snapshot);

  const reviewedAt = metadata.reviewed_at || new Date().toISOString();
  const contract = {
    contract_version: CONTRACT_VERSION,
    status: 'approved',
    active_ingredients: activeIngredients,
    source_url: metadata.source_url || null,
    evidence: metadata.evidence || null,
    reason: metadata.reason || 'reviewed_source_backed_active_ingredients',
    reviewed_by: metadata.reviewed_by || 'codex',
    reviewed_at: reviewedAt,
    updated_at: reviewedAt,
  };

  next.active_ingredients = activeIngredients;
  next.snapshot.active_ingredients = activeIngredients;
  next.ingredient_intel = {
    ...asObject(next.ingredient_intel),
    active_ingredients: activeIngredients,
  };
  next.snapshot.ingredient_intel = {
    ...asObject(next.snapshot.ingredient_intel),
    active_ingredients: activeIngredients,
  };
  next.reviewed_active_ingredients_v1 = contract;
  next.snapshot.reviewed_active_ingredients_v1 = contract;
  if (metadata.clear_stale_structured_ingredients === true) {
    clearStaleStructuredIngredientFields(next, metadata);
  }
  mergeQuality(next, 'active_ingredients', {
    source_origin: 'pivota_reviewed_source_backed_patch',
    source_quality_status: 'high',
    review_state: 'assistant_reviewed',
    source_url: metadata.source_url || null,
    updated_at: reviewedAt,
  });
  return next;
}

async function fetchRows(externalProductIds, market) {
  const res = await query(
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
  );
  return res.rows || [];
}

async function applyUpdates(items) {
  if (!items.length) return { updated_rows: 0 };
  let updatedRows = 0;
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout = '10000ms'");
      await client.query("SET LOCAL statement_timeout = '60000ms'");
      for (const item of items) {
        const res = await client.query(
          `
            UPDATE external_product_seeds
            SET seed_data = $2::jsonb,
                updated_at = now()
            WHERE id = $1
              AND seed_data IS DISTINCT FROM $2::jsonb
          `,
          [item.seed_id, JSON.stringify(item.after_seed_data)],
        );
        updatedRows += Number(res.rowCount || 0);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
  return { updated_rows: updatedRows };
}

async function run(options) {
  const externalProductIds = uniqueStrings(
    asString(options.externalProductIds || options.externalProductId)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const activeIngredients = parseActiveIngredients(options.activeIngredients);
  if (!externalProductIds.length) throw new Error('--external-product-id or --external-product-ids is required');
  if (!activeIngredients.length) throw new Error('--active-ingredients is required');

  const rows = await fetchRows(externalProductIds, options.market || '');
  const rowById = new Map(rows.map((row) => [row.external_product_id, row]));
  const reviewedAt = new Date().toISOString();
  const results = [];
  const updates = [];

  for (const externalProductId of externalProductIds) {
    const row = rowById.get(externalProductId);
    if (!row) {
      results.push({ external_product_id: externalProductId, status: 'missing_seed' });
      continue;
    }
    const beforeSeedData = asObject(row.seed_data);
    const evidence = activeEvidenceStatus(beforeSeedData, activeIngredients, options.evidence || '');
    const before = summarizeSeedData(beforeSeedData);
    const afterSeedData = patchSeedData(beforeSeedData, activeIngredients, {
      source_url: options.sourceUrl || row.canonical_url || row.destination_url,
      evidence: options.evidence || '',
      reason: options.reason || '',
      reviewed_by: options.reviewedBy || 'codex',
      reviewed_at: reviewedAt,
      clear_stale_structured_ingredients: options.clearStaleStructuredIngredients === true,
    });
    const after = summarizeSeedData(afterSeedData);
    const changed = JSON.stringify(beforeSeedData) !== JSON.stringify(afterSeedData);
    const blocked = !evidence.backed && !options.allowMissingEvidence;
    const result = {
      seed_id: row.id,
      external_product_id: row.external_product_id,
      market: row.market,
      domain: row.domain,
      title: row.title,
      canonical_url: row.canonical_url || row.destination_url,
      dry_run: !options.write,
      status: blocked ? 'blocked_missing_source_evidence' : changed ? (options.write ? 'pending_apply' : 'dry_run') : 'unchanged',
      source_evidence: evidence,
      before,
      after,
    };
    results.push(result);
    if (changed && !blocked) {
      updates.push({
        seed_id: row.id,
        external_product_id: row.external_product_id,
        after_seed_data: afterSeedData,
      });
    }
  }

  const applyResult = options.write ? await applyUpdates(updates) : { updated_rows: 0 };
  if (options.write) {
    for (const result of results) {
      if (result.status === 'pending_apply') result.status = 'applied';
    }
  }

  return {
    generated_at: reviewedAt,
    dry_run: !options.write,
    filters: {
      external_product_ids: externalProductIds,
      market: options.market || null,
    },
    requested_active_ingredients: activeIngredients,
    summary: {
      scanned_rows: rows.length,
      missing_rows: results.filter((item) => item.status === 'missing_seed').length,
      blocked_missing_source_evidence: results.filter((item) => item.status === 'blocked_missing_source_evidence').length,
      change_candidates: updates.length,
      updated_rows: applyResult.updated_rows || 0,
    },
    results,
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
  const report = await run({
    externalProductId: argValue('external-product-id'),
    externalProductIds: argValue('external-product-ids'),
    activeIngredients: argValue('active-ingredients'),
    market: argValue('market'),
    sourceUrl: argValue('source-url'),
    evidence: argValue('evidence'),
    reason: argValue('reason'),
    reviewedBy: argValue('reviewed-by') || 'codex',
    allowMissingEvidence: hasFlag('allow-missing-evidence'),
    clearStaleStructuredIngredients:
      hasFlag('clear-stale-structured-ingredients') || hasFlag('clearStaleStructuredIngredients'),
    write: hasFlag('write'),
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
  CONTRACT_VERSION,
  activeEvidenceStatus,
  clearStaleStructuredIngredientFields,
  parseActiveIngredients,
  patchSeedData,
  run,
  summarizeSeedData,
};
