#!/usr/bin/env node

const fs = require('node:fs');
const {
  fetchRows,
} = require('./backfill-external-product-seeds-catalog');
const { summarizeAuditResults } = require('../src/services/externalSeedContentAudit');
const {
  createExternalSeedAuditRun,
  recordExternalSeedAuditFindings,
  recordExternalSeedCorrection,
} = require('../src/services/externalSeedAuditLedger');
const { buildSeedCorrectionPlan, runSeedCorrectionCycle } = require('../src/services/externalSeedCorrection');

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function collectSeedIdsFromValue(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectSeedIdsFromValue(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;

  const seedId = normalizeNonEmptyString(value.seed_id || value.seedId || value.id);
  if (/^eps_/i.test(seedId)) out.push(seedId);

  for (const key of ['findings', 'rows', 'items', 'data']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) collectSeedIdsFromValue(value[key], out);
  }
  return out;
}

function readSeedIdFile(filePath) {
  const normalizedPath = normalizeNonEmptyString(filePath);
  if (!normalizedPath) return [];

  const raw = fs.readFileSync(normalizedPath, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const ids = [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      collectSeedIdsFromValue(JSON.parse(trimmed), ids);
    } catch {
      // Fall back to line parsing below for JSONL or mixed text files.
    }
  }

  if (ids.length === 0) {
    for (const line of raw.split(/\r?\n/)) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      if (trimmedLine.startsWith('{')) {
        try {
          collectSeedIdsFromValue(JSON.parse(trimmedLine), ids);
          continue;
        } catch {
          // Treat malformed lines as plain seed ids.
        }
      }
      const match = trimmedLine.match(/\beps_[A-Za-z0-9_-]+\b/);
      if (match) ids.push(match[0]);
    }
  }

  return Array.from(new Set(ids));
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const current = next++;
      if (current >= items.length) break;
      results[current] = await fn(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

function correctionStatusFromAction(actionResult) {
  if (!actionResult) return 'skipped';
  if (actionResult.process_result?.status === 'failed') return 'failed';
  if (actionResult.dry_run || actionResult.process_result?.status === 'dry_run') return 'dry_run';
  if (actionResult.changed) return 'applied';
  return 'skipped';
}

async function main() {
  const limit = Math.max(1, Math.min(Number(argValue('limit') || 50), 1000));
  const offset = Math.max(0, Number(argValue('offset') || 0));
  const concurrency = Math.max(1, Math.min(Number(argValue('concurrency') || 2), 10));
  const seedIdFile = argValue('seed-id-file') || argValue('seedIdFile') || null;
  const seedIds = readSeedIdFile(seedIdFile);
  const options = {
    seedId: argValue('seed-id') || argValue('seedId') || null,
    seedIds,
    seedIdFile,
    externalProductId: argValue('external-product-id') || argValue('externalProductId') || null,
    domain: argValue('domain') || null,
    brand: argValue('brand') || null,
    market: normalizeNonEmptyString(argValue('market') || 'US').toUpperCase(),
    limit,
    offset,
    concurrency,
    dryRun: hasFlag('dry-run') || hasFlag('dryRun'),
    persistRun: !hasFlag('no-ledger'),
    baseUrl:
      normalizeNonEmptyString(argValue('base-url') || argValue('baseUrl')) ||
      process.env.CATALOG_INTELLIGENCE_BASE_URL ||
      'https://pivota-catalog-intelligence-production.up.railway.app',
  };

  const rows = await fetchRows(options);
  const initialResults = rows.map((row) => ({
    row,
    plan: buildSeedCorrectionPlan(row),
  }));
  const initialAuditPayload = initialResults.map((item) => ({ row: item.row, findings: item.plan.findings }));
  const initialSummary = summarizeAuditResults(initialAuditPayload);

  let initialAuditRunId = null;
  if (options.persistRun) {
    initialAuditRunId = await createExternalSeedAuditRun({
      stage: 'initial',
      market: options.market,
      filters: {
        seed_id: options.seedId,
        seed_id_file: options.seedIdFile,
        seed_ids_count: options.seedIds.length,
        external_product_id: options.externalProductId,
        domain: options.domain,
        brand: options.brand,
        limit: options.limit,
        offset: options.offset,
      },
      summary: initialSummary,
    });
    await recordExternalSeedAuditFindings(
      initialAuditRunId,
      initialAuditPayload.flatMap((item) => item.findings || []),
    );
  }

  const corrected = await mapWithConcurrency(rows, concurrency, async (row) =>
    runSeedCorrectionCycle(row, { baseUrl: options.baseUrl, dryRun: options.dryRun }),
  );

  if (options.persistRun) {
    for (const [index, result] of corrected.entries()) {
      const row = rows[index];
      const actions = Array.isArray(result?.actions) ? result.actions : [];
      for (const action of actions) {
        await recordExternalSeedCorrection({
          seedId: row.id,
          auditRunId: initialAuditRunId,
          correctionType: action.correction_type,
          status: correctionStatusFromAction(action),
          autoApplied: true,
          beforePayload: action.before || row,
          afterPayload: action.after || action.row || row,
          error:
            action.process_result?.error?.message ||
            action.process_result?.error ||
            null,
        });
      }
    }
  }

  const finalAuditResults = corrected.map((result, index) => ({
    row: result?.row || rows[index],
    findings: result?.finalAudit?.findings || result?.initialAudit?.findings || [],
  }));
  const finalSummary = summarizeAuditResults(finalAuditResults);

  let postCorrectionAuditRunId = null;
  if (options.persistRun) {
    postCorrectionAuditRunId = await createExternalSeedAuditRun({
      stage: 'post_correction',
      market: options.market,
      filters: {
        seed_id: options.seedId,
        seed_id_file: options.seedIdFile,
        seed_ids_count: options.seedIds.length,
        external_product_id: options.externalProductId,
        domain: options.domain,
        brand: options.brand,
        limit: options.limit,
        offset: options.offset,
      },
      summary: finalSummary,
    });
    await recordExternalSeedAuditFindings(
      postCorrectionAuditRunId,
      finalAuditResults.flatMap((result) => result.findings || []),
    );
  }

  const summary = {
    scanned: rows.length,
    dry_run: options.dryRun,
    initial_audit_run_id: initialAuditRunId,
    post_correction_audit_run_id: postCorrectionAuditRunId,
    corrections_applied: corrected.reduce(
      (sum, result) => sum + (result?.actions || []).filter((action) => correctionStatusFromAction(action) === 'applied').length,
      0,
    ),
    corrections_failed: corrected.reduce(
      (sum, result) => sum + (result?.actions || []).filter((action) => correctionStatusFromAction(action) === 'failed').length,
      0,
    ),
    corrections_dry_run: corrected.reduce(
      (sum, result) => sum + (result?.actions || []).filter((action) => correctionStatusFromAction(action) === 'dry_run').length,
      0,
    ),
    initial_summary: initialSummary,
    final_summary: finalSummary,
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  mapWithConcurrency,
  correctionStatusFromAction,
  readSeedIdFile,
  collectSeedIdsFromValue,
};
