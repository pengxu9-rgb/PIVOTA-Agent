'use strict';
/**
 * Curated PDP meta registry rules (fabrication-belt F3, 2026-08-11).
 *
 * The predecessor (fashionMetaSamples.js) mixed fabricated `sample_*` demo
 * entries with one hand-curated entry for a real live product. The registry is
 * now structural: real catalog ids only, and every entry must carry provenance
 * with public sources. These tests are the enforcement.
 */

const {
  CURATED_FASHION_META,
  CURATED_ELECTRONICS_META,
  CURATED_PROVENANCE,
  lookupCuratedFashionMeta,
  lookupCuratedElectronicsMeta,
} = require('../src/curatedPdpMeta');

const allEntries = { ...CURATED_FASHION_META, ...CURATED_ELECTRONICS_META };

describe('curated PDP meta registry', () => {
  test('no fabricated sample_* ids may return', () => {
    for (const key of Object.keys(allEntries)) {
      expect(key.startsWith('sample_')).toBe(false);
    }
  });

  test('every entry is keyed by a real catalog sig', () => {
    for (const key of Object.keys(allEntries)) {
      expect(key).toMatch(/^sig_[0-9a-f]{32}$/);
    }
  });

  test('every entry has provenance with at least one https source', () => {
    for (const key of Object.keys(allEntries)) {
      const prov = CURATED_PROVENANCE[key];
      expect(prov).toBeDefined();
      expect(Array.isArray(prov.sources)).toBe(true);
      expect(prov.sources.length).toBeGreaterThanOrEqual(1);
      for (const src of prov.sources) {
        expect(src).toMatch(/^https:\/\//);
      }
    }
  });

  test('no entry states merchant facts (pricing / warranties / stock)', () => {
    // protection_plans was the exact violation the predecessor's demo entries
    // carried (a warranty upsell the merchant does not sell).
    for (const [key, entry] of Object.entries(allEntries)) {
      expect(Object.keys(entry)).not.toContain('protection_plans');
      const flat = JSON.stringify(entry).toLowerCase();
      expect(flat.includes('"price"')).toBe(false);
    }
  });

  test('the live Sony entry still serves through the lookups', () => {
    const sony = lookupCuratedElectronicsMeta('sig_c08b9e75f8c297dbe23795f2b22d1214');
    expect(sony).not.toBeNull();
    expect(sony.spec_groups.length).toBeGreaterThan(0);
    expect(lookupCuratedFashionMeta('sig_c08b9e75f8c297dbe23795f2b22d1214')).toBeNull();
    expect(lookupCuratedElectronicsMeta('sample_electronics_wh1000xm5')).toBeNull();
  });
});
