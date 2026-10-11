'use strict';
// MANUAL (rollout step 3 of PIVOTA-Agent #2404): the no-change invariant on REAL rows, on the
// statement the REAL mainline builds.
//
// For each sample query, the script boots the gateway app in-process and sends find_products_multi
// through POST /agent/shop/v1/invoke over loopback, exactly as a public caller would. It records the
// arguments searchBeautyExternalSeedProductsMainline (src/server.js) passes to fetchCanonicalChainRows
// -- query text, category prefix, brand filter, limit, markets, offer scope, lane elections, all as
// server.js derives them -- and then builds THAT call twice through the real builder,
// CANONICAL_CATALOG_STORED_NAME_NORM off and on, runs both READ-ONLY, and compares the product keys
// IN ORDER. Prints one line per mainline call and exits 1 on any difference, or when no mainline call
// was made (an invariant over a lane the request never reached proves nothing).
//
// THE ON STATEMENT MUST ACTUALLY BE THE STORED READ. With the flag on, the builder first asks the
// database whether catalog_products_identity_fold(text) still equals identitySql (the fold-drift
// probe, src/services/storedNameNormProbe.js) and builds today's statement when it cannot tell. So
// the probe goes to the real (read-only) client while every other statement is captured, and the
// script FAILS (exit 1) when the on statement equals the off one or does not read name_norm -- a
// "same rows" verdict between two copies of today's statement proves nothing. (The first version
// stubbed the probe too: it always failed, the on statement was today's, and the invariant passed
// vacuously on prod, ms_off == ms_on.)
//
// READ-ONLY, ALL OF IT. PGOPTIONS is set before anything loads, so every connection the app opens
// is default_transaction_read_only with a 30 s statement_timeout, as is the script's own client.
// The invoke is authenticated by the app's configured-service-key path with a key generated in this
// process (PIVOTA_BACKEND_AGENT_API_KEY, otherwise read only by the photo backend client); no real
// credential is mounted or sent anywhere, and the app listens on 127.0.0.1 only.
//
// Every stdout line starts with a word ("INVARIANT ..."): a bare-JSON stdout line in a Cloud Run
// job lands in jsonPayload and shows blank in run_oneoff_job.sh's output.
//
// HOW TO RUN. The gateway image's .dockerignore excludes tests/, so this file is NOT in the image
// and cannot be passed to run_oneoff_job.sh by path. Pass it inline with node -e; inside the image
// (WORKDIR /app) the requires resolve to /app/src (INVARIANT_SRC_DIR overrides). Node needs "--"
// before the script's own args. run_oneoff_job.sh joins --args with the first delimiter absent from
// the payload, and this program contains every candidate but the at-sign, so THIS FILE MUST NEVER
// CONTAIN ONE (a test guards it); that is why the service account is a shell variable below.
//
// The app reads its flags at load, so the job must carry the gateway SERVICE's environment: every
// plain env var, copied off the live service (values can hold commas, so pass ENV_VARS in gcloud's
// "^X^K=V" form with an X no value contains), plus the secret-backed search flag
// PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED in SECRETS. Mount no credential beyond DATABASE_URL.
// From a pivota-backend checkout, against the production primary (there is no replica), ONE market
// per run, with the primary under 35% CPU:
//
//   GATEWAY_SA="sa-gateway$(printf '\x40')pivota-prod.iam.gserviceaccount.com"
//   COMMAND=node IMAGE=us-west1-docker.pkg.dev/pivota-shared/pivota/gateway:<the live sha> \
//     SERVICE_ACCOUNT="$GATEWAY_SA" \
//     SECRETS=DATABASE_URL=DATABASE_URL_NOVERIFY:latest,PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED=gateway-env-PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED:latest \
//     ENV_VARS="^;^<the service's plain env, ;-joined>" \
//     bash scripts/ops/run_oneoff_job.sh -e "$(cat <PIVOTA-Agent>/tests/_manual/stored_name_norm_invariant.js)" -- --market SG
//
// The image must carry #2406 (the builder and the probe), and migration 260 must be applied (else
// the probe reports fold_function_missing and the script fails, as it should). Each query costs one
// real invoke (the mainline's own reads) plus the two compared statements.
const path = require('path');
const { randomBytes } = require('crypto');

process.env.PGOPTIONS = `${process.env.PGOPTIONS || ''} -c default_transaction_read_only=on -c statement_timeout=30000`.trim();

const QUERIES = (process.env.INVARIANT_QUERIES || 'barrier moisturizer|beauty skincare serum|niacinamide serum|vitamin c serum|lip gloss|nail polish|eye cream|curl cream')
  .split('|').map((q) => q.trim()).filter(Boolean);
const SOURCE = process.env.INVARIANT_SOURCE || 'public_api';
const FLAG = 'CANONICAL_CATALOG_STORED_NAME_NORM';
const MAINLINE = 'searchBeautyExternalSeedProductsMainline';
const KEY_ENV = 'PIVOTA_BACKEND_AGENT_API_KEY';
// node -e has no file: __filename is '[eval]' and relative requires resolve against the cwd.
const SRC = process.env.INVARIANT_SRC_DIR || (__filename === '[eval]' ? '/app/src' : path.join(__dirname, '..', '..', 'src'));
const srcModule = (...parts) => require(path.join(SRC, ...parts));

function marketArg(argv = process.argv) {
  return (argv.includes('--market') ? argv[argv.indexOf('--market') + 1] : '') || '';
}

// Boots the app once. fetchCanonicalChainRows is wrapped BEFORE server.js loads (it destructures the
// export at load): calls made from the mainline are recorded, and every call still runs for real.
const harness = { app: null, server: null, port: 0, key: null, recording: null, realFetch: null };
async function bootApp() {
  if (harness.server) return harness;
  harness.key = process.env[KEY_ENV] || `ak_${randomBytes(32).toString('hex')}`;
  process.env[KEY_ENV] = harness.key;
  const canonical = srcModule('services', 'canonicalCatalogSearch');
  if (!harness.realFetch) {
    harness.realFetch = canonical.fetchCanonicalChainRows;
    canonical.fetchCanonicalChainRows = function recordingFetch(args) {
      const frame = String(new Error().stack || '').split('\n').slice(2, 3).join('');
      if (harness.recording && frame.includes(`at ${MAINLINE} `)) {
        const { deps, ...callArgs } = args || {};
        harness.recording.push({ args: callArgs, line: Number((frame.match(/server\.js:(\d+)/) || [])[1]) || null });
      }
      return harness.realFetch.apply(this, arguments);
    };
  }
  harness.app = srcModule('server');
  await new Promise((resolve, reject) => {
    harness.server = harness.app.listen(0, '127.0.0.1', resolve).on('error', reject);
  });
  harness.port = harness.server.address().port;
  return harness;
}

async function stopApp() {
  if (harness.server) await new Promise((resolve) => harness.server.close(() => resolve()));
  harness.server = null;
}

// One public find_products_multi through the real route; returns the mainline's canonical calls.
async function captureMainlineCalls(rawQuery, market = '') {
  await bootApp();
  harness.recording = [];
  let response = null;
  try {
    const res = await fetch(`http://127.0.0.1:${harness.port}/agent/shop/v1/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Agent-API-Key': harness.key },
      body: JSON.stringify({
        operation: 'find_products_multi',
        payload: { search: { query: rawQuery, ...(market ? { market } : {}), limit: 20 } },
        metadata: { source: SOURCE },
      }),
    });
    const body = await res.json().catch(() => null);
    response = {
      http_status: res.status,
      products: Array.isArray(body?.products) ? body.products.length : null,
      query_source: body?.metadata?.query_source || null,
      primary_path_used: body?.metadata?.route_health?.primary_path_used || null,
    };
  } finally {
    const calls = harness.recording;
    harness.recording = null;
    harness.lastCalls = calls;
  }
  return { calls: harness.lastCalls, response };
}

// `client` answers the fold-drift probe (and only it); everything else the builder issues is captured.
async function buildStatement(callArgs, flagOn, { client } = {}) {
  // The builder reads the flag per call.
  if (flagOn) process.env[FLAG] = 'on'; else delete process.env[FLAG];
  const fetchCanonicalChainRows = harness.realFetch || srcModule('services', 'canonicalCatalogSearch').fetchCanonicalChainRows;
  const { PROBE_SQL } = srcModule('services', 'storedNameNormProbe');
  let captured = null;
  await fetchCanonicalChainRows({
    ...callArgs,
    deps: {
      query: async (sql, params) => {
        if (sql === PROBE_SQL) return client.query(sql, params);
        captured = { sql, params };
        return { rows: [] };
      },
    },
  });
  if (!captured) throw new Error(`no statement captured for ${callArgs && callArgs.query}`);
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

// What the mainline asked for, in one line: enough to see it is the served lane.
function laneSummary(a) {
  return {
    query: a.query, category_path_prefix: a.categoryPathPrefix || null, category_mode: a.categoryMode || null,
    brand_filter: a.brandFilter || null, limit: a.limit, market_id: a.marketId || null, markets: a.markets || null,
    include_sku_offers: a.includeSkuOffers === true, token_match: a.tokenMatch === true, sargable_text_where: a.sargableTextWhere === true,
    vertical_search: a.verticalSearch === true, offer_currency: (a.offerScope && a.offerScope.currency) || null, in_stock_only: a.offerScope ? a.offerScope.inStockOnly === true : null,
  };
}

async function run() {
  const { Client } = require('pg');
  const market = marketArg();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let failures = 0;
  let compared = 0;
  try {
    await client.query('SET default_transaction_read_only = on');
    await client.query("SET statement_timeout = '30s'");
    for (const q of QUERIES) {
      // Serve the request the way prod does (the service runs with the flag as configured).
      const { calls, response } = await captureMainlineCalls(q, market);
      if (!calls.length) {
        failures += 1;
        console.log(`INVARIANT ${JSON.stringify({ query: q, market: market || null, ok: false, reason: 'mainline_not_reached', response })}`);
        continue;
      }
      for (const [i, call] of calls.entries()) {
        compared += 1;
        const off = await buildStatement(call.args, false, { client });
        const on = await buildStatement(call.args, true, { client });
        const base = { query: q, market: market || null, call: i, server_line: call.line, response, lane: laneSummary(call.args) };
        const vacuous = vacuousReason(off, on);
        if (vacuous) {
          failures += 1;
          console.log(`INVARIANT ${JSON.stringify({ ...base, ok: false, reason: vacuous, probe_reason: probeReason() })}`);
          continue;
        }
        const t0 = Date.now();
        const rowsOff = (await client.query(off.sql, off.params)).rows;
        const t1 = Date.now();
        const rowsOn = (await client.query(on.sql, on.params)).rows;
        const t2 = Date.now();
        const keysOff = rowsOff.map((r) => r.product_key);
        const keysOn = rowsOn.map((r) => r.product_key);
        const same = keysOff.length === keysOn.length && keysOff.every((k, j) => k === keysOn[j]);
        if (!same) failures += 1;
        console.log(`INVARIANT ${JSON.stringify({ ...base, ok: same, on_differs: true, rows_off: keysOff.length, rows_on: keysOn.length, same_rows_same_order: same, ms_off: t1 - t0, ms_on: t2 - t1,
          ...(same ? {} : { first_difference_at: keysOff.findIndex((k, j) => k !== keysOn[j]), only_off: keysOff.filter((k) => !keysOn.includes(k)).slice(0, 5), only_on: keysOn.filter((k) => !keysOff.includes(k)).slice(0, 5) }) })}`);
      }
    }
  } finally {
    await client.end();
    await stopApp();
  }
  if (failures) { console.log(`INVARIANT FAILED: ${failures} failure(s) over ${QUERIES.length} queries (${compared} mainline calls compared)`); process.exit(1); }
  console.log(`INVARIANT PASSED: ${QUERIES.length} of ${QUERIES.length} queries, ${compared} mainline calls, same rows in the same order, on statement reads name_norm`);
  process.exit(0);
}

module.exports = { captureMainlineCalls, buildStatement, vacuousReason, marketArg, laneSummary, stopApp, QUERIES };

if (require.main === module || __filename === '[eval]') {
  run().catch((err) => { console.error(`INVARIANT ERROR ${err && err.stack || err}`); process.exit(2); });
}
