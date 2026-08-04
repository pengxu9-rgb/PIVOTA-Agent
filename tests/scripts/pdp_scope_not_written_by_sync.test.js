/**
 * The external-seed sync lanes must not touch pdp_scope AT ALL.
 *
 * The classifier (pivota-backend services/pdp_scope_classifier) is the only
 * authority on the column; rows land on the DB default 'unverified' (NOT NULL,
 * migration 070) and are promoted by classifier-backed writers. These lanes
 * used to stamp 'multi_merchant_canonical' unconditionally and re-assert it on
 * every conflict — measured 2026-08-04: 3,182 of 3,400 such rows had fewer
 * than two sellers, each wrongly carrying a +200 rank term and the
 * market-filter exemption. See pivota-backend docs/PDP_SCOPE_REDESIGN.md (P1).
 *
 * This is a SOURCE SCAN, stated plainly: these scripts have no DB-fixture
 * harness, and the property being asserted — "this file does not reference the
 * column" — is exactly what a source scan checks directly. The semantics
 * (fresh row lands 'unverified'; a conflict re-run preserves an existing
 * scope) were proven by executing the real extracted statements against
 * Postgres 15 before this landed; the probe is reproducible from the PR.
 */
const fs = require('fs');
const path = require('path');

const SYNC_SCRIPTS = [
  'scripts/sync-external-seeds-to-catalog.cjs',
  'scripts/sync-ulta-external-seeds-to-catalog.cjs',
];

function codeOnly(source) {
  // Strip // line comments and SQL -- comments; the explanatory comments in
  // the sync scripts legitimately NAME the column while forbidding it.
  return source
    .split('\n')
    .filter((l) => !/^\s*(\/\/|--)/.test(l))
    .join('\n');
}

describe('pdp_scope is owned by the classifier, not the sync lanes', () => {
  for (const rel of SYNC_SCRIPTS) {
    test(`${rel} never references pdp_scope`, () => {
      const src = fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
      const offenders = codeOnly(src)
        .split('\n')
        .map((l, i) => (l.includes('pdp_scope') ? `${rel}:${i + 1}: ${l.trim()}` : null))
        .filter(Boolean);
      expect(offenders).toEqual([]);
    });
  }

  test('the scan itself is live (positive control)', () => {
    // A scan that matches nothing reads as coverage while checking nothing.
    // canonicalCatalogSearch legitimately READS the column; the same scan
    // applied there must fire, or codeOnly()/the regex has rotted.
    const reader = fs.readFileSync(
      path.join(__dirname, '../..', 'src/services/canonicalCatalogSearch.js'),
      'utf8',
    );
    expect(codeOnly(reader).includes('pdp_scope')).toBe(true);
  });
});
