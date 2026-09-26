'use strict';

/**
 * The cross-merchant merge tool must anchor a cluster on the ELECTED CANONICAL.
 *
 * WHY THIS FILE EXISTS. scripts/map-and-merge-pdp-entity-resolution.js rewrites
 * pdp_identity_listing.sellable_item_group_id — the key that
 * checkoutHandoffResolver, acpFeedSource, discoveryFeed, RecommendationEngine,
 * productEntityIndexFeed and catalogEntityResolution all read. Pointing a
 * cluster at the wrong row is therefore not cosmetic; it moves the entity onto a
 * page we do not advertise, and can move checkout with it.
 *
 * MEASURED ON PROD 2026-07-31, before the fix: ranking by `is_primary` first
 * disagreed with content_canonical_election on 43 of the 83 cross-merchant
 * content_keys whose identity is ALREADY CORRECT. Running the sweep would have
 * rewritten 43 good groupings. The disagreements were systematic — `is_primary`
 * picks rows that are trust-'shadow' or 'blocked' while the elected row is
 * trust-'public'. On ck_1fdeb19a47f5ae0140084 (Tom Ford Black Orchid) it chose
 * the sephora.com row that is trust-BLOCKED for carrying no price at all, over
 * the priced tomfordbeauty.com row that actually serves.
 *
 * These tests pin the ORDERING RULE. The prod-data control gate ("0
 * disagreements across the 83") is a separate read-only sweep; this file is what
 * stops the rule regressing between sweeps.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  comparePrimaryRows,
  pickPrimaryMember,
  isElectedCanonical,
} = require('../scripts/map-and-merge-pdp-entity-resolution.js');

function row(overrides = {}) {
  return {
    product_key: 'pk_a',
    pivota_signature_id: 'sig_a',
    elected_canonical_sig_id: null,
    is_primary: false,
    pdp_lifecycle_stage: 'candidate',
    pivota_signature_minted_at: '2026-01-01T00:00:00Z',
    source_domain: 'example.com',
    ...overrides,
  };
}

test('the elected canonical wins even when a sibling is is_primary', () => {
  // The exact prod shape: is_primary=true on a row that does NOT hold the URL.
  const elected = row({
    product_key: 'pk_elected', pivota_signature_id: 'sig_elected',
    elected_canonical_sig_id: 'sig_elected', is_primary: false,
    pdp_lifecycle_stage: 'candidate', source_domain: 'tomfordbeauty.com',
  });
  const primary = row({
    product_key: 'pk_primary', pivota_signature_id: 'sig_primary',
    elected_canonical_sig_id: 'sig_elected', is_primary: true,
    pdp_lifecycle_stage: 'published', source_domain: 'sephora.com',
  });
  assert.equal(pickPrimaryMember([primary, elected]).pivota_signature_id, 'sig_elected');
  assert.equal(pickPrimaryMember([elected, primary]).pivota_signature_id, 'sig_elected');
});

test('the elected canonical wins even with a WORSE lifecycle and a later mint', () => {
  // Every legacy tiebreak points the other way; the election still wins.
  const elected = row({
    pivota_signature_id: 'sig_elected', elected_canonical_sig_id: 'sig_elected',
    is_primary: false, pdp_lifecycle_stage: 'draft',
    pivota_signature_minted_at: '2026-06-01T00:00:00Z', product_key: 'pk_zzz',
  });
  const other = row({
    pivota_signature_id: 'sig_other', elected_canonical_sig_id: 'sig_elected',
    is_primary: true, pdp_lifecycle_stage: 'published',
    pivota_signature_minted_at: '2020-01-01T00:00:00Z', product_key: 'pk_aaa',
  });
  assert.equal(pickPrimaryMember([other, elected]).pivota_signature_id, 'sig_elected');
});

test('with NO election the legacy order still applies', () => {
  // 6 of the 83 measured groups have no election. They must keep c1 behaviour,
  // not fall into an arbitrary order.
  const primary = row({ pivota_signature_id: 'sig_p', is_primary: true });
  const published = row({
    pivota_signature_id: 'sig_pub', is_primary: false, pdp_lifecycle_stage: 'published',
  });
  assert.equal(pickPrimaryMember([published, primary]).pivota_signature_id, 'sig_p');

  const older = row({
    pivota_signature_id: 'sig_old', pivota_signature_minted_at: '2019-01-01T00:00:00Z',
  });
  const newer = row({
    pivota_signature_id: 'sig_new', pivota_signature_minted_at: '2026-01-01T00:00:00Z',
  });
  assert.equal(pickPrimaryMember([newer, older]).pivota_signature_id, 'sig_old');
});

test('an election naming a sig NOT in the cluster does not crown anyone', () => {
  // Defensive: a stale election must degrade to the legacy order, never make
  // every row "not elected" in a way that changes the legacy outcome.
  const a = row({ pivota_signature_id: 'sig_a', elected_canonical_sig_id: 'sig_missing', is_primary: true });
  const b = row({ pivota_signature_id: 'sig_b', elected_canonical_sig_id: 'sig_missing', pdp_lifecycle_stage: 'published' });
  assert.equal(pickPrimaryMember([b, a]).pivota_signature_id, 'sig_a');
});

test('isElectedCanonical requires BOTH fields present and equal', () => {
  assert.equal(isElectedCanonical(row({ pivota_signature_id: 'sig_a', elected_canonical_sig_id: 'sig_a' })), true);
  assert.equal(isElectedCanonical(row({ pivota_signature_id: 'sig_a', elected_canonical_sig_id: 'sig_b' })), false);
  assert.equal(isElectedCanonical(row({ pivota_signature_id: 'sig_a', elected_canonical_sig_id: null })), false);
  assert.equal(isElectedCanonical(row({ pivota_signature_id: '', elected_canonical_sig_id: '' })), false);
  assert.equal(isElectedCanonical(undefined), false);
});

test('the comparator is a strict ordering (no sort instability)', () => {
  const a = row({ pivota_signature_id: 'sig_a', elected_canonical_sig_id: 'sig_a' });
  const b = row({ pivota_signature_id: 'sig_b', elected_canonical_sig_id: 'sig_a', is_primary: true });
  assert.ok(comparePrimaryRows(a, b) < 0);
  assert.ok(comparePrimaryRows(b, a) > 0);
  assert.equal(comparePrimaryRows(a, a), 0);
});

test('the member query selects the election, or the tiebreak is inert', () => {
  // MUTATION PIN: the comparator can only see the election if the SQL selects
  // it. Drop the join and every row reads "not elected", the tiebreak silently
  // no-ops, and the 43-row regression returns with all unit tests still green.
  const fs = require('node:fs');
  const src = fs.readFileSync(
    require.resolve('../scripts/map-and-merge-pdp-entity-resolution.js'), 'utf8');
  assert.ok(src.includes('cce.canonical_sig_id AS elected_canonical_sig_id'),
    'member query must select the elected canonical sig');
  assert.ok(src.includes('LEFT JOIN content_canonical_election cce'),
    'member query must join content_canonical_election');
  assert.ok(src.includes('ON cce.content_key = cp.content_key'),
    'the election must be joined by content_key');
});
