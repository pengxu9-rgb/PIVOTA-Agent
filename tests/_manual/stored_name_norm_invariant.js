#!/usr/bin/env node
'use strict';
// MANUAL (rollout step 3 of PIVOTA-Agent #2404): the no-change invariant on REAL rows.
//
// For each sample query, build the canonical search statement twice through the real builder --
// CANONICAL_CATALOG_STORED_NAME_NORM off and on -- run both READ-ONLY against the given DSN, and
// compare the product keys IN ORDER. Prints one line per query and exits 1 on any difference.
//
// THE ON STATEMENT MUST ACTUALLY BE THE STORED READ. With the flag on, the builder first asks the
// database whether catalog_products_identity_fold(text) still equals identitySql (the fold-drift
// probe, src/services/storedNameNormProbe.js) and builds today's statement when it cannot tell. So
// the probe goes to the real (read-only) client while every other statement is captured, and the
// script FAILS (exit 1) when the on statement equals the off one or does not read name_norm -- a
// "same rows" verdict between two copies of today's statement proves nothing. (The first version
// stubbed the probe too: it always failed, the on statement was today's, and the invariant passed
// vacuously on prod, ms_off == ms_on.) The probe's verdict is cached per process, so the off
// statement is always built first; the probe never runs with the flag off.
//
// Every stdout line starts with a word ("INVARIANT ..."): a bare-JSON stdout line in a Cloud Run
// job lands in jsonPayload and shows blank in run_oneoff_job.sh's output.
//
// HOW TO RUN. The gateway image's .dockerignore excludes tests/, so this file is NOT in the image
// and cannot be passed to run_oneoff_job.sh by path. Pass it inline with node -e; inside the image
// (WORKDIR /app) the requires resolve to /app/src (INVARIANT_SRC_DIR overrides). Node needs "--"
// before the script's own args. run_oneoff_job.sh joins --args with the first delimiter absent from
// the payload, and this program contains every candidate but the at-sign, so THIS FILE MUST NEVER
// CONTAIN ONE (a test guards it); that is why the service account is a shell variable below. From a
// pivota-backend checkout, against the production primary (there is no replica), ONE market per
// run, with the primary under 35% CPU:
//
//   GATEWAY_SA="sa-gateway$(printf '\x40')pivota-prod.iam.gserviceaccount.com"
//   COMMAND=node IMAGE=us-west1-docker.pkg.dev/pivota-shared/pivota/gateway:<sha> \
//     SERVICE_ACCOUNT="$GATEWAY_SA" \
//     SECRETS=DATABASE_URL=DATABASE_URL_NOVERIFY:latest ENV_VARS=NODE_ENV=production \
//     bash scripts/ops/run_oneoff_job.sh -e "$(cat <PIVOTA-Agent>/tests/_manual/stored_name_norm_invariant.js)" -- --market SG
//
// The image must carry #2406 (the builder and the probe), and migration 260 must be applied (else
// the probe reports fold_function_missing and the script fails, as it should). A job inherits none
// of the gateway service's env: add the search flags the service runs with (read them off the
// service, e.g. SEARCH_NAME_EVIDENCE_ADMISSION) to ENV_VARS, or both statements are built for a lane
// prod does not serve. It sets
// statement_timeout 30 s per statement and never writes.
const path = require('path');

const QUERIES = (process.env.INVARIANT_QUERIES || 'barrier moisturizer|beauty skincare serum|niacinamide serum|vitamin c serum|lip gloss|nail polish|eye cream|curl cream')
  .split('|').map((q) => q.trim()).filter(Boolean);
const FLAG = 'CANONICAL_CATALOG_STORED_NAME_NORM';
// node -e has no file: __filename is '[eval]' and relative requires resolve against the cwd.
const SRC = process.env.INVARIANT_SRC_DIR || (__filename === '[eval]' ? '/app/src' : path.join(__dirname, '..', '..', 'src'));
const srcModule = (...parts) => require(path.join(SRC, ...parts));

function marketArg(argv = process.argv) {
  return (argv.includes('--market') ? argv[argv.indexOf('--market') + 1] : '') || '';
}

// `client` answers the fold-drift probe (and only it); everything else the builder issues is captured.
async function buildStatement(rawQuery, flagOn, { client, market = '' } = {}) {
  // The builder reads the flag per call; the module is loaded once.
  if (flagOn) process.env[FLAG] = 'on'; else delete process.env[FLAG];
  const { fetchCanonicalChainRows } = srcModule('services', 'canonicalCatalogSearch');
  const { buildSearchQualityContract } = srcModule('findProductsMulti', 'queryUnderstanding');
  const { PROBE_SQL } = srcModule('services', 'storedNameNormProbe');
  const contract = buildSearchQualityContract({ rawQuery });
  let captured = null;
  await fetchCanonicalChainRows({
    query: rawQuery, searchQualityContract: contract, brandFilter: contract.hard_constraints.brand,
    categoryPathPrefix: contract.hard_constraints.category_path_prefix, categoryMode: 'category_browse',
    ...(market ? { marketId: market } : {}),
    deps: {
      query: async (sql, params) => {
        if (sql === PROBE_SQL) return client.query(sql, params);
        captured = { sql, params };
        return { rows: [] };
      },
    },
  });
  if (!captured) throw new Error(`no statement captured for ${rawQuery}`);
  return captured;
}

// Null when the on statement is the stored read; otherwise why the comparison would be vacuous.
function vacuousReason(off, on) {
  if (on.sql === off.sql) return 'on_statement_equals_off';
  if (!on.sql.includes('name_norm')) return 'on_statement_does_not_read_name_norm';
  return null;
}

function probeReason() {
  try { return srcModule('services', 'storedNameNormProbe')._stateForTest().lastReason; } catch (_) { return null; }
}

async function run() {
  const { Client } = require('pg');
  const market = marketArg();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let failures = 0;
  try {
    await client.query('SET default_transaction_read_only = on');
    await client.query("SET statement_timeout = '30s'");
    for (const q of QUERIES) {
      const off = await buildStatement(q, false, { client, market });
      const on = await buildStatement(q, true, { client, market });
      const vacuous = vacuousReason(off, on);
      if (vacuous) {
        failures += 1;
        console.log(`INVARIANT ${JSON.stringify({ query: q, market: market || null, ok: false, reason: vacuous, probe_reason: probeReason() })}`);
        continue;
      }
      const t0 = Date.now();
      const rowsOff = (await client.query(off.sql, off.params)).rows;
      const t1 = Date.now();
      const rowsOn = (await client.query(on.sql, on.params)).rows;
      const t2 = Date.now();
      const keysOff = rowsOff.map((r) => r.product_key);
      const keysOn = rowsOn.map((r) => r.product_key);
      const same = keysOff.length === keysOn.length && keysOff.every((k, i) => k === keysOn[i]);
      if (!same) failures += 1;
      console.log(`INVARIANT ${JSON.stringify({ query: q, market: market || null, ok: same, on_differs: true, rows_off: keysOff.length, rows_on: keysOn.length, same_rows_same_order: same, ms_off: t1 - t0, ms_on: t2 - t1,
        ...(same ? {} : { first_difference_at: keysOff.findIndex((k, i) => k !== keysOn[i]), only_off: keysOff.filter((k) => !keysOn.includes(k)).slice(0, 5), only_on: keysOn.filter((k) => !keysOff.includes(k)).slice(0, 5) }) })}`);
    }
  } finally {
    await client.end();
  }
  if (failures) { console.log(`INVARIANT FAILED: ${failures} of ${QUERIES.length} queries differ or compared today's statement with itself`); process.exit(1); }
  console.log(`INVARIANT PASSED: ${QUERIES.length} of ${QUERIES.length} queries, same rows in the same order, on statement reads name_norm`);
}

module.exports = { buildStatement, vacuousReason, marketArg, QUERIES };

if (require.main === module || __filename === '[eval]') {
  run().catch((err) => { console.error(`INVARIANT ERROR ${err && err.stack || err}`); process.exit(2); });
}
