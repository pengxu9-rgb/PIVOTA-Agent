'use strict';

// THE FOLD-DRIFT FAIL-SAFE (#2406 review P2-3). With the flag on, the stored own-name read is allowed
// only while the database's catalog_products_identity_fold(text) equals identitySql on the probe's
// sample set; otherwise the statement is today's, and one ERROR is logged per transition.

jest.mock('../src/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() }));
const logger = require('../src/logger');
const { fetchCanonicalChainRows } = require('../src/services/canonicalCatalogSearch');
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');
const probe = require('../src/services/storedNameNormProbe');
const quality = require('../src/services/canonicalSearchQualitySql');

const FLAG = quality.STORED_NAME_NORM_FLAG;
const OWN = quality.identitySql(quality.OWN_NAME_INPUTS_SQL);
const isProbe = (sql) => sql.includes(`${probe.FUNCTION_NAME}(s)`);

beforeEach(() => {
  probe._resetForTest();
  logger.error.mockClear(); logger.info.mockClear();
  process.env.SEARCH_NAME_EVIDENCE_ADMISSION = 'on';
  process.env[FLAG] = 'on';
  delete process.env[probe.RECHECK_FLAG];
});
afterEach(() => { delete process.env[FLAG]; delete process.env[probe.RECHECK_FLAG]; });

// A fake database: answers the probe as told, captures every main statement.
function fakeDb(answer) {
  const calls = { probes: 0, statements: [] };
  const query = async (sql, params) => {
    if (isProbe(sql)) {
      calls.probes += 1;
      if (answer instanceof Error) throw answer;
      if (answer === 'no-row') return { rows: [] };
      if (answer === 'short') return { rows: [{ n: probe.SAMPLES.length - 1, same: probe.SAMPLES.length - 1 }] };
      return { rows: [{ n: probe.SAMPLES.length, same: answer === 'match' ? probe.SAMPLES.length : probe.SAMPLES.length - 1 }] };
    }
    calls.statements.push({ sql, params });
    return { rows: [] };
  };
  return { query, calls };
}

async function run(db, rawQuery = 'barrier moisturizer') {
  const contract = buildSearchQualityContract({ rawQuery });
  await fetchCanonicalChainRows({
    query: rawQuery, searchQualityContract: contract, brandFilter: contract.hard_constraints.brand,
    categoryPathPrefix: contract.hard_constraints.category_path_prefix, categoryMode: 'category_browse',
    deps: { query: db.query },
  });
  return db.calls.statements[db.calls.statements.length - 1];
}

test('the probe is one statement over the fixed samples: the stored function against identitySql live, per sample', () => {
  expect(probe.PROBE_SQL).toContain(`${probe.FUNCTION_NAME}(s) IS NOT DISTINCT FROM ${quality.identitySql('s')}`);
  expect(probe.PROBE_SQL).toContain('unnest($1::text[])');
  // The samples cover: middle dots and bullets, every accent the fold maps, punctuation, empty, mixed case, [:alnum:] edges.
  const joined = probe.SAMPLES.join('\n');
  for (const needle of ['·', '•', 'ÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÝàáâãäåèéêëìíîïòóôõöùúûüýÿ', '%', '(', '—', 'MiXeD', '²', '½']) expect(joined).toContain(needle);
  expect(probe.SAMPLES).toContain('');
  expect(probe.recheckMs({})).toBe(600000);
  expect(probe.recheckMs({ [probe.RECHECK_FLAG]: '500' })).toBe(1000);
  expect(probe.recheckMs({ [probe.RECHECK_FLAG]: '30000' })).toBe(30000);
});

test('a matching function: the stored path, probed ONCE per process, no log', async () => {
  const db = fakeDb('match');
  const first = await run(db);
  expect(first.sql).toContain(`coalesce(p.own_name_norm, ${OWN})`);
  expect(db.calls.probes).toBe(1);
  const second = await run(db, 'lip gloss');
  expect(second.sql).toContain('coalesce(p.own_name_norm');
  expect(db.calls.probes).toBe(1); // cached
  expect(logger.error).not.toHaveBeenCalled();
  expect(probe._stateForTest()).toEqual(expect.objectContaining({ verified: true, lastReason: null }));
});

test("a mismatching function: today's statement (flag behaves as off), ONE error, no re-probe inside the interval", async () => {
  const db = fakeDb('mismatch');
  const first = await run(db);
  expect(first.sql).not.toContain('name_norm');
  expect(first.sql).toContain(`(${OWN} ~`);
  expect(logger.error).toHaveBeenCalledTimes(1);
  expect(logger.error.mock.calls[0][0]).toEqual(expect.objectContaining({ reason: `fold_mismatch_1_of_${probe.SAMPLES.length}` }));
  await run(db, 'lip gloss');
  expect(db.calls.probes).toBe(1);
  expect(logger.error).toHaveBeenCalledTimes(1);
});

test("a missing function (42883): today's statement, the reason names it", async () => {
  const db = fakeDb(Object.assign(new Error('function catalog_products_identity_fold(text) does not exist'), { code: '42883' }));
  const stmt = await run(db);
  expect(stmt.sql).not.toContain('name_norm');
  expect(logger.error).toHaveBeenCalledTimes(1);
  expect(logger.error.mock.calls[0][0].reason).toBe('fold_function_missing');
});

test("a probe that returns no row, counts fewer samples than sent, or errors otherwise: today's statement, named reasons", async () => {
  const empty = await run(fakeDb('no-row'));
  expect(empty.sql).not.toContain('name_norm');
  expect(probe._stateForTest().lastReason).toBe('probe_returned_no_row');
  probe._resetForTest(); logger.error.mockClear();
  // Every sample agreed, but one sample never reached the function: not a verdict.
  const short = await run(fakeDb('short'));
  expect(short.sql).not.toContain('name_norm');
  expect(probe._stateForTest().lastReason).toBe(`probe_counted_${probe.SAMPLES.length - 1}_of_${probe.SAMPLES.length}`);
  probe._resetForTest(); logger.error.mockClear();
  const errored = await run(fakeDb(Object.assign(new Error('timeout'), { code: '57014' })));
  expect(errored.sql).not.toContain('name_norm');
  expect(probe._stateForTest().lastReason).toBe('probe_error:57014');
});

test('with the flag off the probe never runs and the statement is today\'s', async () => {
  delete process.env[FLAG];
  const db = fakeDb('match');
  const stmt = await run(db);
  expect(db.calls.probes).toBe(0);
  expect(stmt.sql).not.toContain('name_norm');
});

test('the verdict is re-checked after the interval: a repaired function is picked up (info logged), a broken one dropped', async () => {
  process.env[probe.RECHECK_FLAG] = '1000';
  let clock = 1_000_000;
  const now = () => clock;
  const answers = ['mismatch'];
  const query = async (sql, params) => {
    if (isProbe(sql)) {
      const a = answers.shift() || 'match';
      return { rows: [{ n: probe.SAMPLES.length, same: a === 'match' ? probe.SAMPLES.length : 0 }] };
    }
    return { rows: [] };
  };
  expect(await probe.storedFoldVerified(query, { now })).toBe(false);
  expect(logger.error).toHaveBeenCalledTimes(1);
  clock += 500;
  expect(await probe.storedFoldVerified(query, { now })).toBe(false); // inside the interval: cached, no probe
  clock += 600; // past 1 s: probed again, the function now matches
  expect(await probe.storedFoldVerified(query, { now })).toBe(true);
  expect(logger.info).toHaveBeenCalledTimes(1);
  answers.push('mismatch');
  clock += 1001;
  expect(await probe.storedFoldVerified(query, { now })).toBe(false);
  expect(logger.error).toHaveBeenCalledTimes(2);
  // Still broken at the next interval: no new error line (one per TRANSITION, not per probe).
  answers.push('mismatch');
  clock += 1001;
  expect(await probe.storedFoldVerified(query, { now })).toBe(false);
  expect(logger.error).toHaveBeenCalledTimes(2);
  expect(logger.info).toHaveBeenCalledTimes(1);
});

test('callers racing on a cold cache share one probe', async () => {
  let probes = 0;
  let release = null;
  const query = async (sql) => {
    if (isProbe(sql)) { probes += 1; await new Promise((r) => { release = r; }); return { rows: [{ n: probe.SAMPLES.length, same: probe.SAMPLES.length }] }; }
    return { rows: [] };
  };
  const a = probe.storedFoldVerified(query);
  const b = probe.storedFoldVerified(query);
  await new Promise((r) => setImmediate(r));
  release();
  expect(await Promise.all([a, b])).toEqual([true, true]);
  expect(probes).toBe(1);
});

test('the builder itself never reads the env: the verdict is an argument (off unless told true)', () => {
  const build = (storedNameNorm) => {
    const params = ['q', 'q', 200, 50];
    const contract = buildSearchQualityContract({ rawQuery: 'barrier moisturizer' });
    return quality.buildCanonicalSearchQualitySql({ contract, params, categoryPredicate: 'p.category_path = $5', defaultWhere: 'TRUE', defaultBrandWhere: '', storedNameNorm }).where;
  };
  expect(build(true)).toContain('coalesce(p.own_name_norm');
  expect(build(false)).not.toContain('name_norm');
  expect(build(undefined)).not.toContain('name_norm');
  expect(build('on')).not.toContain('name_norm'); // only the boolean true
});
