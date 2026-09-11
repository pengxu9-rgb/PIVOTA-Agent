// What the two `platform` spellings actually cost, measured on the shapes the code really emits.
//
// THE SPLIT. Production `catalog_products.platform` is `external_seed` on 13,896 of 15,516 rows and
// `external` on ZERO. Four builders mint `external` IN MEMORY at serve time — src/server.js:16736,
// services/externalSeedProducts.js:4520 and :4816, services/RecommendationEngine.js:2356 — so the
// value exists only in objects, never in a table. That is how a DB census reads `external` as dead
// vocabulary while a served response does not, and how it survived since 2026-05-01.
//
// THE DISJOINTNESS IS REAL BUT LATENT. For a row carrying ONLY a platform signal the two predicates
// disagree in opposite directions (pinned below). But **no builder emits such a row**: all FOUR
// stamp `source: 'external_seed'` on the same object literal, 15-25 lines from the platform line.
// An earlier version of this file claimed three of them did not, from a +-6 line window, and drew
// its conclusion from a shape nothing produces. Corrected here; the window is why.
//
// SO WHAT DOES A PRODUCER FLIP ACTUALLY COST? On the shape builders really emit, exactly one
// predicate moves — the lane owner, false -> true. pdpBuilder and externalSeedIdentity are
// unchanged, because `source` already carries recognition for them. That is a WIDENING of
// isExternalSeedLaneProduct at its ~10 call sites (auroraBff/routes.js, server.js,
// publicReadChainResolvability, guidanceFastpath), and it is the real thing to measure before any
// such change — not a loss of recognition, which is what the earlier version wrongly predicted.

const { isExternalSeedLikeProduct } = require('../src/pdpBuilder');
const { isExternalSeedLaneProduct } = require('../src/services/externalSeedLane');
const { isExternalSeedRow } = require('../src/externalSeedIdentity');

// Verbatim field pairs from the four builders: platform AND source, which is what they emit.
const AS_BUILT = { merchant_id: 'merch_obs_x', platform: 'external', source: 'external_seed' };
const AFTER_FLIP = { merchant_id: 'merch_obs_x', platform: 'external_seed', source: 'external_seed' };

describe('every builder stamps source alongside platform', () => {
  const fs = require('fs');
  const path = require('path');
  // The files are named; the LINES are found. Hardcoding line numbers across worktrees is what
  // produced the false premise this file corrects — a +-6 line window anchored on a number that
  // was right in one checkout and pointed at a comment in another.
  const FILES = [
    'src/server.js',
    'src/services/externalSeedProducts.js',
    'src/services/RecommendationEngine.js',
  ];

  test.each(FILES)('%s: every platform:external stamp has source:external_seed beside it', (rel) => {
    const lines = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').split('\n');
    const sites = lines
      .map((text, i) => ({ line: i + 1, text }))
      .filter((l) => /platform:\s*'external'\s*,/.test(l.text));
    expect(sites.length).toBeGreaterThan(0);

    for (const site of sites) {
      // 30 lines: the nearest source stamp is 15 away and the furthest 25.
      const window = lines.slice(site.line - 1, site.line + 30).join('\n');
      expect({ site: `${rel}:${site.line}`, hasSource: /source:\s*'external_seed'/.test(window) })
        .toEqual({ site: `${rel}:${site.line}`, hasSource: true });
    }
  });

  test('there are exactly four such builders', () => {
    let n = 0;
    for (const rel of FILES) {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      n += (src.match(/platform:\s*'external'\s*,/g) || []).length;
    }
    expect(n).toBe(4);
  });
});

describe('the disjointness is real, and latent', () => {
  const onlyOld = { merchant_id: 'merch_obs_x', platform: 'external' };
  const onlyNew = { merchant_id: 'merch_obs_x', platform: 'external_seed' };

  test('on a platform-only row the two predicates are mirror images', () => {
    expect(isExternalSeedLikeProduct(onlyOld)).toBe(true);
    expect(isExternalSeedLikeProduct(onlyNew)).toBe(false);
    expect(isExternalSeedLaneProduct(onlyOld)).toBe(false);
    expect(isExternalSeedLaneProduct(onlyNew)).toBe(true);
  });

  test('but the rows builders emit are recognised by both, before AND after a flip', () => {
    // This is the assertion that makes the disjointness latent rather than live, and the one the
    // earlier version of this file got backwards.
    expect(isExternalSeedLikeProduct(AS_BUILT)).toBe(true);
    expect(isExternalSeedLikeProduct(AFTER_FLIP)).toBe(true);
    expect(isExternalSeedRow(AS_BUILT)).toBe(true);
    expect(isExternalSeedRow(AFTER_FLIP)).toBe(true);
  });
});

describe('the one predicate a producer flip would move', () => {
  test('isExternalSeedLaneProduct goes false -> true for the emitted shape', () => {
    // Not a loss of recognition — a WIDENING, at the lane owner's ~10 call sites. Anyone attempting
    // the flip must measure those, and this is the assertion that says which ones to look at.
    expect(isExternalSeedLaneProduct(AS_BUILT)).toBe(false);
    expect(isExternalSeedLaneProduct(AFTER_FLIP)).toBe(true);
  });

  test('an internal merchant row is recognised by none of the three, either way', () => {
    const internal = { merchant_id: 'merch_efbc46b4619cfbdf', platform: 'shopify', source: 'merchant_public' };
    expect(isExternalSeedLikeProduct(internal)).toBe(false);
    expect(isExternalSeedLaneProduct(internal)).toBe(false);
    expect(isExternalSeedRow(internal)).toBe(false);
  });
});
