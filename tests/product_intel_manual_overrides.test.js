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
      /\bdaily moisture plus brightening support\b/i,
      /\bglow and hydration in one serum\b/i,
      /\bricher overnight cream texture\b/i,
      /\blotion step between serum and cream\b/i,
      /\btargeted under-eye application\b/i,
      /\bgel-cream daily texture\b/i,
      /\bdedicated dark-spot serum\b/i,
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
