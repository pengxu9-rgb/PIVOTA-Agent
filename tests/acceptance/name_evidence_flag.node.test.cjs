'use strict';

// The acceptance set with SEARCH_NAME_EVIDENCE_ADMISSION=on.
//
// The default-flag run (search_acceptance.node.test.cjs) proves the flag-off path is
// unchanged. This run pins exactly what turning the flag ON changes in the SERVED set:
//   * which known failures it fixes -- the list below, no more, no fewer;
//   * that no previously served row disappears;
//   * every row it newly serves, so a later widening of the rule shows up in review.
// Recall (canonical SQL) and the candidate LIMIT are covered over real PostgreSQL in
// tests/integration/search_name_evidence_admission_postgres.test.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const h = require('./search_acceptance_harness.cjs');

const FLAG = 'SEARCH_NAME_EVIDENCE_ADMISSION';

const EXPECTED_FIXES = [
  'meitu_e2_full_name',
  'meitu_partial_name',
  'meitu_brand_category',
  'meitu_category',
  'self_sig_befccb1454d4c7964f213b030faf2bcb',
  'self_sig_d44babbcc1c0f42292c1943e83d1948a',
];

// SERVED rows the flag adds, reviewed 2026-09-17. Each row's own name carries every
// distinctive query token. Two are arguable and kept visible rather than hidden:
// `nail polish` also serves a nail polish REMOVER, and `eye cream` serves an
// "Eye and Lip Contour Cream".
const EXPECTED_ADDITIONS = [
  'SG|KP Bump Eraser Body Scrub 10% AHA => sig_befccb1454d4c7964f213b030faf2bcb',
  'SG|LIP-PRESSION Metal Serum Gloss => acceptance_jsm_lip_pression_metal_serum_gloss',
  'SG|Metal Serum Gloss => acceptance_jsm_lip_pression_metal_serum_gloss',
  "SG|Pro Filt'r Instant Retouch Setting Powder — Lavender => sig_d44babbcc1c0f42292c1943e83d1948a",
  'SG|eye cream => sig_cefc294f354ec732ea4c8c5e76335392',
  'SG|jung saem mool lip gloss => acceptance_jsm_lip_pression_metal_serum_gloss',
  'SG|lip gloss => acceptance_jsm_lip_pression_metal_serum_gloss',
  'SG|lip serum => acceptance_jsm_lip_pression_metal_serum_gloss',
  'SG|matte lipstick => sig_f66e4fbb3d2f50dd47e252af54b04b85',
  'SG|nail polish => sig_abb0301133d433fb9888940b',
];

let prior;
test.before(() => { prior = process.env[FLAG]; process.env[FLAG] = 'on'; });
test.after(() => { if (prior == null) delete process.env[FLAG]; else process.env[FLAG] = prior; });

const cases = h.loadCases();
const rows = h.loadRows();

test('flag on: exactly the expected known failures are fixed, and no passing case regresses', () => {
  const fixed = [];
  for (const c of cases.cases) {
    const { pass } = h.evaluateCase(c, rows);
    if (c.status === 'pass') assert.ok(pass, `flag on regresses ${c.id}`);
    else if (pass) fixed.push(c.id);
  }
  assert.deepEqual(fixed, EXPECTED_FIXES);
});

test('flag on: no previously served row disappears, and every addition is the reviewed list', () => {
  const baseline = JSON.parse(fs.readFileSync(h.BASELINE_PATH, 'utf8'));
  const diff = h.compareToBaseline(baseline.eligible, h.computeEligibleSets(cases, rows));
  assert.deepEqual(diff.removals, []);
  assert.deepEqual(diff.additions.map((a) => `${a.query} => ${a.product_id}`).sort(), [...EXPECTED_ADDITIONS].sort());
});

test('CONTROL: the flag is what changes the result', () => {
  const c = cases.cases.find((x) => x.id === 'meitu_e2_full_name');
  assert.equal(h.evaluateCase(c, rows).pass, true);
  process.env[FLAG] = 'off';
  try {
    assert.equal(h.evaluateCase(c, rows).pass, false);
  } finally {
    process.env[FLAG] = 'on';
  }
});
