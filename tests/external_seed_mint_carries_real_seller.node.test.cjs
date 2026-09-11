// ADR-009 phase 3, first serving path: the beauty external-seed mainline must carry the row's
// REAL seller instead of minting the sentinel.
//
// services/seller_identity.py names `external_seed` BANNED_BUCKET_MERCHANT_ID — "the placeholder
// bucket ADR-009 D2 bans for new writes" — and enforces a no-fallback discipline: "minting NEVER
// invents an identity from nothing." The gateway cannot mint `merch_obs_<sha256(brand::etld1)>`
// itself without becoming a second identity minter, so the only correct source is the seller the
// mirror already wrote onto the catalog row.
//
// Measured on prod 2026-09-11, over the rows this path serves (status='active'):
//   with the seller subquery      11,814 of 11,819 resolve a real seller, 11,760 merch_obs_*,
//                                 0 sentinel, 5 fall back
//   the 5 are the standalone seeds with no attached_product_key — the mirror's own dry run
//   reports active_standalone: 5, which is the same five.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

function projectionBlock() {
  const start = src.indexOf('const catalogMirrorProjectionSql = `');
  assert.notEqual(start, -1, 'the catalog mirror projection must exist');
  const end = src.indexOf('`;', start);
  assert.notEqual(end, -1);
  return src.slice(start, end);
}

test('the projection carries the mirrored seller', () => {
  assert.match(
    projectionBlock(),
    /SELECT cp\.merchant_id[\s\S]*?AS catalog_merchant_id/,
    'catalogMirrorProjectionSql must project the catalog row merchant_id',
  );
});

test('the seller subquery is NOT gated on serving_eligible — unlike its neighbours', () => {
  // The correctness detail that is invisible unless stated. Every other column in this
  // projection is something you may only SHOW for a servable row, so gating those on
  // serving_eligible is right. A row's SELLER is an identity fact: gating it leaves the row
  // correctly excluded from serving but wrongly attributed to the banned bucket while excluded.
  //
  // Measured: copying the neighbouring shape verbatim cost 2,823 of 11,819 active seeds (23.9%)
  // their real seller. Without the join, 11,814 resolve one. This test exists because that
  // difference produces no error, no log line and no failing assertion anywhere else.
  const block = projectionBlock();
  const sellerStart = block.indexOf('SELECT cp.merchant_id');
  assert.notEqual(sellerStart, -1);
  const sellerSubquery = block.slice(sellerStart, block.indexOf('AS catalog_merchant_id', sellerStart));

  assert.equal(
    /serving_eligible/.test(sellerSubquery),
    false,
    'the seller subquery must not be gated on serving_eligible — it costs 23.9% of rows their seller',
  );
  // CONTROL: the neighbours ARE gated, so this test is reading the right thing. If the whole
  // projection stopped using serving_eligible, the assertion above would pass vacuously.
  assert.ok(
    /serving_eligible/.test(block.slice(0, sellerStart)),
    'the neighbouring projections should still be serving-eligibility gated',
  );
  assert.match(sellerSubquery, /cp\.product_key = external_product_seeds\.attached_product_key/);
});

test('the mainline mint resolves a seller and never hardcodes the sentinel', () => {
  const fnStart = src.indexOf('function buildBeautyExternalSeedMainlineProduct(row)');
  assert.notEqual(fnStart, -1);
  const fnEnd = src.indexOf('\nfunction ', fnStart + 10);
  const fn = src.slice(fnStart, fnEnd === -1 ? fnStart + 4000 : fnEnd);

  assert.match(
    fn,
    /firstNonEmptyString\(row\.catalog_merchant_id,\s*EXTERNAL_SEED_MERCHANT_ID\)/,
    'the seller must be COALESCE(row value, sentinel) — the one fallback shape ADR-009 permits',
  );
  assert.equal(
    /merchant_id:\s*EXTERNAL_SEED_MERCHANT_ID/.test(fn),
    false,
    'this mint must no longer assign the sentinel directly',
  );
  assert.match(fn, /merchant_id:\s*resolvedMerchantId/);
});
