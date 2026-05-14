#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');

const SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';
const INHERITANCE_CONTRACT_VERSION = 'external_seed.reviewed_content_inheritance.v1';
const PDP_CONTENT_ASSET_VERSION = 'pivota.pdp_content_asset.v1';

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

function asArray(value) {
  return Array.isArray(value) ? value : [];
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

function readJsonFile(filePath) {
  const normalized = asString(filePath);
  if (!normalized) throw new Error('--mapping-json is required');
  return JSON.parse(fs.readFileSync(normalized, 'utf8'));
}

function hashContent(value) {
  return crypto.createHash('sha256').update(asString(value)).digest('hex');
}

function normalizeHost(value) {
  try {
    return new URL(asString(value)).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function looksLikeFullInci(value) {
  const text = asString(value);
  if (text.length < 80) return false;
  const items = text.split(',').map((item) => asString(item)).filter(Boolean);
  if (items.length < 8) return false;
  return /\b(?:aqua|water|glycerin|dimethicone|butylene glycol|phenoxyethanol|tocopherol|titanium dioxide|iron oxides?)\b/i.test(text);
}

function readField(seedData, field) {
  const snapshot = asObject(seedData.snapshot);
  return seedData[field] ?? snapshot[field];
}

function readQuality(seedData, key, assetKey = key) {
  const snapshot = asObject(seedData.snapshot);
  const candidates = [
    asObject(seedData.pdp_field_quality_summary)[key],
    asObject(snapshot.pdp_field_quality_summary)[key],
    asObject(asObject(seedData.pdp_content_asset_v1).fields)[assetKey],
    asObject(asObject(snapshot.pdp_content_asset_v1).fields)[assetKey],
  ];
  for (const candidate of candidates) {
    const item = asObject(candidate);
    const status = asString(item.source_quality_status).toLowerCase();
    const origin = asString(item.source_origin).toLowerCase();
    if (status || origin) return { status, origin };
  }
  return { status: '', origin: '' };
}

function isProtectedQuality(quality) {
  return ['high', 'medium', 'authoritative'].includes(quality.status) && quality.origin !== 'pivota_force_fill';
}

function isForceFilledQuality(quality) {
  return quality.status.startsWith('force_filled') || quality.origin === 'pivota_force_fill';
}

function ensureSnapshotContract(seedData, now) {
  const snapshot = asObject(seedData.snapshot);
  const contract = {
    contract_version: SNAPSHOT_CONTRACT_VERSION,
    source: 'reviewed_content_inheritance',
    authoritative: true,
    structured_fields_authoritative: true,
    legacy_fields_quarantined: true,
    replace_strategy: 'replace_not_merge',
    updated_at: now,
  };
  seedData.external_seed_snapshot_contract = {
    ...asObject(seedData.external_seed_snapshot_contract),
    ...contract,
  };
  snapshot.external_seed_snapshot_contract = {
    ...asObject(snapshot.external_seed_snapshot_contract),
    ...contract,
  };
}

function mergeQualitySummary(seedData, fields, mapping, now) {
  const snapshot = asObject(seedData.snapshot);
  const quality = {
    ...asObject(snapshot.pdp_field_quality_summary),
    ...asObject(seedData.pdp_field_quality_summary),
  };
  for (const field of fields) {
    quality[field.quality_key] = {
      source_origin: 'reviewed_component_inheritance',
      source_quality_status: 'high',
      source_kinds: ['official_component_source_pdp'],
      source_external_product_id: mapping.source_external_product_id,
      reason_codes: uniqueStrings(mapping.reason_codes || ['reviewed_component_content_inheritance']),
      updated_at: now,
    };
  }
  seedData.pdp_field_quality_summary = quality;
  snapshot.pdp_field_quality_summary = quality;
}

function mergeContentAsset(seedData, fields, mapping, now) {
  const snapshot = asObject(seedData.snapshot);
  const asset = {
    contract_version: PDP_CONTENT_ASSET_VERSION,
    owner: 'pivota',
    fields: {
      ...asObject(asObject(snapshot.pdp_content_asset_v1).fields),
      ...asObject(asObject(seedData.pdp_content_asset_v1).fields),
    },
  };
  for (const field of fields) {
    asset.fields[field.asset_key] = {
      review_state: 'assistant_reviewed',
      overwrite_policy: 'preserve_best_available',
      source_quality_status: 'high',
      source_origin: 'reviewed_component_inheritance',
      source_kind: 'official_component_source_pdp',
      source_external_product_id: mapping.source_external_product_id,
      content_hash: hashContent(field.value),
      updated_at: now,
    };
  }
  seedData.pdp_content_asset_v1 = asset;
  snapshot.pdp_content_asset_v1 = asset;
}

function mergeDetailsNote(seedData, mapping, sourceRow, now) {
  const snapshot = asObject(seedData.snapshot);
  const existing = asArray(seedData.pdp_details_sections || snapshot.pdp_details_sections);
  const heading = 'Reviewed component source';
  const body = asString(mapping.evidence_note) ||
    `Pivota reviewed this product as a component or refill and uses the official ingredient source from ${asString(sourceRow.title)}.`;
  const next = [
    ...existing.filter((section) => asString(section?.heading || section?.title).toLowerCase() !== heading.toLowerCase()),
    {
      heading,
      body,
      source_origin: 'reviewed_component_inheritance',
      source_external_product_id: mapping.source_external_product_id,
      updated_at: now,
    },
  ].filter((section) => asString(section.body || section.content).length >= 20).slice(0, 8);
  seedData.pdp_details_sections = next;
  snapshot.pdp_details_sections = next;
}

function buildInheritanceContract(mapping, sourceRow, fields, now) {
  return {
    contract_version: INHERITANCE_CONTRACT_VERSION,
    source_origin: 'reviewed_component_inheritance',
    source_quality_status: 'high',
    review_state: 'assistant_reviewed',
    external_product_id: mapping.external_product_id,
    source_external_product_id: mapping.source_external_product_id,
    source_title: asString(sourceRow.title),
    source_canonical_url: asString(sourceRow.canonical_url || sourceRow.destination_url),
    inherited_fields: fields.map((field) => field.seed_field),
    reason_codes: uniqueStrings(mapping.reason_codes || ['reviewed_component_content_inheritance']),
    evidence_note: asString(mapping.evidence_note),
    updated_at: now,
  };
}

function normalizeMapping(raw) {
  const mapping = asObject(raw);
  return {
    external_product_id: asString(mapping.external_product_id),
    source_external_product_id: asString(mapping.source_external_product_id || mapping.parent_external_product_id),
    fields: uniqueStrings(mapping.fields || ['pdp_ingredients_raw']),
    reason_codes: uniqueStrings(mapping.reason_codes || ['reviewed_component_content_inheritance']),
    evidence_note: asString(mapping.evidence_note),
  };
}

async function loadRows(ids, market) {
  const res = await query(
    `
      SELECT id, external_product_id, title, domain, market, canonical_url, destination_url,
             coalesce(seed_data, '{}'::jsonb) AS seed_data
      FROM external_product_seeds
      WHERE external_product_id = ANY($1::text[])
        AND status = 'active'
        AND ($2::text = '' OR upper(market) = upper($2))
    `,
    [ids, asString(market).toUpperCase()],
  );
  return new Map((res.rows || []).map((row) => [row.external_product_id, row]));
}

function buildPlan(mapping, rowsById, now) {
  const childRow = rowsById.get(mapping.external_product_id);
  const sourceRow = rowsById.get(mapping.source_external_product_id);
  const result = {
    external_product_id: mapping.external_product_id,
    source_external_product_id: mapping.source_external_product_id,
    status: 'blocked',
    changed: false,
    blocking_reasons: [],
    inherited_fields: [],
  };
  if (!childRow) result.blocking_reasons.push('missing_child_row');
  if (!sourceRow) result.blocking_reasons.push('missing_source_row');
  if (result.blocking_reasons.length) return { result, nextSeedData: null };

  const childHost = normalizeHost(childRow.canonical_url || childRow.destination_url);
  const sourceHost = normalizeHost(sourceRow.canonical_url || sourceRow.destination_url);
  if (childHost && sourceHost && childHost !== sourceHost) result.blocking_reasons.push('host_mismatch');

  const childSeedData = JSON.parse(JSON.stringify(asObject(childRow.seed_data)));
  childSeedData.snapshot = asObject(childSeedData.snapshot);
  const childSnapshot = asObject(childSeedData.snapshot);
  const sourceSeedData = asObject(sourceRow.seed_data);
  const inheritedFields = [];

  if (mapping.fields.includes('pdp_ingredients_raw')) {
    const sourceValue = asString(readField(sourceSeedData, 'pdp_ingredients_raw') || readField(sourceSeedData, 'raw_ingredient_text_clean'));
    const sourceQuality = readQuality(sourceSeedData, 'ingredients_raw');
    const childQuality = readQuality(childSeedData, 'ingredients_raw');
    const childValue = asString(readField(childSeedData, 'pdp_ingredients_raw') || readField(childSeedData, 'raw_ingredient_text_clean'));
    if (!looksLikeFullInci(sourceValue)) {
      result.blocking_reasons.push('source_ingredients_not_full_inci');
    } else if (isForceFilledQuality(sourceQuality)) {
      result.blocking_reasons.push('source_ingredients_force_filled');
    } else if (!isProtectedQuality(sourceQuality)) {
      result.blocking_reasons.push('source_ingredients_not_quality_gated');
    } else if (isProtectedQuality(childQuality) && !isForceFilledQuality(childQuality)) {
      result.blocking_reasons.push('child_ingredients_already_protected');
    } else if (looksLikeFullInci(childValue) && !isForceFilledQuality(childQuality) && !childQuality.status) {
      result.blocking_reasons.push('child_ingredients_existing_without_quality');
    } else {
      childSeedData.pdp_ingredients_raw = sourceValue;
      childSeedData.raw_ingredient_text_clean = sourceValue;
      childSnapshot.pdp_ingredients_raw = sourceValue;
      childSnapshot.raw_ingredient_text_clean = sourceValue;
      inheritedFields.push({
        seed_field: 'pdp_ingredients_raw',
        quality_key: 'ingredients_raw',
        asset_key: 'ingredients_raw',
        value: sourceValue,
      });
    }
  }

  if (result.blocking_reasons.length) return { result, nextSeedData: null };
  if (!inheritedFields.length) {
    result.status = 'unchanged';
    return { result, nextSeedData: childSeedData };
  }

  mergeQualitySummary(childSeedData, inheritedFields, mapping, now);
  mergeContentAsset(childSeedData, inheritedFields, mapping, now);
  mergeDetailsNote(childSeedData, mapping, sourceRow, now);
  const contract = buildInheritanceContract(mapping, sourceRow, inheritedFields, now);
  childSeedData.reviewed_content_inheritance_v1 = contract;
  childSnapshot.reviewed_content_inheritance_v1 = contract;
  ensureSnapshotContract(childSeedData, now);

  result.status = 'dry_run';
  result.changed = true;
  result.title = asString(childRow.title);
  result.source_title = asString(sourceRow.title);
  result.inherited_fields = inheritedFields.map((field) => field.seed_field);
  result.reason_codes = mapping.reason_codes;
  return { result, nextSeedData: childSeedData };
}

async function main() {
  const mappingPayload = readJsonFile(argValue('mapping-json'));
  const mappings = asArray(mappingPayload.mappings).map(normalizeMapping).filter((item) => item.external_product_id);
  if (!mappings.length) throw new Error('mapping JSON must contain mappings[]');
  const market = asString(argValue('market') || 'US');
  const write = hasFlag('write');
  const out = asString(argValue('out'));
  const now = new Date().toISOString();
  const ids = uniqueStrings(mappings.flatMap((mapping) => [mapping.external_product_id, mapping.source_external_product_id]));
  const rowsById = await loadRows(ids, market);
  const plans = mappings.map((mapping) => buildPlan(mapping, rowsById, now));
  let updatedRows = 0;
  const applyErrors = [];

  if (write) {
    for (const plan of plans) {
      if (!plan.result.changed || !plan.nextSeedData) continue;
      try {
        const res = await query(
          `
            UPDATE external_product_seeds
            SET seed_data = $2::jsonb,
                updated_at = NOW()
            WHERE external_product_id = $1
              AND status = 'active'
              AND seed_data IS DISTINCT FROM $2::jsonb
          `,
          [plan.result.external_product_id, JSON.stringify(plan.nextSeedData)],
        );
        updatedRows += Number(res.rowCount || 0);
        plan.result.status = res.rowCount > 0 ? 'updated' : 'unchanged_after_apply';
      } catch (error) {
        plan.result.status = 'apply_failed';
        plan.result.error = error?.message || String(error);
        applyErrors.push({ external_product_id: plan.result.external_product_id, error: plan.result.error });
      }
    }
  }

  const results = plans.map((plan) => plan.result);
  const summary = {
    dry_run: !write,
    mappings: mappings.length,
    changed_rows: results.filter((row) => row.changed).length,
    updated_rows: updatedRows,
    blocked_rows: results.filter((row) => row.status === 'blocked').length,
    failed_rows: applyErrors.length,
    by_status: results.reduce((acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, {}),
  };
  const report = { generated_at: now, market, summary, apply_errors: applyErrors, results };
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      if (process.exitCode) process.exit(process.exitCode);
    });
}

module.exports = {
  _internals: {
    buildPlan,
    looksLikeFullInci,
    normalizeMapping,
    readQuality,
  },
};
