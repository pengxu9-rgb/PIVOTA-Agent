// The seller sentinel and the lane share a string. This keeps them from sharing a NAME.
//
// `EXTERNAL_SEED_MERCHANT_ID` is the sentinel SELLER — "the world has one shared seller" — and
// ADR-009 is retiring it: tests/scripts/external_seed_merchant_literal_ratchet.test.js is the
// shrink-only ratchet. Measured 2026-09-10, catalog_products and catalog_offers contain ZERO
// rows carrying it; all 13,896 external-seed products already have a real merch_* seller.
//
// `EXTERNAL_SEED_PLATFORM` is the LANE, and it survives that re-key. It is what the data uses:
// platform=external_seed on 13,896 of 15,516 catalog_products rows and on 90/90 rows from the
// live agent door.
//
// Because the two are the same string today, using one where the other belongs is INVISIBLE —
// and server.js did it twice: a SQL filter on `cp.platform` spelled with the merchant constant,
// and a `platform` default that fell back to the merchant constant. Both read as lane logic and
// were really seller logic that worked by coincidence. Retire the sentinel and the WHERE clause
// silently matches nothing: a dead lane, no error, no test.
//
// So the assertion that matters is not that they are equal today. It is that the LANE constant
// is used for lane questions, which stays true after they diverge.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { EXTERNAL_SEED_MERCHANT_ID, EXTERNAL_SEED_PLATFORM } = require('../src/pdpConfig');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

test('both constants exist and are separately named', () => {
  assert.equal(typeof EXTERNAL_SEED_MERCHANT_ID, 'string');
  assert.equal(typeof EXTERNAL_SEED_PLATFORM, 'string');
  // They ARE the same string today. That is the hazard, not a reason to merge them.
  assert.equal(EXTERNAL_SEED_MERCHANT_ID, EXTERNAL_SEED_PLATFORM);
});

// A lane expression whose VALUE is the seller constant. Deliberately narrow, because two
// neighbouring shapes are legitimate and must not be flagged:
//   - `merchantId === EXTERNAL_SEED_MERCHANT_ID ? … : …` — a seller COMPARISON that happens to
//     decide a platform default (server.js:17671, :17751);
//   - `firstNonEmptyString(ref.merchant_id, …, <lane looks like a seed> ? EXTERNAL_SEED_MERCHANT_ID : '')`
//     — the COALESCE(row value, sentinel) fallback ADR-009 explicitly permits (server.js:18077).
// What is NOT legitimate is spelling a lane VALUE with the seller constant.
function laneExpressionsUsingSellerConstant(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (!/EXTERNAL_SEED_MERCHANT_ID/.test(line)) return;
    if (/EXTERNAL_SEED_PLATFORM/.test(line)) return;
    // `platform` must be the target of an assignment or a SQL comparison on this line…
    if (!/\bplatform\b\s*(?:=|:)/.test(line)) return;
    // …and the constant must be USED as a value, not compared against.
    if (/(?:===|!==|==|!=)\s*EXTERNAL_SEED_MERCHANT_ID/.test(line)) return;
    out.push(`${i + 1}: ${line.trim()}`);
  });
  return out;
}

test('no lane value is spelled with the seller constant', () => {
  assert.deepEqual(
    laneExpressionsUsingSellerConstant(serverSrc),
    [],
    'a platform (lane) value is spelled with the seller sentinel constant',
  );
});

test('CONTROL: the scan flags the real offenders and spares the legitimate shapes', () => {
  // An absence assertion passes just as happily when the scan is broken. These are the two
  // lines that were actually in src/server.js before this change, verbatim, and the three
  // shapes that must survive it.
  const mustFlag = [
    "            WHERE cp.platform = '${EXTERNAL_SEED_MERCHANT_ID}'",
    '  const platform = firstNonEmptyString(catalogRow.platform, product.platform, EXTERNAL_SEED_MERCHANT_ID);',
  ];
  assert.equal(
    laneExpressionsUsingSellerConstant(mustFlag.join('\n')).length,
    2,
    'the scan must flag both historical offenders',
  );

  const mustNotFlag = [
    "    platform: firstNonEmptyString(row.platform, row.merchant_primary_platform, merchantId === EXTERNAL_SEED_MERCHANT_ID ? EXTERNAL_SEED_PLATFORM : 'catalog'),",
    "    String(product.platform || product.source || '').includes('external_seed') ? EXTERNAL_SEED_MERCHANT_ID : '',",
    '  const platform = firstNonEmptyString(row.platform, EXTERNAL_SEED_PLATFORM);',
  ];
  assert.deepEqual(
    laneExpressionsUsingSellerConstant(mustNotFlag.join('\n')),
    [],
    'a seller comparison, the ADR-009 sentinel fallback, and correct lane use must all survive',
  );
});

test('the seller sentinel is still watched by its own ratchet', () => {
  // This file must not be read as replacing ADR-009's ratchet: that one counts SELLER
  // comparisons and drives them to zero; this one only stops the two axes being conflated.
  const ratchet = path.join(__dirname, 'scripts', 'external_seed_merchant_literal_ratchet.test.js');
  assert.ok(fs.existsSync(ratchet), 'the ADR-009 seller ratchet must still exist');
  const baseline = path.join(__dirname, 'fixtures', 'external_seed_merchant_literal_baseline.json');
  assert.ok(fs.existsSync(baseline));
});
