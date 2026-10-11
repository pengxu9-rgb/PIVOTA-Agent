'use strict';

// The manual no-change invariant (tests/_manual/stored_name_norm_invariant.js) must compare the
// stored read against today's statement, never today's statement against itself. Its first version
// stubbed the fold-drift probe along with the main statement, so the probe always failed, the "on"
// statement was today's, and the invariant passed vacuously on prod.

const fs = require('fs');
const path = require('path');

jest.mock('../src/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() }));
const probe = require('../src/services/storedNameNormProbe');
const quality = require('../src/services/canonicalSearchQualitySql');
const SCRIPT = path.join(__dirname, '_manual', 'stored_name_norm_invariant.js');
const { buildStatement, vacuousReason, marketArg } = require(SCRIPT);

const FLAG = quality.STORED_NAME_NORM_FLAG;

// The real client stands in for the database: it answers ONLY the probe; a main statement reaching it is a bug.
function fakeClient(answer) {
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

beforeEach(() => { probe._resetForTest(); process.env.SEARCH_NAME_EVIDENCE_ADMISSION = 'on'; });
afterEach(() => { delete process.env[FLAG]; delete process.env.SEARCH_NAME_EVIDENCE_ADMISSION; });

test('a matching probe ({n: 9, same: 9}) on the real client: the on statement is the stored read, the off statement is today\'s', async () => {
  expect(probe.SAMPLES.length).toBe(9);
  const client = fakeClient({ n: 9, same: 9 });
  for (const q of ['barrier moisturizer', 'lip gloss']) {
    const off = await buildStatement(q, false, { client, market: 'SG' });
    const on = await buildStatement(q, true, { client, market: 'SG' });
    expect(on.sql).not.toBe(off.sql);
    expect(on.sql).toContain('name_norm');
    expect(off.sql).not.toContain('own_name_norm');
    expect(vacuousReason(off, on)).toBeNull();
  }
  // Probed once (cached per process), and only the probe reached the client.
  expect(client.calls.probes).toBe(1);
  expect(client.calls.other).toEqual([]);
});

test('a probe with no row (the old stub\'s answer): the on statement is today\'s and the script calls it vacuous', async () => {
  const client = fakeClient(null);
  const off = await buildStatement('barrier moisturizer', false, { client });
  const on = await buildStatement('barrier moisturizer', true, { client });
  expect(on.sql).toBe(off.sql);
  expect(vacuousReason(off, on)).toBe('on_statement_equals_off');
  expect(probe._stateForTest().lastReason).toBe('probe_returned_no_row');
});

test('an on statement that differs but never reads name_norm is vacuous too', () => {
  expect(vacuousReason({ sql: 'SELECT 1' }, { sql: 'SELECT 2' })).toBe('on_statement_does_not_read_name_norm');
});

test('market comes from the args after node -e ... --', () => {
  expect(marketArg(['/usr/local/bin/node', '--market', 'SG'])).toBe('SG');
  expect(marketArg(['/usr/local/bin/node'])).toBe('');
});

test('the script contains no at-sign: run_oneoff_job.sh needs it as the --args delimiter for an inline program', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  expect(text.includes(String.fromCharCode(64))).toBe(false);
  // ...and every other candidate delimiter does appear, which is why the at-sign is the one left.
  for (const c of ['|', '#', '%', '+', '!', ';', ':', '?']) expect(text).toContain(c);
});

test('every stdout line the script prints starts with a word, never bare JSON', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const logs = text.match(/console\.log\(([^\n]*)/g) || [];
  expect(logs.length).toBeGreaterThan(0);
  for (const line of logs) expect(line).toMatch(/^console\.log\(`INVARIANT /);
});
