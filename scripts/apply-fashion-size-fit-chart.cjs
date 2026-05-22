#!/usr/bin/env node
/**
 * Apply size_fit_chart structured-shape mappings to catalog_products.size_guide.
 *
 * Reads a mapping JSON produced by extract-fashion-size-fit-chart-llm.cjs (or by
 * apply-codex-fashion-size-fit-chart-corrections.cjs after codex review):
 *   { mappings: [{ product_key, chart: {columns, rows, tip?, note?}, evidence_source, evidence_note, confidence }] }
 *
 * Preserves the original `raw` text as `size_guide.raw` alongside the new
 * structured fields so we don't lose the source. Updates `size_guide_source`
 * and `size_guide_confidence` columns to reflect the LLM origin.
 *
 * Dry-run by default. `--write` performs the UPDATEs inside one transaction.
 */

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query, withClient } = require('../src/db');

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(v) {
  return String(v || '').trim();
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function asObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function confidenceToScore(confidence) {
  switch (asString(confidence).toLowerCase()) {
    case 'high': return 0.9;
    case 'medium': return 0.65;
    case 'low': return 0.4;
    default: return 0.5;
  }
}

function buildNextSizeGuide(currentSizeGuide, mapping) {
  const current = asObject(currentSizeGuide);
  const chart = asObject(mapping.chart);
  const columns = asArray(chart.columns);
  const rows = asArray(chart.rows);
  if (columns.length === 0 || rows.length === 0) return null;
  // preserve raw text + add structured fields
  return {
    ...current,
    columns,
    rows,
    ...(asString(chart.tip) ? { tip: asString(chart.tip) } : {}),
    ...(asString(chart.note) ? { note: asString(chart.note) } : {}),
    structured_source: 'llm_extraction_v1',
    structured_confidence: asString(mapping.confidence) || 'medium',
    structured_evidence_note: asString(mapping.evidence_note),
    structured_extracted_at: new Date().toISOString(),
  };
}

async function loadCurrentSizeGuides(productKeys) {
  if (!productKeys.length) return new Map();
  const res = await query(
    `SELECT product_key, size_guide
       FROM catalog_products
      WHERE product_key = ANY($1::text[])`,
    [productKeys],
  );
  return new Map((res.rows || []).map((row) => [row.product_key, row.size_guide]));
}

async function main() {
  const mappingPath = asString(argValue('mapping-json'))
    || path.resolve(process.cwd(), 'tmp/fashion-size-fit-chart-mapping.json');
  const out = asString(argValue('out'))
    || path.resolve(process.cwd(), 'tmp/fashion-size-fit-chart-applier-report.json');
  const write = hasFlag('write');
  const generatedAt = new Date().toISOString();

  const mappingDoc = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
  const mappings = asArray(mappingDoc.mappings);

  if (!mappings.length) {
    process.stdout.write(JSON.stringify({ ok: true, message: 'No mappings to apply' }, null, 2) + '\n');
    return;
  }

  const productKeys = mappings.map((m) => asString(m.product_key)).filter(Boolean);
  const currentMap = await loadCurrentSizeGuides(productKeys);

  const results = [];
  const updates = [];
  for (const mapping of mappings) {
    const pk = asString(mapping.product_key);
    if (!pk) {
      results.push({ status: 'skipped_missing_key' });
      continue;
    }
    if (!currentMap.has(pk)) {
      results.push({ product_key: pk, status: 'parent_not_found' });
      continue;
    }
    const currentSizeGuide = currentMap.get(pk);
    const nextSizeGuide = buildNextSizeGuide(currentSizeGuide, mapping);
    if (!nextSizeGuide) {
      results.push({ product_key: pk, status: 'skipped_invalid_chart' });
      continue;
    }
    const changed = JSON.stringify(currentSizeGuide) !== JSON.stringify(nextSizeGuide);
    results.push({
      product_key: pk,
      status: changed ? (write ? 'pending_apply' : 'dry_run') : 'unchanged',
      columns_count: nextSizeGuide.columns?.length || 0,
      rows_count: nextSizeGuide.rows?.length || 0,
      confidence: asString(mapping.confidence) || 'medium',
    });
    if (changed) {
      updates.push({
        productKey: pk,
        nextSizeGuide,
        confidence: confidenceToScore(mapping.confidence),
      });
    }
  }

  let updatedRows = 0;
  if (write && updates.length) {
    await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        for (const update of updates) {
          const res = await client.query(
            `UPDATE catalog_products
                SET size_guide = $2::jsonb,
                    size_guide_source = 'llm_extraction_v1',
                    size_guide_confidence = $3::real,
                    updated_at = now()
              WHERE product_key = $1
                AND sync_status = 'live'
                AND size_guide IS DISTINCT FROM $2::jsonb`,
            [update.productKey, JSON.stringify(update.nextSizeGuide), update.confidence],
          );
          updatedRows += Number(res.rowCount || 0);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
    for (const r of results) if (r.status === 'pending_apply') r.status = 'updated';
  }

  const summary = {
    dry_run: !write,
    mappings: mappings.length,
    changed_rows: updates.length,
    updated_rows: updatedRows,
    skipped_invalid: results.filter((r) => r.status === 'skipped_invalid_chart').length,
    parent_not_found: results.filter((r) => r.status === 'parent_not_found').length,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ generated_at: generatedAt, summary, results }, null, 2));
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

main()
  .catch((err) => {
    process.stderr.write(
      JSON.stringify({ ok: false, error: err?.message || String(err), stack: err?.stack }, null, 2) + '\n',
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
