'use strict';

// Durable revert manifests for the relationship-graph one-off ops (rescore, fan-in trim).
//
// The ops run inside a Cloud Run job whose /tmp vanishes with the container, so a manifest written
// there cannot be read back for --revert. Nothing better is available to the job: the job service
// account (sa-worker) holds no storage role at project or bucket level, there is no ops bucket,
// and @google-cloud/storage is not a dependency (checked 2026-09-27, read-only). What IS available
// is relationship_graph_routine_runs (migration 054), the ledger created because "Railway cron
// logs and /tmp artifacts are ephemeral", with a free-form `summary JSONB`. Manifests live there:
//
//   run_id = <run>            header: options, totals, sha256, ops_status (running|passed|failed)
//   run_id = <run>:p<N>       the PLAN, written BEFORE the first write: every row's before-values
//   run_id = <run>:b<N>       one row PER APPLIED BATCH, written in the same transaction as the
//                             batch's UPDATE, so a mid-run failure leaves exactly the batches that
//                             landed, each revertible. Every applied row also carries its
//                             before-values in its own provenance (see the scripts), so a revert
//                             works even without the ledger.
//
// Rows use run_kind 'routine', trigger 'relgraph_ops:<kind>' and status 'skipped': every ledger
// reader (noop audit, run report) filters on status = 'passed', so manifest rows never count as
// routine runs. The manifest carries ids, states and scores only — never product text.
//
// Fallback, in addition: the batch rows are also emitted to stdout as chunked zlib+base64 lines
// (RELGRAPH_OPS_MANIFEST <run> <i>/<n> <b64>) so Cloud Logging holds a second copy;
// decodeManifestLogLines rebuilds a file --revert-file can read.

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const LEDGER_TABLE = 'relationship_graph_routine_runs';
const MANIFEST_RUN_KIND = 'routine';
const MANIFEST_STATUS = 'skipped';
const LOG_LINE_PREFIX = 'RELGRAPH_OPS_MANIFEST';
const LOG_CHUNK_CHARS = 30000;

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim();
  return text.length > max ? text.slice(0, max) : text;
}

function stableJson(value) {
  return JSON.stringify(value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function manifestRunId(kind, now = new Date()) {
  const stamp = new Date(now).toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15);
  return `relgraph-${normalizeString(kind, 40)}-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function batchRunId(runId, batchIndex) {
  return `${runId}:b${String(batchIndex).padStart(5, '0')}`;
}

function planRunId(runId, chunkIndex) {
  return `${runId}:p${String(chunkIndex).padStart(5, '0')}`;
}

// The full plan (before-values of every row the run intends to touch), in chunks, BEFORE any write.
async function writeManifestPlan({ queryFn, runId, kind, market = 'US', rows = [], chunkSize = 1000, now = new Date() } = {}) {
  let chunks = 0;
  for (let idx = 0; idx < rows.length; idx += chunkSize) {
    chunks += 1;
    // eslint-disable-next-line no-await-in-loop
    await queryFn(
      `
        INSERT INTO ${LEDGER_TABLE} (run_id, run_kind, trigger, parent_run_id, market, status, dry_run, summary, generated_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, false, $7::jsonb, $8::timestamptz, now())
        ON CONFLICT (run_id) DO UPDATE SET summary = EXCLUDED.summary, updated_at = now()
      `,
      [planRunId(runId, chunks), MANIFEST_RUN_KIND, `relgraph_ops:${normalizeString(kind, 40)}`, runId, normalizeString(market, 24) || 'US', MANIFEST_STATUS,
        stableJson({ manifest: 'plan', kind, chunk_index: chunks, rows: rows.slice(idx, idx + chunkSize) }), new Date(now).toISOString()],
    );
  }
  return chunks;
}

// Header row. Idempotent on run_id.
async function writeManifestHeader({ queryFn, runId, kind, market = 'US', dryRun = true, options = {}, now = new Date() } = {}) {
  await queryFn(
    `
      INSERT INTO ${LEDGER_TABLE} (run_id, run_kind, trigger, market, status, dry_run, summary, generated_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, now())
      ON CONFLICT (run_id) DO UPDATE SET summary = EXCLUDED.summary, dry_run = EXCLUDED.dry_run, updated_at = now()
    `,
    [runId, MANIFEST_RUN_KIND, `relgraph_ops:${normalizeString(kind, 40)}`, normalizeString(market, 24) || 'US', MANIFEST_STATUS, Boolean(dryRun),
      stableJson({ manifest: 'header', kind, ops_status: 'running', options, batches_written: 0, rows: 0, sha256: null }), new Date(now).toISOString()],
  );
}

// One batch row, meant to be called INSIDE the batch's transaction (pass the client's query).
async function writeManifestBatch({ queryFn, runId, kind, market = 'US', batchIndex, rows = [], now = new Date() } = {}) {
  await queryFn(
    `
      INSERT INTO ${LEDGER_TABLE} (run_id, run_kind, trigger, parent_run_id, market, status, dry_run, applied_count, summary, generated_at, completed_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8::jsonb, $9::timestamptz, $9::timestamptz, now())
      ON CONFLICT (run_id) DO UPDATE SET summary = EXCLUDED.summary, applied_count = EXCLUDED.applied_count, completed_at = EXCLUDED.completed_at, updated_at = now()
    `,
    [batchRunId(runId, batchIndex), MANIFEST_RUN_KIND, `relgraph_ops:${normalizeString(kind, 40)}`, runId, normalizeString(market, 24) || 'US', MANIFEST_STATUS,
      rows.length, stableJson({ manifest: 'batch', kind, batch_index: batchIndex, rows }), new Date(now).toISOString()],
  );
}

// Finalise the header with totals, sha256 over the batch rows (in batch order) and the outcome.
async function finalizeManifestHeader({ queryFn, runId, kind, opsStatus, batchesWritten = 0, rows = 0, sha256: digest = null, error = null, options = {}, now = new Date() } = {}) {
  await queryFn(
    `
      UPDATE ${LEDGER_TABLE}
      SET summary = $2::jsonb, applied_count = $3, completed_at = $4::timestamptz, updated_at = now()
      WHERE run_id = $1
    `,
    [runId, stableJson({ manifest: 'header', kind, ops_status: opsStatus, options, batches_written: batchesWritten, rows, sha256: digest, error: error ? normalizeString(error, 2000) : null }), rows, new Date(now).toISOString()],
  );
}

// Read a manifest back: header summary, the plan rows, and the APPLIED batch rows in batch order.
// `rows` are the applied rows (what a revert must touch); `plan_rows` is what the run intended.
async function readManifest({ queryFn, runId } = {}) {
  const res = await queryFn(
    `
      SELECT run_id, parent_run_id, summary
      FROM ${LEDGER_TABLE}
      WHERE run_id = $1 OR parent_run_id = $1
      ORDER BY run_id
    `,
    [runId],
  );
  const rows = Array.isArray(res && res.rows) ? res.rows : [];
  const header = rows.find((row) => row.run_id === runId);
  const parse = (row) => (typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary || {});
  const children = rows.filter((row) => row.parent_run_id === runId).map(parse);
  const batches = children.filter((c) => c.manifest === 'batch').sort((a, b) => Number(a.batch_index || 0) - Number(b.batch_index || 0));
  const plan = children.filter((c) => c.manifest === 'plan').sort((a, b) => Number(a.chunk_index || 0) - Number(b.chunk_index || 0));
  const manifestRows = batches.flatMap((batch) => (Array.isArray(batch.rows) ? batch.rows : []));
  return {
    run_id: runId,
    header: header ? parse(header) : null,
    batches: batches.length,
    plan_chunks: plan.length,
    plan_rows: plan.flatMap((chunk) => (Array.isArray(chunk.rows) ? chunk.rows : [])),
    rows: manifestRows,
    sha256: sha256(stableJson(manifestRows)),
  };
}

// Incremental digest helper: sha256 over the JSON of all batch rows in order.
function createManifestDigest() {
  const all = [];
  return {
    add(rows) { all.push(...rows); },
    rows() { return all.length; },
    digest() { return sha256(stableJson(all)); },
    all() { return all; },
  };
}

// Log fallback: chunked zlib+base64 lines for one batch (ids, states, scores only).
function manifestLogLines(runId, batchIndex, rows) {
  const b64 = zlib.gzipSync(Buffer.from(stableJson({ run_id: runId, batch_index: batchIndex, rows })), { level: 9 }).toString('base64');
  const n = Math.ceil(b64.length / LOG_CHUNK_CHARS) || 1;
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(`${LOG_LINE_PREFIX} ${runId} b${batchIndex} ${i + 1}/${n} ${b64.slice(i * LOG_CHUNK_CHARS, (i + 1) * LOG_CHUNK_CHARS)}`);
  }
  return lines;
}

// Rebuild batches from captured log lines (any order). Returns { run_id, rows, batches }.
function decodeManifestLogLines(lines = [], runId = null) {
  const chunks = new Map();
  for (const raw of lines) {
    const m = String(raw).match(/RELGRAPH_OPS_MANIFEST (\S+) b(\d+) (\d+)\/(\d+) (\S+)/);
    if (!m) continue;
    if (runId && m[1] !== runId) continue;
    const key = `${m[1]}|${m[2]}`;
    if (!chunks.has(key)) chunks.set(key, { run_id: m[1], batch_index: Number(m[2]), total: Number(m[4]), parts: new Map() });
    chunks.get(key).parts.set(Number(m[3]), m[5]);
  }
  const batches = [];
  for (const chunk of chunks.values()) {
    if (chunk.parts.size !== chunk.total) continue;
    const b64 = Array.from({ length: chunk.total }, (_, i) => chunk.parts.get(i + 1)).join('');
    const payload = JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'));
    batches.push(payload);
  }
  batches.sort((a, b) => a.batch_index - b.batch_index);
  return { run_id: runId || (batches[0] && batches[0].run_id) || null, batches: batches.length, rows: batches.flatMap((b) => b.rows || []) };
}

module.exports = {
  LEDGER_TABLE,
  LOG_LINE_PREFIX,
  MANIFEST_STATUS,
  batchRunId,
  createManifestDigest,
  decodeManifestLogLines,
  finalizeManifestHeader,
  manifestLogLines,
  manifestRunId,
  planRunId,
  readManifest,
  writeManifestPlan,
  sha256,
  writeManifestBatch,
  writeManifestHeader,
};
