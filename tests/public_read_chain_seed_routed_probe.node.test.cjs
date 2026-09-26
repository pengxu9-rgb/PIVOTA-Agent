'use strict';

// The public-read chain filter (publicReadDetailResolves in src/server.js) asks "is this row seed-routed?"
// so it can require an acceptable seed on that lane and LEAVE EVERY OTHER LANE ALONE. It asks
// isSeedRoutedLane — pdpRenderability's own lane-dispatch export — NOT pdpRouteResolvable, whose answer
// mixes lane membership with the lane's renderability VERDICT.
//
// History this file exists to keep dead: the filter used to approximate the lane test by calling
// pdpRouteResolvable with seedRouteOk pinned true, valid only while every non-seed arm returned false. The
// 2026-07-29 wix verdict flip ended that: the pin would have read wix merchant rows as "seed-routed", the
// chain would then demand an external seed they do not have, and every wix product would silently vanish
// from public search — the exact landmine the first revision of this file warned about for shopify.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MERCHANT_SYNCED_RENDERABLE_BY_PLATFORM,
  isSeedRoutedLane,
  pdpRouteResolvable,
} = require('../src/services/pdpRenderability');
const {
  chainRowResolvable,
  isSeedRoutedRef,
} = require('../src/services/publicReadChainResolvability');

test('isSeedRoutedLane answers lane MEMBERSHIP only', () => {
  const seedRouted = [
    ['external_seed merchant', { merchantId: 'external_seed', platform: 'anything' }],
    ['external_seed platform', { merchantId: 'm', platform: 'external_seed' }],
    ['minted source_system', { merchantId: 'm', platform: 'p', sourceSystem: 'catalog_enrichment_agent_v1' }],
    ['seed mirror source_system', { merchantId: 'm', platform: 'p', sourceSystem: 'external_product_seeds_mirror_v1' }],
    ['ext_ prefixed source id', { merchantId: 'm', platform: 'p', sourceProductId: 'ext_abc' }],
  ];
  for (const [name, row] of seedRouted) {
    assert.equal(isSeedRoutedLane(row), true, `${name} must read as seed-routed`);
  }

  const otherLanes = [
    ['shopify merchant row', { merchantId: 'm', platform: 'shopify' }],
    ['wix merchant row', { merchantId: 'm', platform: 'wix' }],
    ['url_audit minted row', { merchantId: 'm', platform: 'other', sourceSystem: 'url_audit' }],
    ['brand_authored stub', { merchantId: 'm', platform: '', sourceSystem: 'brand_authored' }],
  ];
  for (const [name, row] of otherLanes) {
    assert.equal(isSeedRoutedLane(row), false, `${name} must NOT read as seed-routed (the chain filter keeps it)`);
  }
});

test('lane membership never depends on the merchant-synced VERDICT map', () => {
  // The failure mode being pinned: an open verdict (wix: true) leaking into the
  // lane question. Whatever the verdict map says, per platform, a plain
  // merchant row on that platform is NOT seed-routed.
  for (const platform of Object.keys(MERCHANT_SYNCED_RENDERABLE_BY_PLATFORM)) {
    assert.equal(
      isSeedRoutedLane({ merchantId: 'merch_x', platform }),
      false,
      `${platform} merchant row read as seed-routed — the chain filter would demand a seed it cannot have`,
    );
    assert.equal(isSeedRoutedRef({ merchant_id: 'merch_x', platform }), false);
  }
});

test('pdpRouteResolvable still dispatches through the SAME lane test', () => {
  // The extraction guard: if pdpRouteResolvable grew its own divergent copy of
  // the lane dispatch, a seed-routed row would stop honoring seedRouteOk.
  const seedRow = { merchantId: 'external_seed', platform: 'wix', sourceProductId: 'x' };
  assert.equal(isSeedRoutedLane(seedRow), true);
  assert.equal(
    pdpRouteResolvable({ ...seedRow, seedRouteOk: false }),
    false,
    'a seed-routed row with no acceptable seed must be non-renderable even on an open platform',
  );
  assert.equal(pdpRouteResolvable({ ...seedRow, seedRouteOk: true }), true);
});

test('a merchant-synced row on an OPEN platform survives the chain filter', () => {
  // End-to-end pin of the regression itself: the resolver's exact branch for a
  // synced wix row — real merchant_id, platform wix, seed columns present but
  // NULL (the LEFT JOIN found no seed, because there is none to find).
  const wixRef = {
    merchant_id: 'merch_pilot',
    platform: 'wix',
    product_id: 'sig_0123456789abcdef0123456789abcdef',
    external_seed_id: undefined,
    external_seed_status: undefined,
  };
  assert.equal(
    chainRowResolvable('sig_0123456789abcdef0123456789abcdef', wixRef, () => true),
    true,
    'a wix merchant-synced row was dropped from public search for lacking a seed it never needed',
  );
});
