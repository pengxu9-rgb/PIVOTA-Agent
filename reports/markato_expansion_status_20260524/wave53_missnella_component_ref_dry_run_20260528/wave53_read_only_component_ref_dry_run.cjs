#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

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

function normalizeHost(value) {
  try {
    return new URL(asString(value)).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = asString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeRef(rawRef, row, mapping, generatedAt) {
  return {
    merchant_id: 'external_seed',
    product_id: rawRef.external_product_id,
    external_product_id: rawRef.external_product_id,
    title: asString(rawRef.title) || asString(row.title),
    canonical_url: asString(row.canonical_url),
    destination_url: asString(row.destination_url),
    domain: asString(row.domain),
    component_role: asString(rawRef.component_role),
    size_label: asString(rawRef.size_label || rawRef.size),
    inheritance_scope: uniqueStrings(rawRef.inheritance_scope || ['identity_resolution_only']),
    review_state: 'reviewed',
    source_kind: asString(rawRef.source_kind) || 'wave53_read_only_component_ref_dry_run',
    evidence_note: asString(rawRef.evidence_note || mapping.evidence_note),
    linked_at: generatedAt,
  };
}

function summarizeRef(ref) {
  return {
    external_product_id: ref.external_product_id,
    title: ref.title || null,
    component_role: ref.component_role || null,
    inheritance_scope: ref.inheritance_scope || [],
    status: ref.status || 'ready',
  };
}

async function main() {
  if (!hasFlag('read-only')) {
    throw new Error('Refusing to run without --read-only');
  }
  if (hasFlag('write')) {
    throw new Error('Refusing to run with --write');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const mappingPath = argValue('mapping-json');
  const outPath = argValue('out');
  const market = asString(argValue('market')).toUpperCase();
  if (!mappingPath) throw new Error('--mapping-json is required');
  if (!outPath) throw new Error('--out is required');

  const generatedAt = new Date().toISOString();
  const mappingJson = readJson(mappingPath);
  const mappings = asArray(mappingJson.mappings);
  const allIds = uniqueStrings(
    mappings.flatMap((mapping) => [
      mapping.external_product_id,
      ...asArray(mapping.component_refs || mapping.components).map((ref) => ref.external_product_id || ref.product_id),
    ]),
  );

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 5000,
    ssl: { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
  });

  try {
    const res = await pool.query(
      `
        SELECT external_product_id, title, domain, market, canonical_url, destination_url,
               coalesce(seed_data, '{}'::jsonb) AS seed_data
        FROM external_product_seeds
        WHERE external_product_id = ANY($1::text[])
          AND status = 'active'
          AND ($2::text = '' OR upper(market) = upper($2))
      `,
      [allIds, market],
    );
    const rowsById = new Map((res.rows || []).map((row) => [row.external_product_id, row]));
    const results = [];

    for (const mapping of mappings) {
      const externalProductId = asString(mapping.external_product_id);
      const parentRow = rowsById.get(externalProductId);
      if (!parentRow) {
        results.push({ external_product_id: externalProductId, status: 'blocked_missing_parent_row' });
        continue;
      }

      const parentHost = normalizeHost(parentRow.canonical_url || parentRow.destination_url);
      const refs = [];
      for (const rawRef of asArray(mapping.component_refs || mapping.components)) {
        const componentId = asString(rawRef.external_product_id || rawRef.product_id);
        const componentRow = rowsById.get(componentId);
        if (!componentRow) {
          refs.push({ external_product_id: componentId, status: 'missing_component_row' });
          continue;
        }
        refs.push(normalizeRef({ ...rawRef, external_product_id: componentId }, componentRow, mapping, generatedAt));
      }

      const missingRefs = refs.filter((ref) => ref.status === 'missing_component_row');
      const hostMismatches = refs
        .filter((ref) => ref.status !== 'missing_component_row')
        .filter((ref) => parentHost && normalizeHost(ref.canonical_url || ref.destination_url) !== parentHost);
      if (missingRefs.length || hostMismatches.length) {
        results.push({
          external_product_id: externalProductId,
          title: parentRow.title,
          status: 'blocked_validation_failed',
          missing_component_refs: missingRefs.map(summarizeRef),
          host_mismatches: hostMismatches.map(summarizeRef),
        });
        continue;
      }

      const seedData = asObject(parentRow.seed_data);
      const beforeRefs = asArray(seedData.bundle_component_refs);
      const changed = JSON.stringify(beforeRefs) !== JSON.stringify(refs);
      results.push({
        external_product_id: externalProductId,
        title: parentRow.title,
        status: changed ? 'dry_run' : 'unchanged',
        before_component_ref_count: beforeRefs.length,
        after_component_ref_count: refs.length,
        component_refs: refs.map(summarizeRef),
      });
    }

    const summary = {
      dry_run: true,
      read_only: true,
      write_enabled: false,
      mappings: mappings.length,
      queried_ids: allIds.length,
      fetched_rows: rowsById.size,
      changed_rows: results.filter((result) => result.status === 'dry_run').length,
      unchanged_rows: results.filter((result) => result.status === 'unchanged').length,
      blocked_rows: results.filter((result) => String(result.status || '').startsWith('blocked')).length,
      missing_rows: allIds.length - rowsById.size,
    };
    const report = {
      generated_at: generatedAt,
      source: 'wave53_read_only_component_ref_dry_run',
      mapping_json: mappingPath,
      market,
      summary,
      results,
    };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2)}\n`);
  process.exit(1);
});
