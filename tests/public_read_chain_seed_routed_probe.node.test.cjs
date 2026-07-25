'use strict';

// The public-read chain filter (publicReadDetailResolves in src/server.js) asks "is this row seed-routed?"
// by calling pdpRouteResolvable with seedRouteOk:true, so it can require an acceptable seed on that lane and
// LEAVE EVERY OTHER LANE ALONE. That reuse is only valid while the non-seed arms of pdpRouteResolvable all
// return false.
//
// The landmine this guards: MERCHANT_SYNCED_LANE_RENDERABLE is currently false, and the predicate's own
// header documents flipping it to true once the shopify/wix lane is measured to render. On that day the
// probe below would start calling shopify rows "seed-routed" and the chain filter would demand an external
// seed they do not have — silently deleting every shopify product from public search. If this test fails,
// do NOT relax it: give publicReadDetailResolves its own explicit seed-routed test instead.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MERCHANT_SYNCED_LANE_RENDERABLE,
  pdpRouteResolvable,
} = require('../src/services/pdpRenderability');

const probe = (row) => pdpRouteResolvable({ ...row, seedRouteOk: true });

test('seedRouteOk:true reduces pdpRouteResolvable to a pure seed-routed test', () => {
  const seedRouted = [
    ['external_seed merchant', { merchantId: 'external_seed', platform: 'anything' }],
    ['external_seed platform', { merchantId: 'm', platform: 'external_seed' }],
    ['minted source_system', { merchantId: 'm', platform: 'p', sourceSystem: 'catalog_enrichment_agent_v1' }],
    ['seed mirror source_system', { merchantId: 'm', platform: 'p', sourceSystem: 'external_product_seeds_mirror_v1' }],
    ['ext_ prefixed source id', { merchantId: 'm', platform: 'p', sourceProductId: 'ext_abc' }],
  ];
  for (const [name, row] of seedRouted) {
    assert.equal(probe(row), true, `${name} must read as seed-routed`);
  }

  const otherLanes = [
    ['shopify merchant row', { merchantId: 'm', platform: 'shopify' }],
    ['wix merchant row', { merchantId: 'm', platform: 'wix' }],
    ['url_audit minted row', { merchantId: 'm', platform: 'other', sourceSystem: 'url_audit' }],
    ['brand_authored stub', { merchantId: 'm', platform: '', sourceSystem: 'brand_authored' }],
  ];
  for (const [name, row] of otherLanes) {
    assert.equal(probe(row), false, `${name} must NOT read as seed-routed (the chain filter keeps it)`);
  }
});

test('the merchant-synced lane is still closed — flipping it invalidates the probe above', () => {
  assert.equal(
    MERCHANT_SYNCED_LANE_RENDERABLE,
    false,
    'if this flipped to true, publicReadDetailResolves needs its own seed-routed test before shipping',
  );
});
