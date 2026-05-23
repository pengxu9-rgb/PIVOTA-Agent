#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query, withClient } = require('../src/db');

const CONFIRM_TOKEN = 'APPLY_REVIEWED_EXTERNAL_SEED_BRAND_SURFACE_PATCH';
const PATCH_VERSION = 'external_seed.reviewed_brand_surface_patch.v1';
const SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';
const CATALOG_SYNC_STATUS = 'stale';

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return String(value.name || value.label || value.value || '').trim();
  }
  return String(value || '').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function normalizeBrand(value) {
  return asString(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeJson(value) {
  return JSON.stringify(value).replace(/\u0000/g, '').replace(/\\+u0000/gi, '');
}

function readJson(filePath) {
  const normalized = asString(filePath);
  if (!normalized) return null;
  return JSON.parse(fs.readFileSync(normalized, 'utf8'));
}

function readManifestEntries(raw, defaults = {}) {
  if (!raw) return [];
  const root = Array.isArray(raw) ? { entries: raw } : asObject(raw);
  const entries = Array.isArray(root.entries || root.patches || root.rows)
    ? root.entries || root.patches || root.rows
    : [];
  return entries.map((entry) => normalizeEntry({ ...defaults, ...root, ...asObject(entry) }));
}

function normalizeEntry(entry) {
  return {
    external_product_id: asString(entry.external_product_id || entry.externalProductId),
    market: asString(entry.market || 'US').toUpperCase(),
    brand: asString(entry.brand || entry.brand_name || entry.brandName),
    reason: asString(entry.reason || 'reviewed_official_domain_brand_surface_repair'),
    evidence: asString(entry.evidence),
    source_url: asString(entry.source_url || entry.sourceUrl || entry.canonical_url || entry.canonicalUrl),
    reviewed_by: asString(entry.reviewed_by || entry.reviewedBy || 'codex_review'),
  };
}

function cliEntries() {
  const manifest = readJson(argValue('manifest'));
  if (manifest) return readManifestEntries(manifest);
  const entry = normalizeEntry({
    external_product_id: argValue('external-product-id') || argValue('externalProductId'),
    market: argValue('market', 'US'),
    brand: argValue('brand'),
    reason: argValue('reason', 'reviewed_official_domain_brand_surface_repair'),
    evidence: argValue('evidence'),
    source_url: argValue('source-url') || argValue('sourceUrl'),
    reviewed_by: argValue('reviewed-by') || argValue('reviewedBy') || 'codex_review',
  });
  return entry.external_product_id || entry.brand || entry.source_url || entry.evidence ? [entry] : [];
}

function hostname(value) {
  const raw = asString(value);
  if (!raw) return '';
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function sourceHostMatchesRow(sourceUrl, row) {
  const sourceHost = hostname(sourceUrl);
  const rowHost = hostname(
    row.canonical_url ||
      row.destination_url ||
      asObject(row.seed_data).canonical_url ||
      asObject(row.seed_data).destination_url ||
      asObject(asObject(row.seed_data).snapshot).canonical_url ||
      asObject(asObject(row.seed_data).snapshot).destination_url,
  );
  if (!sourceHost || !rowHost) return false;
  return sourceHost === rowHost || sourceHost.endsWith(`.${rowHost}`) || rowHost.endsWith(`.${sourceHost}`);
}

function buildMarker(entry, generatedAt) {
  return {
    contract_version: PATCH_VERSION,
    review_state: 'assistant_reviewed',
    reviewed_by: entry.reviewed_by,
    reviewed_at: generatedAt,
    reason: entry.reason,
    evidence: entry.evidence,
    source_url: entry.source_url,
    brand: entry.brand,
    patched_fields: ['brand'],
  };
}

function buildSnapshotContract(generatedAt) {
  return {
    contract_version: SNAPSHOT_CONTRACT_VERSION,
    source: 'reviewed_official_domain_brand_surface_patch',
    authoritative: true,
    structured_fields_authoritative: true,
    legacy_fields_quarantined: true,
    replace_strategy: 'replace_not_merge',
    updated_at: generatedAt,
  };
}

function existingBrandCandidates(row) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const productPayload = asObject(row.product_payload);
  return [
    seedData.brand,
    seedData.brand_name,
    seedData.vendor,
    snapshot.brand,
    snapshot.brand_name,
    snapshot.vendor,
    row.catalog_brand,
    productPayload.brand,
    productPayload.brand_name,
    asObject(productPayload.snapshot).brand,
  ]
    .map(asString)
    .filter(Boolean);
}

function validatePlan(row, entry) {
  const blockers = [];
  if (!entry.external_product_id) blockers.push('missing_external_product_id');
  if (!entry.brand) blockers.push('missing_brand');
  if (entry.brand && (entry.brand.length < 2 || entry.brand.length > 120)) blockers.push('invalid_brand_length');
  if (/https?:\/\//i.test(entry.brand)) blockers.push('brand_looks_like_url');
  if (!entry.source_url || !hostname(entry.source_url)) blockers.push('missing_valid_source_url');
  if (!entry.evidence || entry.evidence.length < 20) blockers.push('missing_review_evidence');
  if (!entry.reviewed_by) blockers.push('missing_reviewer');
  if (!row) return blockers;
  if (asString(row.status).toLowerCase() !== 'active') blockers.push(`seed_status_${row.status || 'unknown'}`);
  if (entry.market && asString(row.market).toUpperCase() !== entry.market) blockers.push(`market_mismatch_${row.market || 'unknown'}`);
  if (entry.source_url && !sourceHostMatchesRow(entry.source_url, row)) blockers.push('source_url_host_mismatch');

  const desired = normalizeBrand(entry.brand);
  const conflicts = existingBrandCandidates(row)
    .filter((brand) => normalizeBrand(brand) && normalizeBrand(brand) !== desired);
  if (conflicts.length) blockers.push(`brand_conflict_${Array.from(new Set(conflicts)).join('|')}`);
  return blockers;
}

function patchSeedData(seedData, entry, generatedAt) {
  const next = cloneJson(asObject(seedData));
  const snapshot = asObject(next.snapshot);
  next.snapshot = snapshot;
  const marker = buildMarker(entry, generatedAt);
  const contract = {
    ...asObject(snapshot.external_seed_snapshot_contract),
    ...asObject(next.external_seed_snapshot_contract),
    ...buildSnapshotContract(generatedAt),
  };

  next.brand = entry.brand;
  snapshot.brand = entry.brand;
  next.brand_origin = next.brand_origin || 'reviewed_official_domain';
  snapshot.brand_origin = snapshot.brand_origin || 'reviewed_official_domain';
  next.reviewed_brand_surface_patch_v1 = marker;
  snapshot.reviewed_brand_surface_patch_v1 = marker;
  next.external_seed_snapshot_contract = contract;
  snapshot.external_seed_snapshot_contract = contract;

  return next;
}

function buildCatalogPatch(entry, generatedAt) {
  const marker = buildMarker(entry, generatedAt);
  return {
    brand: entry.brand,
    brand_name: entry.brand,
    reviewed_brand_surface_patch_v1: marker,
    external_seed_snapshot_contract: buildSnapshotContract(generatedAt),
  };
}

async function fetchRows(entries) {
  const ids = entries.map((entry) => entry.external_product_id).filter(Boolean);
  if (!ids.length) return new Map();
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
        eps.status,
        eps.price_amount,
        eps.price_currency,
        eps.availability,
        coalesce(eps.seed_data, '{}'::jsonb) AS seed_data,
        cp.product_key,
        cp.brand AS catalog_brand,
        cp.content_key,
        coalesce(cp.product_payload, '{}'::jsonb) AS product_payload
      FROM external_product_seeds eps
      LEFT JOIN catalog_products cp
        ON cp.source_product_id = eps.external_product_id
       AND cp.merchant_id = 'external_seed'
       AND cp.platform = 'external_seed'
      WHERE eps.external_product_id = ANY($1::text[])
      ORDER BY array_position($1::text[], eps.external_product_id::text)
    `,
    [ids],
  );
  const byId = new Map();
  for (const row of res.rows || []) {
    if (!byId.has(row.external_product_id)) byId.set(row.external_product_id, row);
  }
  return byId;
}

function buildPlans(entries, rowsById, generatedAt) {
  return entries.map((entry) => {
    const row = rowsById.get(entry.external_product_id);
    if (!row) {
      return {
        external_product_id: entry.external_product_id,
        status: 'missing',
        changed: false,
        blockers: ['missing_external_seed'],
      };
    }
    const blockers = validatePlan(row, entry);
    const nextSeedData = blockers.length ? asObject(row.seed_data) : patchSeedData(row.seed_data, entry, generatedAt);
    return {
      external_product_id: entry.external_product_id,
      seed_id: row.id,
      market: row.market,
      domain: row.domain,
      title: row.title,
      canonical_url: row.canonical_url || row.destination_url,
      status: blockers.length ? 'blocked' : 'ready',
      changed: !blockers.length && sanitizeJson(nextSeedData) !== sanitizeJson(row.seed_data || {}),
      blockers,
      before: {
        brand_candidates: existingBrandCandidates(row),
        price_amount: row.price_amount,
        price_currency: row.price_currency,
        availability: row.availability,
        content_key: row.content_key,
      },
      after: {
        brand: entry.brand,
        price_amount: row.price_amount,
        price_currency: row.price_currency,
        availability: row.availability,
      },
      next_seed_data: nextSeedData,
      catalog_patch: buildCatalogPatch(entry, generatedAt),
    };
  });
}

async function applyPlans(plans, { write }) {
  if (!write) return [];
  const applied = [];
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout = '10000ms'");
      await client.query("SET LOCAL statement_timeout = '60000ms'");
      for (const plan of plans) {
        if (plan.status !== 'ready' || !plan.changed) continue;
        const seedResult = await client.query(
          `
            UPDATE external_product_seeds
            SET seed_data = $2::jsonb,
                updated_at = NOW()
            WHERE id = $1
          `,
          [plan.seed_id, sanitizeJson(plan.next_seed_data)],
        );
        const catalogResult = await client.query(
          `
            UPDATE catalog_products
            SET brand = $2,
                product_payload = coalesce(product_payload, '{}'::jsonb) || $3::jsonb,
                sync_status = $4,
                updated_at = NOW()
            WHERE merchant_id = 'external_seed'
              AND platform = 'external_seed'
              AND source_product_id = $1
          `,
          [plan.external_product_id, plan.after.brand, sanitizeJson(plan.catalog_patch), CATALOG_SYNC_STATUS],
        );
        applied.push({
          external_product_id: plan.external_product_id,
          seed_updates: Number(seedResult.rowCount || 0),
          catalog_product_updates: Number(catalogResult.rowCount || 0),
        });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => null);
      throw error;
    }
  });
  return applied;
}

function summarize(plans, applied) {
  return {
    scanned_rows: plans.length,
    missing_rows: plans.filter((plan) => plan.status === 'missing').length,
    blocked_rows: plans.filter((plan) => plan.status === 'blocked').length,
    ready_rows: plans.filter((plan) => plan.status === 'ready').length,
    change_candidates: plans.filter((plan) => plan.status === 'ready' && plan.changed).length,
    updated_rows: applied.length,
    seed_updates: applied.reduce((sum, row) => sum + Number(row.seed_updates || 0), 0),
    catalog_product_updates: applied.reduce((sum, row) => sum + Number(row.catalog_product_updates || 0), 0),
  };
}

async function main() {
  const entries = cliEntries();
  const write = hasFlag('write');
  const confirm = argValue('confirm');
  const out = asString(argValue('out'));
  if (!entries.length) throw new Error('Provide --manifest or --external-product-id with --brand');
  if (write && confirm !== CONFIRM_TOKEN) {
    throw new Error(`--write requires --confirm ${CONFIRM_TOKEN}`);
  }
  const generatedAt = new Date().toISOString();
  const rowsById = await fetchRows(entries);
  const plans = buildPlans(entries, rowsById, generatedAt);
  const applied = await applyPlans(plans, { write });
  const report = {
    generated_at: generatedAt,
    dry_run: !write,
    summary: summarize(plans, applied),
    apply_results: applied,
    plans: plans.map(({ next_seed_data: _nextSeedData, catalog_patch: _catalogPatch, ...plan }) => plan),
  };
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => null);
    });
}

module.exports = {
  CONFIRM_TOKEN,
  PATCH_VERSION,
  buildMarker,
  patchSeedData,
  validatePlan,
  _internals: {
    buildCatalogPatch,
    buildPlans,
    normalizeEntry,
    sourceHostMatchesRow,
  },
};
