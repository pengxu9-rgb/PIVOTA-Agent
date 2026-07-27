'use strict';

const {
  TEST_MERCHANT_IDS,
  getTestMerchantIds,
  isTestMerchantId,
  notTestMerchantSql,
} = require('../src/services/testMerchantPolicy');
const {
  activeCatalogProductSourceWhere,
  activeProductsCacheSourceWhere,
} = require('../src/services/activeCatalogSourceSql');

describe('testMerchantPolicy', () => {
  test('bakes in both founder-confirmed rigs (2026-07-24)', () => {
    expect(TEST_MERCHANT_IDS).toContain('merch_efbc46b4619cfbdf'); // 92sfrj-bi test store
    expect(TEST_MERCHANT_IDS).toContain('merch_shopify_0584b37f7a8be00a5223'); // pivota-review-demo-2
  });

  // ADR-018 census (#1595): a fixture catalog with 4 serving_eligible rows and
  // NO merchant_stores row, so the domain leg can never reach it — the id
  // denylist is the only thing standing between it and the public feed.
  test('bakes in the ownist fixture merchant (2026-07-27)', () => {
    expect(TEST_MERCHANT_IDS).toContain('merch_test_ownist_001');
    expect(isTestMerchantId('merch_test_ownist_001', {})).toBe(true);
  });

  describe('isTestMerchantId', () => {
    test('flags the baked-in rigs', () => {
      expect(isTestMerchantId('merch_efbc46b4619cfbdf', {})).toBe(true);
      expect(isTestMerchantId('merch_shopify_0584b37f7a8be00a5223', {})).toBe(true);
    });

    test('does not flag real merchants or external_seed', () => {
      expect(isTestMerchantId('merch_obs_cosrx', {})).toBe(false);
      expect(isTestMerchantId('external_seed', {})).toBe(false);
      expect(isTestMerchantId('', {})).toBe(false);
      expect(isTestMerchantId(null, {})).toBe(false);
      expect(isTestMerchantId(undefined, {})).toBe(false);
    });

    test('trims whitespace before comparing', () => {
      expect(isTestMerchantId('  merch_efbc46b4619cfbdf  ', {})).toBe(true);
    });
  });

  describe('env escape hatch is additive only', () => {
    test('adds an id via PIVOTA_TEST_MERCHANT_IDS', () => {
      const env = { PIVOTA_TEST_MERCHANT_IDS: 'merch_new_rig, merch_other' };
      expect(isTestMerchantId('merch_new_rig', env)).toBe(true);
      expect(isTestMerchantId('merch_other', env)).toBe(true);
    });

    test('cannot un-exclude a baked-in rig even if env is empty/absent', () => {
      expect(isTestMerchantId('merch_efbc46b4619cfbdf', {})).toBe(true);
      expect(isTestMerchantId('merch_efbc46b4619cfbdf', { PIVOTA_TEST_MERCHANT_IDS: '' })).toBe(true);
      expect(getTestMerchantIds({})).toEqual(expect.arrayContaining(TEST_MERCHANT_IDS));
    });
  });

  describe('notTestMerchantSql', () => {
    test('merchant-id leg lists every effective rig id', () => {
      const sql = notTestMerchantSql('cp');
      expect(sql).toContain('cp.merchant_id NOT IN (');
      for (const id of TEST_MERCHANT_IDS) {
        expect(sql).toContain(`'${id}'`);
      }
    });

    test('omits the source_domain leg unless the table has that column', () => {
      expect(notTestMerchantSql('pc')).not.toContain('source_domain');
      expect(notTestMerchantSql('cp', { hasSourceDomain: true })).toContain(
        "coalesce(cp.source_domain, '') NOT LIKE 'pivota-review-demo%'",
      );
    });

    test('escapes single quotes in env-supplied ids (no SQL break-out)', () => {
      const sql = notTestMerchantSql('cp', { env: { PIVOTA_TEST_MERCHANT_IDS: "m') OR ('1'='1" } });
      expect(sql).toContain("''"); // the embedded quote is doubled, not left bare
      expect(sql).not.toContain("m') OR ('1'='1");
    });
  });
});

describe('activeCatalogSourceSql inherits the test-merchant exclusion', () => {
  test('catalog gate excludes rigs OUTSIDE the external_seed OR (rig cannot slip through it)', () => {
    const sql = activeCatalogProductSourceWhere('cp', 'cm');
    // The exclusion must AND the whole disjunction, not sit inside it.
    const excl = "cp.merchant_id NOT IN ('merch_efbc46b4619cfbdf'";
    const seedBranch = "cp.merchant_id = 'external_seed'";
    expect(sql).toContain(excl);
    expect(sql).toContain(seedBranch);
    expect(sql.indexOf(excl)).toBeLessThan(sql.indexOf(seedBranch));
    // Balanced parens (guards the hand-managed nesting).
    let bal = 0;
    for (const ch of sql) {
      if (ch === '(') bal++;
      else if (ch === ')') bal--;
    }
    expect(bal).toBe(0);
  });

  test('catalog gate carries the demo-domain leg (re-connected rig under a new id)', () => {
    expect(activeCatalogProductSourceWhere('cp', 'cm')).toContain('pivota-review-demo%');
  });

  test('products_cache gate excludes rigs but omits source_domain (no such column)', () => {
    const sql = activeProductsCacheSourceWhere('pc');
    expect(sql).toContain("pc.merchant_id NOT IN ('merch_efbc46b4619cfbdf'");
    expect(sql).not.toContain('source_domain');
    let bal = 0;
    for (const ch of sql) {
      if (ch === '(') bal++;
      else if (ch === ')') bal--;
    }
    expect(bal).toBe(0);
  });

  test('legacy external_seed + ADR-009 observed sellers still admitted', () => {
    const sql = activeCatalogProductSourceWhere('cp', 'cm');
    expect(sql).toContain("cp.merchant_id = 'external_seed'");
    expect(sql).toContain("lower(coalesce(cm.status, 'active')) IN ('active', 'observed')");
  });
});
