'use strict';

// CROSS-REPO DRIFT PIN (PR controller review of pivota-backend#2657). The gateway and the backend
// each spell the seed-projected offer guard (Peng 2026-10-19: an offer copied off a seed is a price
// only in its seed's own currency) in their own language, and neither CI can read the other repo.
// So both pin the SAME literal:
//   gateway: src/services/seedSearchOfferScope.js  SEED_PROJECTED_OFFER_SOURCE_SYSTEMS,
//            seedProjectedOfferInSeedCurrencySql (seedCurrencySql inside it)
//   backend: services/seed_offer_currency.py  SEED_PROJECTED_OFFER_SOURCE_SYSTEMS,
//            seed_projected_offer_in_seed_currency_sql (seed_currency_sql inside it)
//   backend twin of this test: tests/test_seed_offer_currency_cross_repo_drift.py
// A change to either side fails here or there until BOTH literals are updated together, so a
// search card (gateway) and a PDP/purchase (backend) cannot disagree on whether a row is a price.
// Whitespace is normalised (the two sides format the statement differently); nothing else is.

const {
  SEED_PROJECTED_OFFER_SOURCE_SYSTEMS,
  seedProjectedOfferInSeedCurrencySql,
} = require('../src/services/seedSearchOfferScope');

const EXPECTED_SOURCE_SYSTEMS = [
  'external_product_seeds_mirror_v1',
  'variant_identity_backfill_v1',
  'variant_offer_projection_v1',
];

// The same segments, in the same order, as the backend test's EXPECTED_PREDICATE.
const EXPECTED_PREDICATE = [
  "(coalesce(o.source_system, '') NOT IN ('external_product_seeds_mirror_v1',",
  " 'variant_identity_backfill_v1', 'variant_offer_projection_v1') OR (SELECT bool_and((CASE WHEN",
  " nullif(upper(trim(eps_own.price_currency)), '') IS NULL THEN",
  " nullif(upper(trim(eps_own.seed_data#>>'{snapshot,price_currency}')), '') ELSE (CASE",
  " coalesce(nullif(upper(trim(eps_own.seed_data#>>'{snapshot,price_currency}')), ''), '') WHEN",
  " nullif(upper(trim(eps_own.price_currency)), '') THEN",
  " nullif(upper(trim(eps_own.price_currency)), '') WHEN '' THEN (CASE WHEN eps_own.seed_data IS",
  " NULL OR (jsonb_typeof(eps_own.seed_data) IN ('object', 'null') AND",
  " (eps_own.seed_data->'snapshot' IS NULL OR jsonb_typeof(eps_own.seed_data->'snapshot') IN",
  " ('object', 'null'))) THEN nullif(upper(trim(eps_own.price_currency)), '') END) END) END) IS NOT",
  " DISTINCT FROM upper(trim(coalesce(o.currency, '')))) FROM external_product_seeds eps_own WHERE",
  " eps_own.attached_product_key = o.product_key AND lower(trim(coalesce(eps_own.status, ''))) =",
  " 'active') IS TRUE)",
].join('');

function normalise(sql) {
  return sql.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}

describe('seed-projected offer guard matches the backend (cross-repo pin)', () => {
  test('the projected source systems are the backend tuple, in order', () => {
    expect([...SEED_PROJECTED_OFFER_SOURCE_SYSTEMS]).toEqual(EXPECTED_SOURCE_SYSTEMS);
  });

  test('the predicate is the backend statement, whitespace aside', () => {
    expect(normalise(seedProjectedOfferInSeedCurrencySql('o', 'o.product_key'))).toBe(EXPECTED_PREDICATE);
  });
});
