#!/usr/bin/env node
'use strict';

// READ-ONLY census for rule shade_line_v2 (src/services/shadeLineRule.js).
//
// It answers, before any re-key is approved: which STORED identity listings would the rule place
// in which line, which of them already sit in that line, which would have to be re-keyed (their
// sticky product_line_id is another line), and what every refusal was. It reads the stored rows
// in a READ ONLY transaction, rebuilds each listing IN MEMORY with the stored rows as
// `storedLines`, runs the parser and the group guards exactly as the backfill would with the
// rule on, and prints the result. It writes nothing, anywhere.
//
//   node scripts/census-shade-lines.js --merchant-id merch_obs_xxx [--merchant-id …] [--limit 5000]
//     [--batch-size 500] [--sleep-ms 250] [--statement-timeout-ms 15000] [--cpu-gate ./gate.js]
//     [--out file.json]
//
// THROTTLED FOR THE 2-vCPU PRIMARY. The rows are read in keyset batches (--batch-size rows per
// query, ordered by source_listing_ref), each in its own READ ONLY transaction with a LOCAL
// statement_timeout (--statement-timeout-ms), with --sleep-ms between batches. --cpu-gate names a
// module whose export is `async () => boolean`: it is awaited before every batch, and while it
// returns false the census waits (5 s steps, up to 10 minutes, then gives up). Use it to hold the
// census while the primary is busy, e.g. a gate that reads Cloud SQL CPU utilisation and returns
// `cpu < 0.6`. Without it the census paces itself by --sleep-ms alone.
//
// Output, per proposed line: the line id and review family id the rule mints (or adopts from a
// v1 line), its members with their stored line and review family ids and status
//   in_line   - stored line == proposed line (nothing to do)
//   rekey     - stored line != proposed line (the re-key backlog; both ids move together)
// plus refusal counts. The re-key itself is documented in src/services/shadeLineCardCollapse.js.

const fs = require('node:fs');
const path = require('node:path');

const {
  SHADE_LINE_RULE_FLAG,
  applyShadeLineGrouping,
  buildStoreKey,
  collectAdoptableV1LineIds,
} = require('../src/services/shadeLineRule');

function argValues(name) {
  const out = [];
  process.argv.forEach((arg, idx) => {
    if (arg === `--${name}` && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
      out.push(...String(process.argv[idx + 1]).split(',').map((value) => value.trim()).filter(Boolean));
    }
  });
  return out;
}

function asString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function withRuleOn(fn) {
  const previous = process.env[SHADE_LINE_RULE_FLAG];
  process.env[SHADE_LINE_RULE_FLAG] = 'true';
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[SHADE_LINE_RULE_FLAG];
    else process.env[SHADE_LINE_RULE_FLAG] = previous;
  }
}

/** The v1 line ids the census rows could adopt, for the store-scope read. */
function adoptableLineIdsForRows(rows) {
  return withRuleOn(() => {
    const { built, storedLines } = buildCensusListings(rows);
    return collectAdoptableV1LineIds(built, { storedLines });
  });
}

function buildCensusListings(rows) {
  const { buildIdentityListingFromProduct } = require('../src/services/pdpIdentityGraph');
  const storedLines = new Map();
  const built = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const ref = asString(row?.source_listing_ref);
    if (!ref) continue;
    const product = row?.source_payload && typeof row.source_payload === 'object' ? row.source_payload : null;
    const listing = buildIdentityListingFromProduct({
      merchantId: row.merchant_id,
      productId: row.product_id,
      product,
      sourceKind: row.source_kind,
      sourceMeta: {
        catalog_category_path: row.catalog_category_path || null,
        catalog_product_type: row.catalog_product_type || null,
      },
    });
    if (!listing) continue;
    if (asString(row.product_line_id)) {
      storedLines.set(ref, {
        product_line_id: asString(row.product_line_id),
        review_family_id: asString(row.review_family_id),
      });
    }
    // The stored decision fields win over the rebuilt ones: the census asks about the rows as
    // they are.
    built.push({
      ...listing,
      identity_status: asString(row.identity_status) || listing.identity_status,
      matched_by_rule: asString(row.matched_by_rule) || listing.matched_by_rule,
    });
  }
  return { built, storedLines };
}

/**
 * Pure. `rows`: stored pdp_identity_listing rows (source_listing_ref, merchant_id, product_id,
 * source_kind, product_line_id, review_family_id, identity_status, matched_by_rule,
 * source_payload) with catalog_category_path / catalog_product_type joined in. `lineStores`:
 * Map(v1 line id -> store keys of its members outside `rows`), as the backfill reads it.
 */
function censusShadeLines(rows, { lineStores = new Map() } = {}) {
  return withRuleOn(() => {
    const { _internals } = require('../src/services/pdpIdentityGraph');
    const { built, storedLines } = buildCensusListings(rows);
    const clustered = _internals.clusterIdentityListings(built);
    const { listings, stats } = applyShadeLineGrouping(clustered, { storedLines, lineStores });
    const lines = new Map();
    const refusals = {};
    for (const listing of listings) {
      const decision = listing?.soft_identity?.shade_line;
      if (!decision) continue;
      if (decision.status === 'refused') {
        refusals[decision.reason] = (refusals[decision.reason] || 0) + 1;
        continue;
      }
      const lineId = decision.status === 'approved' ? decision.product_line_id : decision.proposed_product_line_id;
      const reviewFamilyId = decision.status === 'approved' ? decision.review_family_id : decision.proposed_review_family_id;
      const stored = storedLines.get(listing.source_listing_ref) || {};
      const line = lines.get(lineId) || { product_line_id: lineId, review_family_id: reviewFamilyId, members: [] };
      line.members.push({
        source_listing_ref: listing.source_listing_ref,
        shade_value: decision.shade_value || null,
        stored_product_line_id: stored.product_line_id || null,
        stored_review_family_id: stored.review_family_id || null,
        status: stored.product_line_id && stored.product_line_id !== lineId ? 'rekey' : 'in_line',
      });
      lines.set(lineId, line);
    }
    const lineList = [...lines.values()].sort((a, b) => b.members.length - a.members.length);
    return {
      rows_read: Array.isArray(rows) ? rows.length : 0,
      lines: lineList,
      rekey_rows: lineList.reduce((sum, line) => sum + line.members.filter((m) => m.status === 'rekey').length, 0),
      refusals,
      stats,
    };
  });
}

const LINE_STORES_SQL = `
  SELECT DISTINCT product_line_id, merchant_id, official_domain
  FROM pdp_identity_listing
  WHERE product_line_id = ANY($1::text[])
    AND NOT (source_listing_ref = ANY($2::text[]))
`;

const CENSUS_SQL = `
  SELECT
    pil.source_listing_ref,
    pil.merchant_id,
    pil.product_id,
    pil.source_kind,
    pil.product_line_id,
    pil.review_family_id,
    pil.identity_status,
    pil.matched_by_rule,
    pil.source_payload,
    cp.category_path AS catalog_category_path,
    cp.product_type AS catalog_product_type
  FROM pdp_identity_listing pil
  LEFT JOIN LATERAL (
    SELECT e.attached_product_key
    FROM external_product_seeds e
    WHERE pil.source_kind = 'external_seed'
      AND e.external_product_id = pil.product_id
      AND e.status = 'active'
    ORDER BY e.updated_at DESC NULLS LAST, e.id DESC
    LIMIT 1
  ) seed ON true
  LEFT JOIN catalog_products cp
    ON cp.product_key = seed.attached_product_key
  WHERE pil.merchant_id = ANY($1::text[])
    AND pil.source_listing_ref > $2
  ORDER BY pil.source_listing_ref
  LIMIT $3
`;

const CPU_GATE_STEP_MS = 5000;
const CPU_GATE_MAX_WAIT_MS = 10 * 60 * 1000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

async function waitForCpuGate(cpuGate, sleepFn) {
  if (typeof cpuGate !== 'function') return;
  let waited = 0;
  // eslint-disable-next-line no-await-in-loop
  while (!(await cpuGate())) {
    if (waited >= CPU_GATE_MAX_WAIT_MS) throw new Error('SHADE_LINE_CENSUS_CPU_GATE_TIMEOUT');
    // eslint-disable-next-line no-await-in-loop
    await sleepFn(CPU_GATE_STEP_MS);
    waited += CPU_GATE_STEP_MS;
  }
}

// One statement in its own READ ONLY transaction, under a LOCAL statement_timeout.
async function readOnlyQuery(withClientFn, statementTimeoutMs, sql, params) {
  return withClientFn(async (client) => {
    await client.query('BEGIN READ ONLY');
    try {
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(Math.max(1000, Number(statementTimeoutMs) || 15000))]);
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result?.rows || [];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

/**
 * Reads the census rows and the stores of the v1 lines they could adopt, throttled. Read only.
 */
async function readCensusInputsThrottled({
  withClientFn,
  merchantIds,
  limit = 5000,
  batchSize = 500,
  sleepMs = 250,
  statementTimeoutMs = 15000,
  cpuGate = null,
  sleepFn = defaultSleep,
} = {}) {
  const size = Math.max(1, Math.min(2000, Number(batchSize) || 500));
  const rows = [];
  let after = '';
  let batches = 0;
  while (rows.length < limit) {
    // eslint-disable-next-line no-await-in-loop
    await waitForCpuGate(cpuGate, sleepFn);
    const take = Math.min(size, limit - rows.length);
    // eslint-disable-next-line no-await-in-loop
    const batch = await readOnlyQuery(withClientFn, statementTimeoutMs, CENSUS_SQL, [merchantIds, after, take]);
    batches += 1;
    rows.push(...batch);
    if (batch.length < take) break;
    after = asString(batch[batch.length - 1]?.source_listing_ref);
    // eslint-disable-next-line no-await-in-loop
    await sleepFn(sleepMs);
  }
  const lineStores = new Map();
  const adoptable = adoptableLineIdsForRows(rows);
  const refs = rows.map((row) => asString(row.source_listing_ref)).filter(Boolean);
  for (let idx = 0; idx < adoptable.length; idx += 200) {
    // eslint-disable-next-line no-await-in-loop
    await waitForCpuGate(cpuGate, sleepFn);
    // eslint-disable-next-line no-await-in-loop
    const storeRows = await readOnlyQuery(withClientFn, statementTimeoutMs, LINE_STORES_SQL, [adoptable.slice(idx, idx + 200), refs]);
    batches += 1;
    for (const row of storeRows) {
      const id = asString(row.product_line_id);
      if (!id) continue;
      lineStores.set(id, [...(lineStores.get(id) || []), buildStoreKey(row.merchant_id, row.official_domain)]);
    }
    // eslint-disable-next-line no-await-in-loop
    await sleepFn(sleepMs);
  }
  return { rows, lineStores, batches };
}

async function main() {
  const merchantIds = argValues('merchant-id');
  if (!merchantIds.length) {
    throw new Error('--merchant-id is required (one store at a time; the census never scans the whole table)');
  }
  const limit = Math.max(1, Math.min(20000, Number(argValues('limit')[0] || 5000) || 5000));
  const out = argValues('out')[0] || '';
  const gatePath = argValues('cpu-gate')[0] || '';
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const cpuGate = gatePath ? require(path.resolve(gatePath)) : null;
  const { closePool, withClient } = require('../src/db');
  try {
    const { rows, lineStores, batches } = await readCensusInputsThrottled({
      withClientFn: withClient,
      merchantIds,
      limit,
      batchSize: argValues('batch-size')[0] || 500,
      sleepMs: argValues('sleep-ms')[0] || 250,
      statementTimeoutMs: argValues('statement-timeout-ms')[0] || 15000,
      cpuGate: typeof cpuGate === 'function' ? cpuGate : typeof cpuGate?.default === 'function' ? cpuGate.default : null,
    });
    const payload = {
      ok: true,
      generated_at: new Date().toISOString(),
      input: { merchant_ids: merchantIds, limit, read_batches: batches },
      ...censusShadeLines(rows, { lineStores }),
    };
    if (out) {
      const outPath = path.resolve(out);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } finally {
    await closePool().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: 'SHADE_LINE_CENSUS_FAILED', message: err?.message || String(err) })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CENSUS_SQL,
  LINE_STORES_SQL,
  adoptableLineIdsForRows,
  censusShadeLines,
  readCensusInputsThrottled,
};
