#!/usr/bin/env node
'use strict';

// Read-only operator tool. Default stdout contains aggregate counts only. The optional
// private IDs-only manifest is written inside the worker for the backend validator handoff.
const fs = require('node:fs');
const { normalizeOptions, queryParams, auditQueryParams, freshnessAuditSql, refreshPlanSql, aggregateAudit,
  buildRefreshManifest } = require('../src/services/relationshipGraphFreshness');
const { scanServingLabels } = require('../src/services/relationshipGraphServingScan');

function parseArgs(argv = process.argv.slice(2)) {
  const allowed = new Set(['--market', '--limit', '--selected-file', '--manifest-out']);
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('invalid_freshness_arguments');
    values[argv[i]] = argv[i + 1];
  }
  const selectedProductKeys = values['--selected-file'] ? JSON.parse(fs.readFileSync(values['--selected-file'], 'utf8')) : [];
  return { ...normalizeOptions({ market: values['--market'] || 'US', limit: values['--limit'] || 50,
    selectedProductKeys }), manifestOut: values['--manifest-out'] || null };
}

async function run({ options = parseArgs(), client, scanFn = scanServingLabels,
  writeManifest = (file, manifest) => fs.writeFileSync(file, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' }) } = {}) {
  const normalized = normalizeOptions(options);
  const queryFn = client.query.bind(client);
  await queryFn('BEGIN TRANSACTION READ ONLY');
  try {
    await queryFn("SET LOCAL statement_timeout = '30s'");
    const audit = await queryFn(freshnessAuditSql(), auditQueryParams(normalized));
    const summary = { schema: 'relgraph.freshness_audit.v1', market: normalized.market,
      currency: normalized.currency, dry_run: true, ...aggregateAudit(audit.rows?.[0]) };
    let manifest;
    if (options.manifestOut) {
      const { suppressedIds } = await scanFn({ queryFn, market: normalized.market,
        collectSuppressedIds: true, queryRetries: 0 });
      const plan = await queryFn(refreshPlanSql(), queryParams(normalized, suppressedIds));
      manifest = buildRefreshManifest(plan.rows || [], normalized);
      summary.refresh_products = manifest.product_keys.length;
    }
    await queryFn('COMMIT');
    // Do not leave a partial manifest from a failed DB read. Never overwrite an old worklist.
    if (manifest) writeManifest(options.manifestOut, manifest);
    return summary;
  } catch (error) {
    try { await queryFn('ROLLBACK'); } catch (_) { /* Preserve the initial failure. */ }
    throw error;
  }
}

if (require.main === module) {
  (async () => {
    const options = parseArgs();
    const { getPool, closePool } = require('../src/db');
    const pool = getPool();
    if (!pool) throw new Error('freshness_database_not_configured');
    const client = await pool.connect();
    try { process.stdout.write(`RELGRAPH_FRESHNESS ${JSON.stringify(await run({ options, client }))}\n`); }
    finally { client.release(); await closePool(); }
  })().catch(() => {
    // Errors can contain SQL parameters, URLs or credentials; omit raw driver messages.
    process.stderr.write('RELGRAPH_FRESHNESS failed; no refresh was executed\n'); process.exitCode = 1;
  });
}

module.exports = { parseArgs, run };
