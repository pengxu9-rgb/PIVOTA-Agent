'use strict';

/**
 * Durable demo/test exclusion list for catalog audit & count scripts.
 *
 * Source: Fix Plan E (docs/fixplan_2026-07-12_E_demo_data_retirement.md).
 * These merchants are demo/test rigs — real checkout canaries, App-review
 * fixtures, and duplicated demo catalogs. They must be excluded from headline
 * catalog metrics so audits reflect the genuine commerce index, NOT demo noise.
 *
 * NOTE: this is a metrics-exclusion list only. The underlying rows/stores are
 * intentionally KEPT (some back checkout tests / Shopify App-review). Retirement
 * of catalog rows is handled separately (suppression markers), not here.
 */

// Demo checkout duplication (T2) — the same catalog carried twice.
const DEMO_CHECKOUT_MERCHANT_IDS = [
  'merch_efbc46b4619cfbdf', // "Chydan" / Pivota Test / Pivota Market — PSP+MCP canary (keep)
  'merch_bbd34645bc1950cc', // duplicate demo catalog — retire from index metrics
];

// Test fixtures (T3).
const TEST_FIXTURE_MERCHANT_IDS = [
  'merch_test_ownist_001', // ownist_test_fixture_v1
];

// Shopify App-review demo stores (T3) — stores KEPT for App review, excluded from metrics.
const REVIEW_DEMO_MERCHANT_IDS = [
  'merch_shopify_00d4a720d67d96c5dcba', // Pivota Review Demo
  'merch_shopify_0584b37f7a8be00a5223', // Pivota Review Demo 2
  'merch_shopify_b20b5797f4181983c177', // Pivota Review Demo 3
];

// The retired May electronics demo cohort (T1) is suppressed at the row level
// (suppression_reason = this marker); count scripts should also exclude it.
const DEMO_SUPPRESSION_REASONS = ['demo_retired_2026_07'];

const DEMO_MERCHANT_IDS = [
  ...DEMO_CHECKOUT_MERCHANT_IDS,
  ...TEST_FIXTURE_MERCHANT_IDS,
  ...REVIEW_DEMO_MERCHANT_IDS,
];

module.exports = {
  DEMO_MERCHANT_IDS,
  DEMO_CHECKOUT_MERCHANT_IDS,
  TEST_FIXTURE_MERCHANT_IDS,
  REVIEW_DEMO_MERCHANT_IDS,
  DEMO_SUPPRESSION_REASONS,
};
