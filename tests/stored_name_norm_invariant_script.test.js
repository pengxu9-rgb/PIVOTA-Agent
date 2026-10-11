'use strict';

// The manual no-change invariant (tests/_manual/stored_name_norm_invariant.js) must compare the
// stored read against today's statement, never today's statement against itself, and it must do so
// on the statement the REAL mainline builds. Its first version stubbed the fold-drift probe along with
// the main statement (the probe always failed, the "on" statement was today's, and the invariant
// passed vacuously on prod), and built its own call instead of the one server.js makes.

const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, '_manual', 'stored_name_norm_invariant.js');
const FLAG = 'CANONICAL_CATALOG_STORED_NAME_NORM';
const ENV_KEYS = ['DATABASE_URL', 'PIVOTA_API_BASE', 'API_MODE', 'SEARCH_QUALITY_CONTRACT_V1_ENABLED', 'SEARCH_QUALITY_CONTRACT_V1_MODE',
  'PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED', 'INDEX_ELIGIBLE_RECALL', 'SEARCH_NAME_EVIDENCE_ADMISSION', FLAG, 'PIVOTA_BACKEND_AGENT_API_KEY', 'PGOPTIONS'];

// The probe's stand-in: answers ONLY the probe, as told; a main statement reaching it is a bug.
function fakeClient(probe, answer) {
  const calls = { probes: 0, other: [] };
  return {
    calls,
    query: async (sql, params) => {
      if (sql === probe.PROBE_SQL) { calls.probes += 1; return { rows: answer ? [answer] : [] }; }
      calls.other.push({ sql, params });
      return { rows: [] };
    },
  };
}

describe('the invariant script on the real mainline', () => {
  let script, probe, prior, nock;
  beforeAll(() => {
    prior = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    jest.resetModules();
    Object.assign(process.env, {
      DATABASE_URL: 'postgres://invariant.test/none', PIVOTA_API_BASE: 'http://disabled-upstream.test', API_MODE: 'REAL',
      SEARCH_QUALITY_CONTRACT_V1_ENABLED: 'true', SEARCH_QUALITY_CONTRACT_V1_MODE: 'enforce',
      PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED: 'true', INDEX_ELIGIBLE_RECALL: 'false', SEARCH_NAME_EVIDENCE_ADMISSION: 'on', [FLAG]: 'on',
    });
    // The app's own database: the probe matches, every other read is empty.
    jest.doMock('../src/db', () => {
      const p = jest.requireActual('../src/services/storedNameNormProbe');
      const query = async (sql) => (sql === p.PROBE_SQL ? { rows: [{ n: p.SAMPLES.length, same: p.SAMPLES.length }] } : { rows: [] });
      return { query, withClient: async (fn) => fn({ query }) };
    });
    nock = require('nock');
    nock.disableNetConnect(); nock.enableNetConnect((host) => host.includes('127.0.0.1'));
    probe = require('../src/services/storedNameNormProbe');
    script = require(SCRIPT);
  });
  afterAll(async () => {
    await script.stopApp();
    nock.cleanAll(); nock.enableNetConnect();
    jest.dontMock('../src/db'); jest.resetModules();
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test('a public find_products_multi reaches the mainline, and the recorded call is the one server.js builds there', async () => {
    const { calls, response } = await script.captureMainlineCalls('barrier moisturizer', 'US');
    expect(response.http_status).toBe(200);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const [call] = calls;
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8').split('\n');
    // The recorded line is inside searchBeautyExternalSeedProductsMainline's canonical call.
    const start = source.findIndex((l) => l.startsWith('async function searchBeautyExternalSeedProductsMainline('));
    expect(call.line).toBeGreaterThan(start);
    expect(source[call.line - 1]).toContain('fetchCanonicalChainRows(');
    // What only the mainline passes: the offer join and scope, its own limit, the category browse.
    expect(call.args.includeSkuOffers).toBe(true);
    expect(call.args.limit).toBe(200);
    expect(call.args.categoryMode).toBe('category_browse');
    expect(call.args.offerScope).toEqual(expect.objectContaining({ currency: 'USD' }));
    expect(call.args.deps).toBeUndefined();
    expect(script.laneSummary(call.args)).toEqual(expect.objectContaining({ include_sku_offers: true, limit: 200, offer_currency: 'USD' }));
  });

  test('a matching probe ({n: 9, same: 9}) on the real client: the on statement is the stored read, the off statement is today\'s', async () => {
    expect(probe.SAMPLES.length).toBe(9);
    const { calls } = await script.captureMainlineCalls('lip gloss', 'SG');
    probe._resetForTest();
    const client = fakeClient(probe, { n: 9, same: 9 });
    const off = await script.buildStatement(calls[0].args, false, { client });
    const on = await script.buildStatement(calls[0].args, true, { client });
    expect(on.sql).not.toBe(off.sql);
    expect(on.sql).toContain('name_norm');
    expect(off.sql).not.toContain('own_name_norm');
    expect(script.vacuousReason(off, on)).toBeNull();
    // Probed once, and only the probe reached the client.
    expect(client.calls.probes).toBe(1);
    expect(client.calls.other).toEqual([]);
  });

  test('a probe with no row (the old stub\'s answer): the on statement is today\'s and the script calls it vacuous', async () => {
    const { calls } = await script.captureMainlineCalls('barrier moisturizer', 'US');
    probe._resetForTest();
    const client = fakeClient(probe, null);
    const off = await script.buildStatement(calls[0].args, false, { client });
    const on = await script.buildStatement(calls[0].args, true, { client });
    expect(on.sql).toBe(off.sql);
    expect(script.vacuousReason(off, on)).toBe('on_statement_equals_off');
    expect(probe._stateForTest().lastReason).toBe('probe_returned_no_row');
  });

  test('every connection the app opens is read-only with a statement timeout', () => {
    expect(process.env.PGOPTIONS).toContain('-c default_transaction_read_only=on');
    expect(process.env.PGOPTIONS).toContain('-c statement_timeout=30000');
  });
});

describe('the invariant script, statically', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const { vacuousReason, marketArg } = jest.requireActual(SCRIPT);

  test('an on statement that differs but never reads name_norm is vacuous too', () => {
    expect(vacuousReason({ sql: 'SELECT 1' }, { sql: 'SELECT 2' })).toBe('on_statement_does_not_read_name_norm');
  });

  test('market comes from the args after node -e ... --', () => {
    expect(marketArg(['/usr/local/bin/node', '--market', 'SG'])).toBe('SG');
    expect(marketArg(['/usr/local/bin/node'])).toBe('');
  });

  test('the script contains no at-sign: run_oneoff_job.sh needs it as the --args delimiter for an inline program', () => {
    expect(text.includes(String.fromCharCode(64))).toBe(false);
    // ...and every other candidate delimiter does appear, which is why the at-sign is the one left.
    for (const c of ['|', '#', '%', '+', '!', ';', ':', '?']) expect(text).toContain(c);
  });

  test('every stdout line the script prints starts with a word, never bare JSON', () => {
    const logs = text.match(/console\.log\(([^\n]*)/g) || [];
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).toMatch(/^console\.log\(`INVARIANT /);
  });
});
