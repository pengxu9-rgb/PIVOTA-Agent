'use strict';

// 'external_seed' is a SOURCING bucket, not a seller — but every seed product ADVERTISES it as
// merchant_id, and get_product's schema REQUIRES a merchant_id, so agents echo the sentinel back
// as a scope. The Python per-merchant catalog has no such merchant, so the "scoped" lookup died
// with NO_MERCHANT_OFFER on products the unscoped sig lane serves fine.
//
// Live repro 2026-08-27 (sig_2c7636bb109fc25526b6bd799a5f08a9, reco rank-1 for the acne need):
// public PDP 200, bare-id verifyPrice loopback resolved — get_product with the advertised
// merchant_id answered NO_MERCHANT_OFFER.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isSourcingSentinelMerchantId } = require('../src/services/sourcingSentinel');

test('the sentinel predicate: exactly the sourcing bucket, never a real merchant', () => {
  assert.equal(isSourcingSentinelMerchantId('external_seed'), true);
  assert.equal(isSourcingSentinelMerchantId('  External_Seed  '), true, 'case/whitespace variants agents produce');
  assert.equal(isSourcingSentinelMerchantId('external seed'), true, 'the display spelling the seller-name filter already nulls');
  // Real scopes must survive — a predicate that over-matches deletes merchant-scoped commerce.
  assert.equal(isSourcingSentinelMerchantId('merch_abc123'), false);
  assert.equal(isSourcingSentinelMerchantId('external_seeds'), false, 'no prefix matching — only the exact bucket');
  assert.equal(isSourcingSentinelMerchantId('my_external_seed_store'), false);
  assert.equal(isSourcingSentinelMerchantId(''), false);
  assert.equal(isSourcingSentinelMerchantId(null), false);
  assert.equal(isSourcingSentinelMerchantId(undefined), false);
});

test('the server.js delivery paths consume the shared predicate — both forks are pinned', () => {
  // The #1898 pattern: the fix is only real on the line that ROUTES. Reverting either call site
  // would leave the predicate tests green while the sentinel again scopes lookups to a merchant
  // that does not exist. Same source-pin pattern as tests/public_feed_gate.node.test.cjs.
  const fs = require('node:fs');
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(
    server,
    /isSourcingSentinelMerchantId \} = require\('\.\/services\/sourcingSentinel'\)/,
    'server.js must import the shared predicate, not keep a local copy that can drift',
  );
  // Fork 1: get_product_detail routing — the sentinel must not count as merchant-scoped, so the
  // lookup routes to the gateway's own sig-detail lane instead of the Python per-merchant catalog.
  assert.match(
    server,
    /prod\.merchant_id\.trim\(\) !== '' &&\s*\n\s*!isSourcingSentinelMerchantId\(prod\.merchant_id\)/,
    'the get_product_detail scoped/unscoped fork must exempt the sentinel',
  );
  // Fork 2: get_pdp_v2 intake — a caller-supplied sentinel scope is treated as no scope.
  assert.match(
    server,
    /if \(isSourcingSentinelMerchantId\(requestedMerchantId\)\) requestedMerchantId = '';/,
    'the get_pdp_v2 intake must strip a caller-supplied sentinel scope',
  );
});
