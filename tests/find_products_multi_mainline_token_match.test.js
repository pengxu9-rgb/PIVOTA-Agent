'use strict';

/**
 * #1933 — the buyable beauty mainline lane must run the canonical token-match
 * tokenizer on its own flag, not on PIVOT_BEAUTY_ACTIVE_AWARE_RECALL_ENABLED.
 *
 * WHY THIS TEST EXISTS. The mainline call site passed
 * `tokenMatch: PIVOT_BEAUTY_ACTIVE_AWARE_RECALL_ENABLED`. That flag otherwise
 * gates two seed-lane recall expansions (active surface forms as recall
 * patterns; the ingredient_tokens/alias_tokens SQL arms) which have nothing to
 * do with the canonical tokenizer — `tokenMatch` drives buildSignificantTokens,
 * the GENERIC one. The coupling meant the rank fix could not ship without the
 * recall expansion, so in prod — where the flag is unset — the mainline rank
 * ladder was dark: every row in a category bucket tied on the flat +90 bucket
 * bonus and ordering fell to the tie-break.
 *
 * Prod 2026-08-07 measured the cost of that darkness, as the mean number of
 * query tokens appearing in the top-8 titles: "lightweight gel moisturizer for
 * acne-prone skin" scored 0.00 — not one of the eight rows served at the head
 * contained a single word of the query. With the tokenizer on: 2.13.
 *
 * These tests pin the DECOUPLING, which is the substance of the fix. The
 * tokenizer's own SQL behaviour is covered in canonical_catalog_search.test.js
 * ("tokenMatch ON adds token-overlap WHERE + rank + binds").
 */

const SERVER_PATH = require.resolve('../src/server.js');

const FLAG_KEYS = [
  'PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED',
  'PIVOT_BEAUTY_ACTIVE_AWARE_RECALL_ENABLED',
];

function loadServer(flags = {}) {
  let mod;
  jest.isolateModules(() => {
    const prev = {};
    for (const key of FLAG_KEYS) {
      prev[key] = process.env[key];
      if (flags[key] === undefined) delete process.env[key];
      else process.env[key] = flags[key];
    }
    try {
      mod = require(SERVER_PATH);
    } finally {
      for (const key of FLAG_KEYS) {
        if (prev[key] == null) delete process.env[key];
        else process.env[key] = prev[key];
      }
    }
  });
  return mod._debug;
}

describe('#1933 mainline canonical tokenMatch flag', () => {
  test('defaults OFF when unset — serving is unchanged until deliberately enabled', () => {
    const { PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED: enabled } = loadServer({});
    expect(enabled).toBe(false);
  });

  test('its own flag turns it on', () => {
    for (const value of ['true', '1', 'yes']) {
      const { PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED: enabled } = loadServer({
        PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED: value,
      });
      expect(enabled).toBe(true);
    }
  });

  test('ACTIVE_AWARE_RECALL alone does NOT turn it on — the #1933 coupling is gone', () => {
    const { PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED: enabled } = loadServer({
      PIVOT_BEAUTY_ACTIVE_AWARE_RECALL_ENABLED: 'true',
    });
    expect(enabled).toBe(false);
  });

  test('ACTIVE_AWARE_RECALL off does NOT hold it off — this is the prod state that hid the defect', () => {
    // Exactly the production configuration on 2026-08-07: the active-aware
    // flag unset, which used to force tokenMatch:false on the mainline.
    const { PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED: enabled } = loadServer({
      PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED: 'true',
      PIVOT_BEAUTY_ACTIVE_AWARE_RECALL_ENABLED: undefined,
    });
    expect(enabled).toBe(true);
  });

  test('the two flags are independent in all four combinations', () => {
    const combos = [
      { mainline: undefined, active: undefined, expected: false },
      { mainline: undefined, active: 'true', expected: false },
      { mainline: 'true', active: undefined, expected: true },
      { mainline: 'true', active: 'true', expected: true },
    ];
    for (const { mainline, active, expected } of combos) {
      const { PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED: enabled } = loadServer({
        PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED: mainline,
        PIVOT_BEAUTY_ACTIVE_AWARE_RECALL_ENABLED: active,
      });
      expect(enabled).toBe(expected);
    }
  });
});

describe('#1933 the mainline call site reads the new flag', () => {
  // Source-level assertion: the call site must not reference the old flag for
  // tokenMatch. A behavioural test would need the 12k-line handler booted with
  // a full intent/db/market fixture; this pins the one line that regressed.
  const fs = require('node:fs');
  const source = fs.readFileSync(SERVER_PATH, 'utf8');

  test('tokenMatch is wired to PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED', () => {
    expect(source).toContain('tokenMatch: PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED');
  });

  test('no canonical call site passes tokenMatch: PIVOT_BEAUTY_ACTIVE_AWARE_RECALL_ENABLED', () => {
    expect(source).not.toContain('tokenMatch: PIVOT_BEAUTY_ACTIVE_AWARE_RECALL_ENABLED');
  });

  test('the active-aware flag still gates its own two seed-lane recall arms', () => {
    // The decoupling must not have deleted the flag's legitimate uses.
    const uses = source.split('PIVOT_BEAUTY_ACTIVE_AWARE_RECALL_ENABLED').length - 1;
    expect(uses).toBeGreaterThanOrEqual(3); // declaration + 2 seed-lane sites
  });
});
