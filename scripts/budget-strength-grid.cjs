#!/usr/bin/env node
'use strict';

// Budget x strength grid for parseBudgetToPriceConstraint (src/findProductsMulti/intent.js).
//
// Every query puts one real budget phrase next to one strength/size phrase and a product word, in one
// of several arrangements ("{b} - {s} {p}", "{s}-{b} {p}", ...). The expected parse of a query is the
// parse of its budget phrase ALONE: a strength next to a budget must neither invent a cap nor eat one.
//
// The fixture (tests/fixtures/budget_strength_grid.json) pins, per flag state:
//   * expected[budget]  -- the pinned parser's parse of each budget phrase alone;
//   * pinned_wrong      -- the grid indices where the PINNED parser already missed that expectation
//                          (run-length encoded; tests/budget_strength_grid.test.js pins its count and
//                          sha256, so it cannot be widened to hide a regression).
// A query is a REGRESSION when the current parser misses the expectation and the pinned parser did
// not; a FIX when the current parser meets it and the pinned parser did not. The pins are data, so
// they stay honest when main moves on: re-pin deliberately with --pin <module>.
//
// Pure parsing: no network, no database.
//
//   node scripts/budget-strength-grid.cjs                 # evaluate the current parser, both flag states
//   node scripts/budget-strength-grid.cjs --pin <module> --from "<label>"
//                                                         # rewrite the pins from <module>'s parser

const fs = require('fs');
const path = require('path');

const FIXTURE = path.join(__dirname, '..', 'tests', 'fixtures', 'budget_strength_grid.json');
const FLAG = 'SEARCH_BUDGET_REQUIRE_MARKER';
const STATES = [
  ['marker_on', '1'],
  ['marker_off', undefined],
];

function withFlag(value, fn) {
  const saved = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  }
}

function buildGrid(spec) {
  const rows = [];
  spec.budgets.forEach((budget, bi) => {
    for (const strength of spec.strengths) {
      for (const product of spec.products) {
        for (const arrangement of spec.arrangements) {
          rows.push({
            index: rows.length,
            budgetIndex: bi,
            query: arrangement.replace('{b}', budget).replace('{s}', strength).replace('{p}', product),
          });
        }
      }
    }
  });
  return rows;
}

const key = (value) => JSON.stringify(value === undefined ? null : value);

// pinned_wrong is stored as runs of consecutive grid indices, "start.length" in base 36, comma-separated.
function encodeIndices(indices) {
  const runs = [];
  for (const i of indices) {
    const last = runs[runs.length - 1];
    if (last && last[0] + last[1] === i) last[1] += 1;
    else runs.push([i, 1]);
  }
  return runs.map(([start, length]) => `${start.toString(36)}.${length.toString(36)}`).join(',');
}

function decodeIndices(encoded) {
  const out = [];
  if (!encoded) return out;
  for (const run of encoded.split(',')) {
    const [start, length] = run.split('.').map((part) => parseInt(part, 36));
    for (let i = 0; i < length; i += 1) out.push(start + i);
  }
  return out;
}

// The soft-bound sweep: every soft bound / budget / bound word before a strength or size RANGE, spaced
// and tight. Its expectation is main's parse of the WHOLE query: the mask may remove a budget main
// read from a strength range (a phantom), but must never add one or change one.
function buildSweep(spec) {
  const rows = [];
  const s = spec.sweep;
  for (const w of s.words) for (const r of s.ranges) for (const p of s.products) for (const a of s.arrangements) {
    rows.push({ index: rows.length, query: a.replace('{w}', w).replace('{r}', r).replace('{p}', p) });
  }
  return rows;
}

function pinSweep(spec, parse, value) {
  return withFlag(value, () => {
    const values = [];
    const ids = buildSweep(spec).map((row) => {
      const k = key(parse(row.query));
      let at = values.indexOf(k);
      if (at < 0) at = values.push(k) - 1;
      return at.toString(36);
    });
    return { values, rows: ids.join(',') };
  });
}

function evaluateSweep(fixture, parse, state) {
  const value = STATES.find(([name]) => name === state)[1];
  const { values, rows: encoded } = fixture.pins[`sweep_${state}`];
  const mainKeys = encoded.split(',').map((id) => values[parseInt(id, 36)]);
  const result = { state, total: 0, same: 0, phantomsRemoved: [], phantomsAdded: [], changed: [] };
  withFlag(value, () => {
    for (const row of buildSweep(fixture)) {
      result.total += 1;
      const main = mainKeys[row.index];
      const got = key(parse(row.query));
      if (got === main) result.same += 1;
      else if (got === 'null') result.phantomsRemoved.push({ query: row.query, main, got });
      else if (main === 'null') result.phantomsAdded.push({ query: row.query, main, got });
      else result.changed.push({ query: row.query, main, got });
    }
  });
  return result;
}

function pin(spec, parse) {
  const rows = buildGrid(spec);
  const out = { ...spec, pins: {} };
  for (const [state, value] of STATES) {
    withFlag(value, () => {
      const expected = spec.budgets.map((b) => parse(b));
      const pinnedWrong = rows
        .filter((row) => key(parse(row.query)) !== key(expected[row.budgetIndex]))
        .map((row) => row.index);
      out.pins[state] = { expected, pinned_wrong: encodeIndices(pinnedWrong) };
    });
    if (spec.sweep) out.pins[`sweep_${state}`] = pinSweep(spec, parse, value);
  }
  return out;
}

function evaluateGrid(fixture, parse, state) {
  const value = STATES.find(([name]) => name === state)[1];
  const rows = buildGrid(fixture);
  const { expected, pinned_wrong: pinnedWrong } = fixture.pins[state];
  const wrongBefore = new Set(decodeIndices(pinnedWrong));
  const result = { state, total: rows.length, ok: 0, fixes: [], regressions: [], stillWrong: [] };
  withFlag(value, () => {
    for (const row of rows) {
      const want = key(expected[row.budgetIndex]);
      const got = key(parse(row.query));
      const entry = { query: row.query, expected: want, got };
      if (got === want) {
        if (wrongBefore.has(row.index)) result.fixes.push(entry);
        else result.ok += 1;
      } else if (wrongBefore.has(row.index)) result.stillWrong.push(entry);
      else result.regressions.push(entry);
    }
  });
  return result;
}

function budgetPhraseDrift(fixture, parse, state) {
  const value = STATES.find(([name]) => name === state)[1];
  return withFlag(value, () =>
    fixture.budgets
      .map((b, i) => ({ budget: b, expected: key(fixture.pins[state].expected[i]), got: key(parse(b)) }))
      .filter((d) => d.expected !== d.got),
  );
}

function main(argv) {
  const pinAt = argv.indexOf('--pin');
  if (pinAt >= 0) {
    const modulePath = path.resolve(argv[pinAt + 1] || '');
    const { parseBudgetToPriceConstraint } = require(modulePath);
    const spec = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    delete spec.pins;
    const fromAt = argv.indexOf('--from');
    spec.pinned_from = fromAt >= 0 ? argv[fromAt + 1] : path.basename(modulePath);
    fs.writeFileSync(FIXTURE, `${JSON.stringify(pin(spec, parseBudgetToPriceConstraint))}\n`);
    console.log(`pinned ${buildGrid(spec).length} grid queries from ${modulePath}`);
    return 0;
  }
  const { parseBudgetToPriceConstraint } = require('../src/findProductsMulti/intent');
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  let failed = false;
  for (const [state] of STATES) {
    const r = evaluateGrid(fixture, parseBudgetToPriceConstraint, state);
    const drift = budgetPhraseDrift(fixture, parseBudgetToPriceConstraint, state);
    console.log(
      `${state}: total=${r.total} ok=${r.ok} fixes=${r.fixes.length} regressions=${r.regressions.length} ` +
        `still_wrong=${r.stillWrong.length} budget_phrase_drift=${drift.length}`,
    );
    for (const e of r.regressions.slice(0, 20)) console.log(`  REGRESSION ${JSON.stringify(e)}`);
    for (const e of r.fixes.slice(0, 5)) console.log(`  fix ${JSON.stringify(e)}`);
    for (const d of drift) console.log(`  DRIFT ${JSON.stringify(d)}`);
    if (r.regressions.length || drift.length) failed = true;
    if (fixture.sweep) {
      const w = evaluateSweep(fixture, parseBudgetToPriceConstraint, state);
      console.log(
        `${state} sweep: total=${w.total} same_as_main=${w.same} main_phantoms_removed=${w.phantomsRemoved.length} ` +
          `phantoms_added=${w.phantomsAdded.length} changed=${w.changed.length}`,
      );
      for (const e of [...w.phantomsAdded, ...w.changed].slice(0, 20)) console.log(`  SWEEP ${JSON.stringify(e)}`);
      // with the marker on (prod) the sweep must read exactly as main, phantoms removed aside; flag off,
      // main's legacy fallback reads a bare number next to a strength range, so only an ADDED budget fails
      if (w.phantomsAdded.length || (state === 'marker_on' && w.changed.length)) failed = true;
    }
  }
  return failed ? 1 : 0;
}

module.exports = { buildGrid, buildSweep, evaluateGrid, evaluateSweep, budgetPhraseDrift, decodeIndices, FIXTURE };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
