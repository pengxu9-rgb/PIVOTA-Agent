#!/usr/bin/env node
/**
 * Extract structured size_fit_chart from raw text in catalog_products.size_guide.
 *
 * Discovery: catalog_products where size_guide has `raw` text but no `columns`.
 * For each row, send raw + title + category_path to the LLM and ask it to parse
 * the text into a {columns, rows} table. Validate shape. Output a mapping JSON
 * consumed by apply-fashion-size-fit-chart.cjs.
 *
 * Dry-run by default; `--write` enabled writes are done through the applier.
 */

const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');

const { closePool, query } = require('../src/db');
const { createProviderFromEnv } = require('../src/llm/provider');

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

const RowSchema = z.object({
  label: z.string().min(1).max(40),
  values: z.array(z.string().min(1).max(80)).min(1).max(10),
  stock: z.enum(['in', 'low', 'out']).optional(),
});

const ChartSchema = z.object({
  columns: z.array(z.string().min(1).max(40)).max(10).default([]),
  rows: z.array(RowSchema).max(20).default([]),
  tip: z.string().max(280).optional().default(''),
  note: z.string().max(280).optional().default(''),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  reasoning: z.string().max(300).optional().default(''),
});

const INSTRUCTIONS = `You convert a raw fit-guide text into a structured size chart.

Rules:
- "columns" is the list of measurement axes (e.g. ["Weight (kg)", "Weight (lb)", "Chest (in)"]).
  Use clear human-readable labels with units in parentheses.
- "rows" is one entry per size: { label: "M", values: ["40-60", "88-132", ...] }.
  "values" order MUST match "columns" order. Strip the size label (e.g. "M -") from each value.
- All rows MUST have exactly the same number of values as columns. If any row would be
  inconsistent, return rows: [] and confidence: "low".
- Do NOT invent values not present in the source text.
- If the text is too unstructured (no clear table-like data, just paragraphs of advice),
  return rows: [] and confidence: "low" with a brief reasoning.
- "tip" can carry the most useful single-sentence advice (e.g. "Between sizes? Size up.").
- "note" can carry a measurement note (e.g. "Lay flat to measure"). Keep both short.

Return JSON: { columns: [...], rows: [...], tip?, note?, confidence: "high|medium|low", reasoning: "<=1 sentence" }.`;

async function callLlm(provider, { title, category, rawText }) {
  const prompt = [
    INSTRUCTIONS,
    '',
    `Product title: ${title}`,
    category ? `Category: ${category}` : null,
    '',
    'Raw fit-guide text:',
    asString(rawText).slice(0, 2500),
  ].filter(Boolean).join('\n');
  try {
    const result = await provider.analyzeTextToJson({ prompt, schema: ChartSchema });
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function loadCandidates({ limit, productKeys, market }) {
  const filters = [
    `sync_status = 'live'`,
    `size_guide ? 'raw'`,
    `NOT (size_guide ? 'columns')`,
    `length(size_guide->>'raw') >= 40`,
  ];
  const params = [];
  if (productKeys && productKeys.length) {
    params.push(productKeys);
    filters.push(`product_key = ANY($${params.length}::text[])`);
  }
  const limitClause = Number.isFinite(limit) && limit > 0 ? `LIMIT ${Math.min(limit, 500)}` : '';
  const sql = `
    SELECT product_key, merchant_id, title, brand, category_path,
           size_guide->>'raw' AS raw_text
    FROM catalog_products
    WHERE ${filters.join(' AND ')}
    ORDER BY updated_at DESC NULLS LAST
    ${limitClause}
  `;
  const res = await query(sql, params);
  return res.rows || [];
}

function validateChart(parsed) {
  if (!parsed || !Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) {
    return { valid: false, reason: 'missing_columns_or_rows' };
  }
  if (parsed.columns.length < 1) return { valid: false, reason: 'no_columns' };
  if (parsed.rows.length < 2) return { valid: false, reason: 'too_few_rows' };
  for (const row of parsed.rows) {
    if (!Array.isArray(row.values)) return { valid: false, reason: 'row_values_not_array' };
    if (row.values.length !== parsed.columns.length) {
      return { valid: false, reason: 'row_column_count_mismatch' };
    }
  }
  return { valid: true };
}

async function processCandidate({ candidate, provider, confidenceFloor }) {
  const llmResult = await callLlm(provider, {
    title: candidate.title,
    category: Array.isArray(candidate.category_path)
      ? candidate.category_path.join(' / ')
      : (candidate.category_path || ''),
    rawText: candidate.raw_text,
  });
  if (!llmResult.ok) {
    return {
      product_key: candidate.product_key,
      title: candidate.title,
      status: 'llm_failed',
      error: llmResult.error,
    };
  }
  const { columns, rows, tip, note, confidence, reasoning } = llmResult.data;
  const validation = validateChart({ columns, rows });
  if (!validation.valid) {
    return {
      product_key: candidate.product_key,
      title: candidate.title,
      status: `invalid_${validation.reason}`,
      confidence,
      reasoning,
    };
  }
  if (confidence === 'low' && confidenceFloor !== 'low') {
    return {
      product_key: candidate.product_key,
      title: candidate.title,
      status: 'confidence_below_floor',
      confidence,
      reasoning,
    };
  }
  return {
    product_key: candidate.product_key,
    title: candidate.title,
    status: 'ready',
    confidence,
    reasoning,
    chart: {
      columns,
      rows,
      ...(tip ? { tip } : {}),
      ...(note ? { note } : {}),
    },
  };
}

async function main() {
  const limit = Number(argValue('limit', '0')) || 0;
  const market = asString(argValue('market'));
  const idsArg = asString(argValue('product-key'));
  const productKeys = idsArg ? idsArg.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const out = asString(argValue('out')) || path.resolve(
    process.cwd(),
    'tmp/fashion-size-fit-chart-mapping.json',
  );
  const reportPath = asString(argValue('report')) || path.resolve(
    process.cwd(),
    'tmp/fashion-size-fit-chart-extraction-report.json',
  );
  const confidenceFloor = asString(argValue('confidence-floor', 'medium')).toLowerCase();
  const concurrency = Math.max(1, Number(argValue('concurrency', '4')) || 4);
  const verbose = hasFlag('verbose');

  const provider = createProviderFromEnv('generic');
  if (typeof provider?.analyzeTextToJson !== 'function') {
    throw new Error('LLM provider does not expose analyzeTextToJson');
  }

  const candidates = await loadCandidates({ limit, productKeys, market });
  process.stderr.write(`Loaded ${candidates.length} size_guide raw candidates.\n`);

  const results = [];
  let processed = 0;
  const queue = [...candidates];
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const candidate = queue.shift();
      if (!candidate) return;
      const result = await processCandidate({ candidate, provider, confidenceFloor });
      results.push(result);
      processed += 1;
      if (verbose || processed % 10 === 0) {
        process.stderr.write(
          `[${processed}/${candidates.length}] ${candidate.product_key.slice(0, 60)} → ${result.status} (${result.confidence || '-'})\n`,
        );
      }
    }
  });
  await Promise.all(workers);

  const ready = results.filter((r) => r.status === 'ready');
  const mappings = ready.map((r) => ({
    product_key: r.product_key,
    chart: r.chart,
    evidence_source: 'llm_extraction_v1',
    evidence_note: `extracted via llm, confidence=${r.confidence}; ${r.reasoning || ''}`.trim(),
    confidence: r.confidence,
  }));
  const summary = {
    generated_at: new Date().toISOString(),
    candidates: results.length,
    ready: ready.length,
    invalid_shape: results.filter((r) => r.status?.startsWith('invalid_')).length,
    confidence_below_floor: results.filter((r) => r.status === 'confidence_below_floor').length,
    llm_failed: results.filter((r) => r.status === 'llm_failed').length,
    confidence_high: results.filter((r) => r.confidence === 'high').length,
    confidence_medium: results.filter((r) => r.confidence === 'medium').length,
    confidence_low: results.filter((r) => r.confidence === 'low').length,
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ mappings }, null, 2));
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({ summary, results }, null, 2));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main()
  .catch((err) => {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: err?.message || String(err), stack: err?.stack }, null, 2)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
