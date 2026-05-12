#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');

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
  return String(value || '').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sanitizeJsonValue(value) {
  if (typeof value === 'string') return value.replace(/\u0000/g, '').replace(/\\+u0000/gi, '');
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        String(key).replace(/\u0000/g, '').replace(/\\+u0000/gi, ''),
        sanitizeJsonValue(item),
      ]),
    );
  }
  return value;
}

function readJsonFile(filePath) {
  const normalized = asString(filePath);
  if (!normalized) throw new Error('--mapping-json is required');
  return JSON.parse(fs.readFileSync(normalized, 'utf8'));
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

function normalizeHost(value) {
  try {
    return new URL(asString(value)).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function normalizeComponentRefs(mapping, componentRowsById, generatedAt) {
  const refs = [];
  const seen = new Set();
  for (const rawRef of asArray(mapping.component_refs || mapping.components)) {
    const componentId = asString(rawRef.external_product_id || rawRef.product_id);
    if (!componentId || seen.has(componentId)) continue;
    seen.add(componentId);
    const row = componentRowsById.get(componentId);
    if (!row) {
      refs.push({
        external_product_id: componentId,
        status: 'missing_component_row',
      });
      continue;
    }
    const seedData = asObject(row.seed_data);
    const snapshot = asObject(seedData.snapshot);
    refs.push({
      merchant_id: 'external_seed',
      product_id: componentId,
      external_product_id: componentId,
      title: asString(rawRef.title) || asString(row.title) || asString(snapshot.title),
      canonical_url: asString(row.canonical_url) || asString(seedData.canonical_url) || asString(snapshot.canonical_url),
      destination_url:
        asString(row.destination_url) || asString(seedData.destination_url) || asString(snapshot.destination_url),
      domain: asString(row.domain),
      component_role: asString(rawRef.component_role || rawRef.role),
      size_label: asString(rawRef.size_label || rawRef.size),
      inheritance_scope: uniqueStrings(rawRef.inheritance_scope || ['how_to_use', 'ingredients_inci']),
      review_state: 'reviewed',
      source_kind: asString(rawRef.source_kind || rawRef.source) || 'manual_reviewed_bundle_component_ref',
      evidence_note: asString(rawRef.evidence_note || mapping.evidence_note),
      linked_at: generatedAt,
    });
  }
  return refs;
}

async function loadRows(ids, market) {
  const res = await query(
    `
      SELECT *
      FROM external_product_seeds
      WHERE external_product_id = ANY($1::text[])
        AND status = 'active'
        AND ($2::text = '' OR upper(market) = upper($2))
    `,
    [ids, market],
  );
  return new Map((res.rows || []).map((row) => [row.external_product_id, row]));
}

function summarizeRefs(refs) {
  return refs.map((ref) => ({
    external_product_id: ref.external_product_id,
    title: ref.title || null,
    size_label: ref.size_label || null,
    inheritance_scope: ref.inheritance_scope || [],
    status: ref.status || 'ready',
  }));
}

function buildNextSeedData(parentRow, refs, mapping, generatedAt) {
  const seedData = sanitizeJsonValue(JSON.parse(JSON.stringify(asObject(parentRow.seed_data))));
  const snapshot = asObject(seedData.snapshot);
  const contract = {
    contract_version: 'external_seed.bundle_component_refs.v1',
    source: 'manual_reviewed',
    review_state: 'reviewed',
    evidence_source: asString(mapping.evidence_source) || 'operator_review',
    evidence_note: asString(mapping.evidence_note),
    updated_at: generatedAt,
  };
  seedData.bundle_component_refs = refs;
  seedData.bundle_component_ref_contract = contract;
  seedData.snapshot = {
    ...snapshot,
    bundle_component_refs: refs,
    bundle_component_ref_contract: contract,
  };
  return seedData;
}

async function main() {
  const mappingJson = readJsonFile(argValue('mapping-json'));
  const mappings = asArray(mappingJson.mappings);
  const market = asString(argValue('market')).toUpperCase();
  const out = asString(argValue('out'));
  const write = hasFlag('write');
  const generatedAt = new Date().toISOString();
  if (!mappings.length) throw new Error('mapping JSON must contain a mappings array');

  const allIds = uniqueStrings(
    mappings.flatMap((mapping) => [
      mapping.external_product_id,
      ...asArray(mapping.component_refs || mapping.components).map((ref) => ref.external_product_id || ref.product_id),
    ]),
  );
  const rowsById = await loadRows(allIds, market);
  const results = [];
  const updates = [];

  for (const mapping of mappings) {
    const externalProductId = asString(mapping.external_product_id);
    const parentRow = rowsById.get(externalProductId);
    if (!parentRow) {
      results.push({ external_product_id: externalProductId, status: 'skipped_missing_parent' });
      continue;
    }
    const refs = normalizeComponentRefs(mapping, rowsById, generatedAt);
    const missingRefs = refs.filter((ref) => ref.status === 'missing_component_row');
    const parentHost = normalizeHost(parentRow.canonical_url || parentRow.destination_url);
    const hostMismatches = refs
      .filter((ref) => ref.status !== 'missing_component_row')
      .filter((ref) => parentHost && normalizeHost(ref.canonical_url || ref.destination_url) !== parentHost);
    if (missingRefs.length || hostMismatches.length) {
      results.push({
        external_product_id: externalProductId,
        status: 'blocked_validation_failed',
        missing_component_refs: summarizeRefs(missingRefs),
        host_mismatches: summarizeRefs(hostMismatches),
      });
      continue;
    }
    const nextSeedData = buildNextSeedData(parentRow, refs, mapping, generatedAt);
    const beforeRefs = asArray(asObject(parentRow.seed_data).bundle_component_refs);
    const changed = JSON.stringify(beforeRefs) !== JSON.stringify(refs);
    results.push({
      external_product_id: externalProductId,
      title: parentRow.title,
      status: changed ? (write ? 'pending_apply' : 'dry_run') : 'unchanged',
      component_refs: summarizeRefs(refs),
      before_component_ref_count: beforeRefs.length,
      after_component_ref_count: refs.length,
    });
    if (changed) updates.push({ externalProductId, nextSeedData, result: results[results.length - 1] });
  }

  let updatedRows = 0;
  const applyErrors = [];
  if (write && updates.length) {
    for (const update of updates) {
      const payloadJson = JSON.stringify(update.nextSeedData).replace(/\u0000/g, '').replace(/\\+u0000/gi, '');
      try {
        const res = await query(
          `
            UPDATE external_product_seeds
            SET seed_data = $2::jsonb, updated_at = now()
            WHERE external_product_id = $1
              AND status = 'active'
              AND ($3::text = '' OR upper(market) = upper($3))
              AND seed_data IS DISTINCT FROM $2::jsonb
          `,
          [update.externalProductId, payloadJson, market],
        );
        updatedRows += Number(res.rowCount || 0);
        if (res.rowCount > 0) update.result.status = 'updated';
      } catch (err) {
        update.result.status = 'apply_failed';
        update.result.error = err?.message || String(err);
        applyErrors.push({
          external_product_id: update.externalProductId,
          error: err?.message || String(err),
        });
      }
    }
    for (const result of results) {
      if (result.status === 'pending_apply') result.status = 'unchanged_after_apply';
    }
  }

  const summary = {
    dry_run: !write,
    mappings: mappings.length,
    changed_rows: updates.length,
    updated_rows: updatedRows,
    failed_rows: applyErrors.length,
    blocked: results.filter((result) => String(result.status || '').startsWith('blocked')).length,
  };
  const report = { generated_at: generatedAt, summary, apply_errors: applyErrors, results };
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main()
  .catch((err) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
