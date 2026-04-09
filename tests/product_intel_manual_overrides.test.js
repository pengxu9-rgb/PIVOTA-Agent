const manualOverrides = require('../scripts/fixtures/product_intel_manual_overrides.json');

describe('product intel manual overrides', () => {
  test('seller-only curated highlights avoid abstract positioning copy', () => {
    const bannedPatterns = [
      /\bpositions? itself\b/i,
      /\bcenters? its\b.*\bstory\b/i,
      /\bbuilds? its\b.*\bstory\b/i,
      /\bformula story\b/i,
      /\bvisible-[a-z-]+\s+story\b/i,
      /\bpositioning\b/i,
      /\bframes? itself as\b/i,
      /\bleans toward\b/i,
      /\bdedicated treatment step\b/i,
      /\brole\b/i,
      /\bformat\b/i,
    ];

    Object.entries(manualOverrides).forEach(([key, override]) => {
      const highlights = override?.product_intel_core?.why_it_stands_out || [];
      highlights.forEach((item) => {
        const text = `${item?.headline || ''} ${item?.body || ''}`;
        bannedPatterns.forEach((pattern) => {
          expect(text).not.toMatch(pattern);
        });
      });
      expect(highlights.length).toBeLessThanOrEqual(2);
      expect(override?.product_intel_core?.what_it_is?.body || '').not.toMatch(/\bour\s+/i);
    });
  });
});
