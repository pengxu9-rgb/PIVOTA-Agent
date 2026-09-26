'use strict';

// The public-read chain filter decides which search rows may be advertised. Its failure mode is DELETING
// real products from public search, so every case that is not provably dead must fail OPEN.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  chainRowResolvable,
  isSeedRoutedRef,
  seedFieldsKnown,
} = require('../src/services/publicReadChainResolvability');

const isSig = (id) => /^sig_[a-z0-9]+$/i.test(String(id || '').trim());
const resolvable = (id, ref) => chainRowResolvable(id, ref, isSig);

// The shape resolveCatalogProductRefFromPivotaSignature returns from its EXACT branch: seed keys always
// present, even when the LEFT JOIN found nothing.
function exactRef(over = {}) {
  return {
    merchant_id: 'external_seed',
    product_id: 'ext_abc',
    platform: 'external_seed',
    source_system: 'external_product_seeds_mirror_v1',
    external_seed_id: 'seed_1',
    external_seed_status: 'active',
    ...over,
  };
}

test('cohort 1: a non-signature id is never advertised', () => {
  assert.equal(resolvable('rejuran:b4bd504ceeaf45aa', exactRef()), false);
  assert.equal(resolvable('', exactRef()), false);
  assert.equal(resolvable(null, exactRef()), false);
});

test('no catalog row behind the signature ⇒ not advertised', () => {
  assert.equal(resolvable('sig_abc', null), false);
  assert.equal(resolvable('sig_abc', undefined), false);
});

test('cohort 2: seed-routed row with a non-active seed is dropped', () => {
  for (const status of ['inactive', 'retired_demo', 'review_blocked', 'disabled', 'blocked', 'INACTIVE']) {
    assert.equal(resolvable('sig_abc', exactRef({ external_seed_status: status })), false, status);
  }
});

test('cohort 2: seed-routed row with an active or blank status is kept', () => {
  assert.equal(resolvable('sig_abc', exactRef({ external_seed_status: 'active' })), true);
  // A blank status is let through by get_pdp_v2's own precheck, so it must be let through here too.
  assert.equal(resolvable('sig_abc', exactRef({ external_seed_status: '' })), true);
  assert.equal(resolvable('sig_abc', exactRef({ external_seed_status: null })), true);
});

test('cohort 2: seed-routed row whose exact lookup found NO seed is dropped', () => {
  // Exact branch, LEFT JOIN matched nothing: keys present, values undefined.
  assert.equal(resolvable('sig_abc', exactRef({ external_seed_id: undefined, external_seed_status: undefined })), false);
});

test('REGRESSION: a fallback ref with no seed columns must be KEPT, not dropped', () => {
  // The resolver has branches returning only these four fields. Value-checking external_seed_id would read
  // that as "no seed" and delete healthy seed-routed rows — most of the catalog — from public search.
  const fallback = {
    merchant_id: 'external_seed',
    product_id: 'ext_abc',
    platform: 'external_seed',
    product_key: 'brand:hash',
  };
  assert.equal(seedFieldsKnown(fallback), false, 'fixture must genuinely omit the seed keys');
  assert.equal(isSeedRoutedRef(fallback), true, 'fixture must genuinely be seed-routed');
  assert.equal(resolvable('sig_abc', fallback), true, 'unknown seed route must fail OPEN');
});

test('non-seed lanes are always kept — borrowing pdpRouteResolvable wholesale would gut the catalog', () => {
  const lanes = [
    { merchant_id: 'm', platform: 'shopify', product_id: 'p1' },
    { merchant_id: 'm', platform: 'wix', product_id: 'p1' },
    { merchant_id: 'm', platform: 'other', source_system: 'url_audit', product_id: 'p1' },
    { merchant_id: 'm', platform: '', source_system: 'brand_authored', product_id: 'p1' },
  ];
  for (const ref of lanes) {
    assert.equal(resolvable('sig_abc', ref), true, `${ref.platform || ref.source_system} must be kept`);
  }
});

test('minted (P3) rows are seed-routed and judged on their attached seed', () => {
  const minted = { merchant_id: 'm', platform: 'external_seed', source_system: 'catalog_enrichment_agent_v1', product_id: 'some-name-slug' };
  assert.equal(isSeedRoutedRef(minted), true);
  assert.equal(resolvable('sig_abc', { ...minted, external_seed_id: 's1', external_seed_status: 'active' }), true);
  assert.equal(resolvable('sig_abc', { ...minted, external_seed_id: 's1', external_seed_status: 'inactive' }), false);
});
