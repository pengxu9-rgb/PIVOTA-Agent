'use strict';

/**
 * The per-row priced-offer predicate, pinned byte-for-byte to the Python twin.
 *
 * WHY A WHOLE FILE FOR ONE STRING. This repo and pivota-backend both write ONE
 * `catalog_row_trust` table against one Postgres. A predicate edited in one repo
 * only is a split-brain with no flag to blame: this service re-derives on every
 * live-read promotion and identity override, the backend re-derives on a 6h
 * cron, and rows FLAP public<->blocked on the live serving surface. No runtime
 * check catches that — the two are individually self-consistent. So the suites
 * pin each other, exactly as `pdp_renderability.node.test.cjs` does for the
 * seed-route fragment.
 *
 * pivota-backend `tests/test_priced_offer_gate_postgres.py` executes the SAME
 * string against a real Postgres and proves it counts both ways. This file
 * proves THIS repo emits that string.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pricedOfferExistsSql,
  pricedOfferPriceExpr,
} = require('../src/services/pricedOfferSql');

// The literal both twins must emit, byte for byte.
// pivota-backend services/priced_offer_sql.priced_offer_exists_sql('cp.product_key').
const PRICED_OFFER_EXISTS_CP = [
  'EXISTS (',
  '        SELECT 1',
  '        FROM catalog_offers co',
  '        WHERE co.product_key = cp.product_key',
  '          AND co.suppressed_at IS NULL',
  '          AND coalesce(co.merchant_effective_price, co.list_price) > 0',
  '    )',
].join('\n');

test('the priced-offer fragment is byte-identical to the Python twin', () => {
  assert.equal(pricedOfferExistsSql('cp.product_key'), PRICED_OFFER_EXISTS_CP);
});

test('the price expression coalesces effective over list', () => {
  assert.equal(
    pricedOfferPriceExpr('co'),
    'coalesce(co.merchant_effective_price, co.list_price)',
  );
});

test('estimated_best_price is excluded', () => {
  // It is OUR estimate, not a merchant quote. A PDP must not be published on
  // the strength of a guess — 73 of the 77 offer-free sitemap rows surfaced a
  // wrong-currency price from exactly that kind of derived field.
  assert.ok(!pricedOfferExistsSql('cp.product_key').includes('estimated_best_price'));
});

test('the suppression conjunct is present', () => {
  // The invariant on the backend side was hand-spelled WITHOUT this for months
  // while has_price always had it. They agreed on prod by luck, not by
  // construction. A suppressed offer is withdrawn supply and must not keep a
  // row public.
  assert.ok(pricedOfferExistsSql('cp.product_key').includes('co.suppressed_at IS NULL'));
});

test('the price test is > 0, not IS NOT NULL', () => {
  // A 0.00 price is not buyable either, and the invariant this backs has always
  // asked > 0.
  const sql = pricedOfferExistsSql('cp.product_key');
  assert.ok(sql.includes('> 0'));
  assert.ok(!sql.includes('IS NOT NULL'));
});

test('the EXISTS is correlated to the outer row', () => {
  // THE REGRESSION GUARD. If catalog_products ever leaks into this subquery's
  // FROM, the predicate stops asking about THIS product_key and every row reads
  // priced as long as one priced offer exists anywhere — which is precisely the
  // content-key-grained answer that published 4 price-less Tom Ford PDPs.
  const sql = pricedOfferExistsSql('cp.product_key');
  assert.ok(sql.includes('co.product_key = cp.product_key'));
  assert.ok(!sql.includes('FROM catalog_products'));
});

test('the alias is overridable without breaking correlation', () => {
  const sql = pricedOfferExistsSql('cp.product_key', { alias: 'co2' });
  assert.ok(sql.includes('FROM catalog_offers co2'));
  assert.ok(sql.includes('co2.product_key = cp.product_key'));
  assert.ok(sql.includes('co2.suppressed_at IS NULL'));
});

test('an extra predicate is appended as an AND conjunct', () => {
  const sql = pricedOfferExistsSql('cp.product_key', {
    extraPredicate: "upper(trim(coalesce(co.currency, ''))) = 'USD'",
  });
  assert.ok(sql.includes("AND upper(trim(coalesce(co.currency, ''))) = 'USD'"));
  // …and still ends as a closed EXISTS.
  assert.ok(sql.trimEnd().endsWith(')'));
});
