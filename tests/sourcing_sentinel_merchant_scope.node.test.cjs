'use strict';

// Seed products ADVERTISE seed-supply merchant_ids — the legacy shared bucket and the per-brand
// merch_obs_* observed sellers — and get_product's schema REQUIRES a merchant_id, so agents echo
// the advertised value back as a scope on every seed call. The get_product_detail routing fork
// read any non-empty merchant_id as "merchant-scoped" and sent the lookup to the Python
// per-merchant catalog, which cannot serve those sellers: NO_MERCHANT_OFFER for products the
// gateway's own sig/seed lane serves fine.
//
// Live repro 2026-08-27 (sig_2c7636bb109fc25526b6bd799a5f08a9, reco rank-1 for the acne need):
// public PDP 200, bare-id verifyPrice loopback resolved — get_product with the advertised
// seller answered NO_MERCHANT_OFFER.
//
// The routing rule, asymmetric on purpose:
//  - merch_obs_* scopes NEVER serve upstream (the backend 404s observed refs), so any detail ref
//    they scope reroutes to the gateway's own lane;
//  - the legacy bucket CAN serve ext_* ids upstream (agent_api's sentinel path — pinned by
//    tests/integration/invoke.product_intel_v1_real_mode, which is the contract that failed when
//    a first cut of this fix rerouted ALL sentinel refs), so only its sig_-shaped ids reroute.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EXTERNAL_SEED_MERCHANT_ID,
  isExternalSeedSupplyMerchantId,
  isObservedSellerMerchantId,
} = require('../src/services/externalSeedLane');

test('the routing truth-table the fork encodes, expressed through the canonical predicates', () => {
  // The fork's condition is: supply-seller AND (observed seller OR sig_ pid). This table is the
  // contract in one place — each row names who must serve the lookup and why.
  const reroutes = (merchantId, pid) =>
    Boolean(
      String(merchantId || '').trim() !== '' &&
      isExternalSeedSupplyMerchantId(merchantId) &&
      (isObservedSellerMerchantId(merchantId) || String(pid || '').startsWith('sig_')),
    );

  // The live kill case: legacy bucket + sig id — upstream provably cannot resolve it.
  assert.equal(reroutes(EXTERNAL_SEED_MERCHANT_ID, 'sig_2c7636bb109fc25526b6bd799a5f08a9'), true);
  // The intel contract case: legacy bucket + ext_ id — upstream CAN serve it and must keep it.
  assert.equal(reroutes(EXTERNAL_SEED_MERCHANT_ID, 'ext_real_intel_1'), false);
  // Observed sellers never serve upstream, whatever the id shape.
  assert.equal(reroutes('merch_obs_abc123', 'ext_whatever'), true);
  assert.equal(reroutes('merch_obs_abc123', 'sig_whatever'), true);
  assert.equal(reroutes('merch_obs_abc123', '9886499864904'), true);
  // Real merchants are never rerouted — including on sig-shaped ids.
  assert.equal(reroutes('merch_abc123', 'sig_whatever'), false);
  assert.equal(reroutes('merch_abc123', 'prod_1'), false);
  // Near-miss seller ids must not match (the predicate is the canonical one, but pin it here so
  // a widening upstream is caught by THIS suite too).
  assert.equal(reroutes('external_seeds', 'sig_x'), false);
  assert.equal(reroutes('my_external_seed_store', 'sig_x'), false);
  assert.equal(reroutes('', 'sig_x'), false);
  assert.equal(reroutes(null, 'sig_x'), false);
});

test('the server.js routing fork consumes the canonical predicates — the delivery line is pinned', () => {
  // The #1898 pattern: the fix is only real on the line that ROUTES. Reverting the fork alone
  // would leave the truth-table test green while the advertised seller again scopes lookups to a
  // catalog that cannot serve them. Same source-pin pattern as tests/public_feed_gate.node.test.cjs.
  const fs = require('node:fs');
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(
    server,
    /isExternalSeedSupplyMerchantId, isObservedSellerMerchantId \} = require\('\.\/services\/externalSeedLane'\)/,
    'server.js must import BOTH canonical predicates — a local twin is how this class regressed before',
  );
  assert.match(
    server,
    /isExternalSeedSupplyMerchantId\(rawDetailMerchant\) &&\s*\n\s*\(isObservedSellerMerchantId\(rawDetailMerchant\) \|\| pid\.startsWith\('sig_'\)\)/,
    'the fork must encode: supply-seller AND (observed seller OR sig_ pid)',
  );
  assert.match(
    server,
    /const merchantScoped = rawDetailMerchant !== '' && !seedSupplyUnservableUpstream;/,
    'and merchantScoped must be derived from that condition — reading it without consuming it is the no-op mutant',
  );
});
