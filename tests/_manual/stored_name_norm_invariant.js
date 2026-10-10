#!/usr/bin/env node
'use strict';
// MANUAL (rollout step 3 of PIVOTA-Agent #2404): the no-change invariant on REAL rows.
//
// For each sample query, build the canonical search statement twice through the real builder --
// CANONICAL_CATALOG_STORED_NAME_NORM off and on -- run both READ-ONLY against the given DSN, and
// compare the product keys IN ORDER. Prints one line per query and exits 1 on any difference.
// Run it from a one-off job on the gateway image against the production replica of truth (the
// primary; there is no replica), ONE query pair at a time, with the primary under 35% CPU:
//
//   COMMAND=node IMAGE=us-west1-docker.pkg.dev/pivota-shared/pivota/gateway:<sha> \
//     SERVICE_ACCOUNT=sa-gateway@pivota-prod.iam.gserviceaccount.com \
//     SECRETS=DATABASE_URL=DATABASE_URL_NOVERIFY:latest ENV_VARS=NODE_ENV=production \
//     bash scripts/ops/run_oneoff_job.sh tests/_manual/stored_name_norm_invariant.js --market SG
//
// It sets statement_timeout 30 s per statement and never writes.
const path = require('path');
const { Client } = require('pg');

const QUERIES = (process.env.INVARIANT_QUERIES || 'barrier moisturizer|beauty skincare serum|niacinamide serum|vitamin c serum|lip gloss|nail polish|eye cream|curl cream')
  .split('|').map((q) => q.trim()).filter(Boolean);
const market = (process.argv.includes('--market') ? process.argv[process.argv.indexOf('--market') + 1] : '') || '';
const FLAG = 'CANONICAL_CATALOG_STORED_NAME_NORM';

async function buildStatement(rawQuery, flagOn) {
  // The builder reads the flag per call; the module is loaded once.
  if (flagOn) process.env[FLAG] = 'on'; else delete process.env[FLAG];
  const { fetchCanonicalChainRows } = require(path.join(__dirname, '..', '..', 'src', 'services', 'canonicalCatalogSearch'));
  const { buildSearchQualityContract } = require(path.join(__dirname, '..', '..', 'src', 'findProductsMulti', 'queryUnderstanding'));
  const contract = buildSearchQualityContract({ rawQuery });
  let captured = null;
  await fetchCanonicalChainRows({
    query: rawQuery, searchQualityContract: contract, brandFilter: contract.hard_constraints.brand,
    categoryPathPrefix: contract.hard_constraints.category_path_prefix, categoryMode: 'category_browse',
    ...(market ? { marketId: market } : {}),
    deps: { query: async (sql, params) => { captured = { sql, params }; return { rows: [] }; } },
  });
  if (!captured) throw new Error(`no statement captured for ${rawQuery}`);
  return captured;
}

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let failures = 0;
  try {
    await client.query('SET default_transaction_read_only = on');
    await client.query("SET statement_timeout = '30s'");
    for (const q of QUERIES) {
      const off = await buildStatement(q, false);
      const on = await buildStatement(q, true);
      const t0 = Date.now();
      const rowsOff = (await client.query(off.sql, off.params)).rows;
      const t1 = Date.now();
      const rowsOn = (await client.query(on.sql, on.params)).rows;
      const t2 = Date.now();
      const keysOff = rowsOff.map((r) => r.product_key);
      const keysOn = rowsOn.map((r) => r.product_key);
      const same = keysOff.length === keysOn.length && keysOff.every((k, i) => k === keysOn[i]);
      if (!same) failures += 1;
      console.log(JSON.stringify({ query: q, market: market || null, rows_off: keysOff.length, rows_on: keysOn.length, same_rows_same_order: same, ms_off: t1 - t0, ms_on: t2 - t1,
        ...(same ? {} : { first_difference_at: keysOff.findIndex((k, i) => k !== keysOn[i]), only_off: keysOff.filter((k) => !keysOn.includes(k)).slice(0, 5), only_on: keysOn.filter((k) => !keysOff.includes(k)).slice(0, 5) }) }));
    }
  } finally {
    await client.end();
  }
  if (failures) { console.error(`${failures} of ${QUERIES.length} queries differ`); process.exit(1); }
}

run().catch((err) => { console.error(err && err.stack || err); process.exit(2); });
