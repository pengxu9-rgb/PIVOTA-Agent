#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { query, closePool } = require('../src/db');

const DEFAULT_SEED_FILE = path.join(__dirname, '..', 'data', 'beauty', 'external_seed_product_specs_seed.json');
const SPEC_CONTRACT_VERSION = 'external_seed.reviewed_product_specs.v1';
const SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return '';
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return '';
  return String(value).trim();
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseDelimitedIds(value) {
  return Array.from(
    new Set(
      String(value || '')
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function normalizeTitleTokens(value) {
  return Array.from(
    new Set(
      normalizeText(value)
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 && !['the', 'and', 'with', 'for', 'global'].includes(token)),
    ),
  );
}

function scoreTitleMatch(left, right) {
  const leftTokens = normalizeTitleTokens(left);
  const rightTokens = new Set(normalizeTitleTokens(right));
  if (!leftTokens.length || !rightTokens.size) return 0;
  const shared = leftTokens.filter((token) => rightTokens.has(token)).length;
  return shared / Math.max(1, leftTokens.length);
}

function normalizeSizeUnitSpacing(value) {
  return normalizeText(value)
    .replace(/(\d)(m\s*l|ml)\b/gi, '$1 mL')
    .replace(/(\d)(fl\.?\s*oz)\b/gi, '$1 $2')
    .replace(/(\d)(g|kg|oz|pads?|sheets?|masks?|pcs?|pieces?|count|ct)\b/gi, '$1 $2')
    .replace(/\bml\b/gi, 'mL')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isValidSpecValue(value) {
  const text = normalizeSizeUnitSpacing(value);
  if (!text) return false;
  if (/^(?:default|default title|single|one size|n\/a)$/i.test(text)) return false;
  return /(?:^|[^\d])\d+(?:\.\d+)?\s*(?:mL|fl\.?\s*oz|oz|g|kg|pads?|sheets?|masks?|pcs?|pieces?|count|ct)\b/i.test(text);
}

function normalizeSpecSources(value) {
  return asArray(value)
    .map((source) => ({
      source_kind: normalizeText(source?.source_kind),
      source_url: normalizeText(source?.source_url),
      evidence: normalizeText(source?.evidence),
    }))
    .filter((source) => source.source_kind && source.source_url);
}

function normalizeSpecEntry(raw) {
  const entry = ensureObject(raw);
  const normalized = {
    external_product_id: normalizeText(entry.external_product_id),
    brand: normalizeText(entry.brand),
    title: normalizeText(entry.title),
    canonical_url: normalizeText(entry.canonical_url),
    size_detail_label: normalizeSizeUnitSpacing(entry.size_detail_label),
    net_content: normalizeSizeUnitSpacing(entry.net_content),
    net_size: normalizeSizeUnitSpacing(entry.net_size),
    review_state: normalizeText(entry.review_state || 'assistant_reviewed'),
    sources: normalizeSpecSources(entry.sources),
  };
  return normalized;
}

function readSpecEntries(seedFile = DEFAULT_SEED_FILE) {
  const parsed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  return asArray(parsed.entries).map(normalizeSpecEntry).filter((entry) => entry.external_product_id);
}

function buildSnapshotContract(existing) {
  return {
    ...ensureObject(existing),
    contract_version: SNAPSHOT_CONTRACT_VERSION,
    source: 'reviewed_product_specs_seed',
    authoritative: true,
    structured_fields_authoritative: true,
    legacy_fields_quarantined: true,
    replace_strategy: 'replace_not_merge',
    updated_at: new Date().toISOString(),
  };
}

function mergeQualitySummary(existing, fields) {
  const next = { ...ensureObject(existing) };
  const now = new Date().toISOString();
  for (const key of fields) {
    next[key] = {
      source_origin: 'reviewed_seed_map',
      source_quality_status: 'high',
      source_kinds: ['reviewed_product_spec'],
      reason_codes: [],
      updated_at: now,
    };
  }
  return next;
}

function buildReviewedSpecContract(entry, fields) {
  return {
    contract_version: SPEC_CONTRACT_VERSION,
    source_origin: 'reviewed_seed_map',
    source_quality_status: 'high',
    review_state: entry.review_state || 'assistant_reviewed',
    fields,
    sources: entry.sources,
    updated_at: new Date().toISOString(),
  };
}

function isReviewedSpecContractFresh(existing, entry, fields) {
  const contract = ensureObject(existing);
  return (
    contract.contract_version === SPEC_CONTRACT_VERSION &&
    contract.source_origin === 'reviewed_seed_map' &&
    contract.source_quality_status === 'high' &&
    JSON.stringify(asArray(contract.fields).sort()) === JSON.stringify([...fields].sort()) &&
    JSON.stringify(normalizeSpecSources(contract.sources)) === JSON.stringify(normalizeSpecSources(entry.sources))
  );
}

function isSnapshotContractFresh(existing) {
  const contract = ensureObject(existing);
  return (
    contract.contract_version === SNAPSHOT_CONTRACT_VERSION &&
    contract.authoritative === true &&
    contract.structured_fields_authoritative === true &&
    contract.legacy_fields_quarantined === true &&
    contract.replace_strategy === 'replace_not_merge'
  );
}

function isQualitySummaryFresh(existing, fields) {
  const quality = ensureObject(existing);
  return fields.every((field) => {
    const item = ensureObject(quality[field]);
    return item.source_origin === 'reviewed_seed_map' && item.source_quality_status === 'high';
  });
}

function validateSpecEntryForRow(entry, row) {
  const reasons = [];
  if (!entry.external_product_id) reasons.push('missing_external_product_id');
  if (!entry.size_detail_label && !entry.net_content && !entry.net_size) reasons.push('missing_spec_values');
  for (const [field, value] of [
    ['size_detail_label', entry.size_detail_label],
    ['net_content', entry.net_content],
    ['net_size', entry.net_size],
  ]) {
    if (value && !isValidSpecValue(value)) reasons.push(`invalid_${field}`);
  }
  if (!entry.sources.length) reasons.push('missing_reviewed_sources');

  const rowTitle = normalizeText(row?.title || row?.seed_data?.title || row?.seed_data?.snapshot?.title);
  if (entry.title && rowTitle && scoreTitleMatch(entry.title, rowTitle) < 0.75) {
    reasons.push('title_mismatch');
  }
  return reasons;
}

function buildSpecBackfillPlanForRow(row, entry) {
  const normalizedEntry = normalizeSpecEntry(entry);
  const validationReasons = validateSpecEntryForRow(normalizedEntry, row);
  if (validationReasons.length > 0) {
    return {
      external_product_id: normalizedEntry.external_product_id || row?.external_product_id || '',
      title: row?.title || normalizedEntry.title || '',
      status: 'blocked',
      changed: false,
      blocking_reasons: validationReasons,
    };
  }

  const seedData = JSON.parse(JSON.stringify(ensureObject(row.seed_data)));
  const snapshot = ensureObject(seedData.snapshot);
  const fields = [];
  let fieldChanged = false;

  const setField = (key, value) => {
    const normalized = normalizeSizeUnitSpacing(value);
    if (!normalized) return;
    if (seedData[key] !== normalized || snapshot[key] !== normalized) fieldChanged = true;
    seedData[key] = normalized;
    snapshot[key] = normalized;
    fields.push(key);
  };

  setField('size_detail_label', normalizedEntry.size_detail_label);
  setField('net_content', normalizedEntry.net_content);
  setField('net_size', normalizedEntry.net_size);

  const existingContract = ensureObject(seedData.reviewed_product_specs_v1 || snapshot.reviewed_product_specs_v1);
  const metadataNeedsRefresh = !isReviewedSpecContractFresh(existingContract, normalizedEntry, fields);
  const snapshotContractNeedsRefresh =
    !isSnapshotContractFresh(seedData.external_seed_snapshot_contract) ||
    !isSnapshotContractFresh(snapshot.external_seed_snapshot_contract);
  const qualityNeedsRefresh = !isQualitySummaryFresh(seedData.pdp_field_quality_summary || snapshot.pdp_field_quality_summary, fields);
  const changed = fieldChanged || metadataNeedsRefresh || snapshotContractNeedsRefresh || qualityNeedsRefresh;

  if (changed) {
    const quality = mergeQualitySummary(seedData.pdp_field_quality_summary || snapshot.pdp_field_quality_summary, fields);
    seedData.pdp_field_quality_summary = quality;
    snapshot.pdp_field_quality_summary = quality;
    const specContract = buildReviewedSpecContract(normalizedEntry, fields);
    seedData.reviewed_product_specs_v1 = specContract;
    snapshot.reviewed_product_specs_v1 = specContract;
    seedData.external_seed_snapshot_contract = buildSnapshotContract(seedData.external_seed_snapshot_contract);
    snapshot.external_seed_snapshot_contract = buildSnapshotContract(snapshot.external_seed_snapshot_contract);
  }
  seedData.snapshot = snapshot;

  return {
    id: row.id,
    external_product_id: row.external_product_id || normalizedEntry.external_product_id,
    title: row.title || normalizedEntry.title,
    brand: row.seed_data?.brand || row.seed_data?.snapshot?.brand || normalizedEntry.brand,
    status: changed ? 'planned' : 'unchanged',
    changed,
    patch_keys: fields,
    size_detail_label: seedData.size_detail_label || '',
    net_content: seedData.net_content || '',
    net_size: seedData.net_size || '',
    source_count: normalizedEntry.sources.length,
    next_seed_data: seedData,
  };
}

function summarizePlans(plans) {
  const summary = {
    scanned: plans.length,
    planned: plans.filter((plan) => plan.status === 'planned').length,
    unchanged: plans.filter((plan) => plan.status === 'unchanged').length,
    blocked: plans.filter((plan) => plan.status === 'blocked').length,
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

async function fetchRowsByExternalIds(ids, market) {
  if (!ids.length) return [];
  const res = await query(
    `
      SELECT id, external_product_id, title, domain, market, canonical_url, destination_url, seed_data
      FROM external_product_seeds
      WHERE external_product_id = ANY($1::text[])
        AND ($2::text = '' OR market = $2::text)
      ORDER BY array_position($1::text[], external_product_id::text)
    `,
    [ids, market],
  );
  return res.rows || [];
}

async function applyPlans(plans) {
  let updated = 0;
  for (const plan of plans) {
    if (!plan.changed || plan.status !== 'planned') continue;
    await query(
      `
        UPDATE external_product_seeds
        SET seed_data = $2::jsonb,
            updated_at = NOW()
        WHERE external_product_id = $1
      `,
      [plan.external_product_id, JSON.stringify(plan.next_seed_data)],
    );
    updated += 1;
  }
  return updated;
}

async function main() {
  const seedFile = normalizeText(argValue('seed-file') || argValue('seedFile') || DEFAULT_SEED_FILE);
  const market = normalizeText(argValue('market') || 'US').toUpperCase();
  const brandFilter = normalizeText(argValue('brand')).toLowerCase();
  const idsFilter = parseDelimitedIds(argValue('external-product-ids') || argValue('externalProductIds'));
  const outPath = normalizeText(argValue('out'));
  const dryRun = hasFlag('dry-run') || hasFlag('dryRun');

  let entries = readSpecEntries(seedFile);
  if (brandFilter) entries = entries.filter((entry) => entry.brand.toLowerCase() === brandFilter);
  if (idsFilter.length) entries = entries.filter((entry) => idsFilter.includes(entry.external_product_id));
  const ids = entries.map((entry) => entry.external_product_id);
  const rows = await fetchRowsByExternalIds(ids, market);
  const rowByExternalId = new Map(rows.map((row) => [row.external_product_id, row]));
  const plans = entries.map((entry) => {
    const row = rowByExternalId.get(entry.external_product_id);
    if (!row) {
      return {
        external_product_id: entry.external_product_id,
        title: entry.title,
        status: 'blocked',
        changed: false,
        blocking_reasons: ['row_not_found'],
      };
    }
    return buildSpecBackfillPlanForRow(row, entry);
  });

  let updated = 0;
  if (!dryRun) updated = await applyPlans(plans);

  const report = {
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    market,
    seed_file: seedFile,
    summary: {
      ...summarizePlans(plans),
      updated,
    },
    plans: plans.map(({ next_seed_data: _nextSeedData, ...plan }) => plan),
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
      if (process.exitCode) process.exit(process.exitCode);
    });
}

module.exports = {
  _internals: {
    normalizeSizeUnitSpacing,
    isValidSpecValue,
    normalizeSpecEntry,
    buildSpecBackfillPlanForRow,
    summarizePlans,
    scoreTitleMatch,
  },
};
