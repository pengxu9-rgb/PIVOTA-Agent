/**
 * A PDP must not state an offer count it never took.
 *
 * `decoratePdpPayloadWithIdentity` did `Number(offersCount)`, and `Number(null)` is 0. Every caller
 * that did not build the offers module passes the default null, so every PDP served without that
 * module claimed `offers_count: 0` and `has_multiple_offers: false`. `get_product` asks for
 * `product_overview` only; measured in prod 2026-09-18 on the Pyunkang Yul canary it reported zero
 * offers for a product `get_offers` returned two sellers for — next to `canonical_scope:
 * multi_merchant_canonical`, which says the opposite.
 *
 * The rule: an absent count is ABSENT. A counted zero is still reported as zero — "we looked and
 * found none" is a real answer, and it is a different answer from "we did not look".
 */
const assert = require('node:assert/strict');
const test = require('node:test');

process.env.NODE_ENV = 'test';

const app = require('../src/server');

const { decoratePdpPayloadWithIdentity } = app._debug;

const PAYLOAD = () => ({ product: { product_id: 'sig_probe', title: 'Probe' } });
const COUNT_KEYS = ['offers_count', 'offer_count', 'has_multiple_offers'];

for (const [label, offersCount] of [
  ['null (the default)', null],
  ['undefined', undefined],
  ['an empty string', ''],
  ['whitespace', '   '],
  ['not a number', 'many'],
]) {
  test(`an offer count of ${label} is not stated, on the product or the payload`, () => {
    const out = decoratePdpPayloadWithIdentity(PAYLOAD(), {
      productGroupId: 'sig_group',
      canonicalScope: 'multi_merchant_canonical',
      offersCount,
    });
    for (const key of COUNT_KEYS) {
      assert.equal(key in out.product, false, `product.${key} must be absent`);
      assert.equal(key in out, false, `payload.${key} must be absent`);
    }
    // Everything that WAS known is still written.
    assert.equal(out.product.product_group_id, 'sig_group');
    assert.equal(out.product.canonical_scope, 'multi_merchant_canonical');
  });
}

test('omitting the option entirely states no count either', () => {
  const out = decoratePdpPayloadWithIdentity(PAYLOAD(), { productGroupId: 'sig_group' });
  for (const key of COUNT_KEYS) assert.equal(key in out.product, false, key);
});

test('a COUNTED zero is still reported: none found is a real answer', () => {
  for (const zero of [0, '0']) {
    const out = decoratePdpPayloadWithIdentity(PAYLOAD(), { offersCount: zero });
    assert.equal(out.product.offers_count, 0);
    assert.equal(out.product.offer_count, 0);
    assert.equal(out.product.has_multiple_offers, false);
    assert.equal(out.offers_count, 0);
  }
});

test('a real count of two is reported as two sellers', () => {
  const out = decoratePdpPayloadWithIdentity(PAYLOAD(), { offersCount: 2 });
  assert.equal(out.product.offers_count, 2);
  assert.equal(out.product.has_multiple_offers, true);
  assert.equal(out.has_multiple_offers, true);
});

test('a negative count is refused rather than reported', () => {
  const out = decoratePdpPayloadWithIdentity(PAYLOAD(), { offersCount: -1 });
  for (const key of COUNT_KEYS) assert.equal(key in out.product, false, key);
});
