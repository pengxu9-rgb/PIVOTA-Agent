#!/usr/bin/env node
'use strict';

/*
 * Commerce Index v2 -> relationship-graph bridge.
 *
 * It drains only `relation_graph` publication jobs, resolves canonical
 * product_key values into the affected-products manifest the existing graph
 * routine already understands, and marks a batch complete only after that
 * routine succeeds.  Apply mode is deliberately opt-in.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { closePool, query } = require('../src/db');
const { parseArgs, runSyncRoutine } = require('./run-relationship-graph-sync-routine');

const APPLY_ENV = 'COMMERCE_INDEX_RELGRAPH_APPLY';
const CONFIRM_TOKEN = 'APPLY_RELGRAPH_SYNC_ROUTINE';

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function argValue(argv, name, fallback = '') {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : null;
  return value && !value.startsWith('--') ? value : fallback;
}

function numberArg(value, fallback, { min = 1, max = 1000 } = {}) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function productRef(value) {
  const text = String(value || '').trim();
  return !text ? '' : (/^[a-z][a-z0-9_+-]*:/i.test(text) ? text : `product:${text}`);
}

function dedupe(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function buildManifest(rows, { generatedAt = new Date().toISOString() } = {}) {
  const normalized = (rows || []).map((row) => {
    const sourceProductId = String(row.source_product_id || '').trim();
    const signatureId = String(row.pivota_signature_id || '').trim();
    const productKey = String(row.product_key || '').trim();
    const refs = dedupe([
      productRef(signatureId || sourceProductId), productKey, sourceProductId,
      productRef(signatureId), productRef(sourceProductId), row.content_key,
    ]);
    return {
      source: 'commerce_index_v2',
      product_ref: refs[0] || productKey,
      product_refs: refs,
      product_key: productKey,
      source_product_id: sourceProductId,
      pivota_signature_id: signatureId || null,
      sig_id: signatureId || null,
      content_key: row.content_key || null,
      merchant_id: row.merchant_id || null,
      platform: row.platform || null,
      brand: row.brand || null,
      title: row.title || null,
      canonical_url: row.canonical_url || row.pivota_canonical_url || null,
      updated_at: row.updated_at || null,
    };
  }).filter((row) => row.product_key && row.product_ref);
  return {
    generated_at: generatedAt,
    source: 'commerce_index_v2_publication_jobs',
    mode: 'delta',
    affected_count: normalized.length,
    product_keys: dedupe(normalized.map((row) => row.product_key)),
    source_product_ids: dedupe(normalized.map((row) => row.source_product_id)),
    sig_ids: dedupe(normalized.map((row) => row.sig_id)),
    content_keys: dedupe(normalized.map((row) => row.content_key)),
    affected_refs: dedupe(normalized.flatMap((row) => row.product_refs)),
    rows: normalized,
  };
}

async function claimBatch({ workerId, limit }) {
  const result = await query(
    `
      UPDATE commerce_index_publication_jobs
      SET status = 'processing', claimed_by = $1, claimed_at = NOW(),
          lease_until = NOW() + INTERVAL '15 minutes', attempts = attempts + 1,
          updated_at = NOW()
      WHERE job_id IN (
        SELECT job_id FROM commerce_index_publication_jobs
        WHERE target = 'relation_graph'
          AND (status = 'pending' OR (status = 'processing' AND lease_until < NOW()))
        ORDER BY created_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      RETURNING job_id, change_id, merchant_id, scope_json
    `,
    [workerId, limit],
  );
  return result.rows || [];
}

async function finishBatch({ jobIds, workerId, error = null }) {
  if (!jobIds.length) return 0;
  const result = await query(
    `
      UPDATE commerce_index_publication_jobs
      SET status = $3, error_message = $4,
          published_at = CASE WHEN $3 = 'completed' THEN NOW() ELSE NULL END,
          claimed_by = NULL, claimed_at = NULL, lease_until = NULL, updated_at = NOW()
      WHERE job_id = ANY($1::text[]) AND status = 'processing' AND claimed_by = $2
      RETURNING job_id
    `,
    [jobIds, workerId, error ? 'pending' : 'completed', error ? String(error).slice(0, 1000) : null],
  );
  return (result.rows || []).length;
}

async function resolveProducts(productKeys) {
  const result = await query(
    `SELECT product_key, source_product_id, pivota_signature_id, content_key,
            merchant_id, platform, brand, title, canonical_url, pivota_canonical_url, updated_at
       FROM catalog_products
      WHERE product_key = ANY($1::text[])`,
    [productKeys],
  );
  return result.rows || [];
}

async function main(argv = process.argv.slice(2)) {
  if (!enabled(process.env[APPLY_ENV])) {
    throw new Error(`${APPLY_ENV}=true is required; refusing to claim or complete graph publication jobs`);
  }
  const workerId = argValue(argv, 'worker-id', `relgraph-ci-${process.pid}`);
  const limit = numberArg(argValue(argv, 'limit', '50'), 50, { min: 1, max: 500 });
  const jobs = await claimBatch({ workerId, limit });
  if (!jobs.length) return { claimed: 0, completed: 0 };
  const jobIds = jobs.map((job) => job.job_id);
  try {
    const productKeys = dedupe(jobs.map((job) => job.scope_json?.entity_id));
    const products = await resolveProducts(productKeys);
    const manifest = buildManifest(products);
    if (!manifest.affected_count || manifest.affected_count !== productKeys.length) {
      throw new Error(`relation-graph product resolution incomplete: expected=${productKeys.length} resolved=${manifest.affected_count}`);
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-index-relgraph-'));
    const manifestPath = path.join(tempDir, 'affected-products.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const options = parseArgs([
      '--cutoff', new Date().toISOString(),
      '--affected-products-file', manifestPath,
      '--skip-renewal',
      '--apply-build', '--apply-review',
      '--confirm', CONFIRM_TOKEN,
      '--record-run-ledger', '--run-trigger', 'commerce_index_v2',
      '--out-dir', tempDir,
    ]);
    const summary = await runSyncRoutine(options);
    if (!summary?.ok) throw new Error('relation graph routine returned an unsuccessful summary');
    const completed = await finishBatch({ jobIds, workerId });
    return { claimed: jobs.length, completed, manifest_path: manifestPath, graph_run_id: summary.run_id };
  } catch (error) {
    await finishBatch({ jobIds, workerId, error: error?.message || String(error) });
    throw error;
  }
}

if (require.main === module) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; })
    .finally(() => closePool().catch(() => {}));
}

module.exports = { APPLY_ENV, buildManifest, claimBatch, finishBatch, main };
