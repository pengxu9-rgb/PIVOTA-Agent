const { resolveSearchProfile } = require('../src/findProductsMulti/profiles/profileEngine');

describe('find_products_multi profile engine', () => {
  test('resolves explicit hint', () => {
    const resolved = resolveSearchProfile({
      hint: 'fragrance_strict',
      queryText: 'random query',
      queryClass: 'exploratory',
    });
    expect(resolved.profile.id).toBe('fragrance_strict');
    expect(resolved.confidence).toBe('hint');
    expect(resolved.reason).toBe('explicit_profile_hint');
  });

  test('resolves fragrance query to strict profile', () => {
    const resolved = resolveSearchProfile({
      queryText: 'best perfume for night out',
      queryClass: 'category',
    });
    expect(resolved.profile.id).toBe('fragrance_strict');
    expect(resolved.profile.ambiguityPolicy).toBe('search_first');
    expect(Array.isArray(resolved.rulesApplied)).toBe(true);
    expect(resolved.rulesApplied.some((rule) => rule.includes('profile:fragrance_strict'))).toBe(true);
  });

  test('resolves brand query to broad brand profile', () => {
    const resolved = resolveSearchProfile({
      queryText: 'tom ford',
      queryClass: 'brand',
    });
    expect(resolved.profile.id).toBe('brand_broad');
    expect(resolved.profile.ambiguityPolicy).toBe('search_first');
    expect(Array.isArray(resolved.rulesApplied)).toBe(true);
    expect(resolved.rulesApplied.some((rule) => rule.includes('profile:brand_broad'))).toBe(true);
  });

  test('keeps category-scoped profile when brand query includes fragrance intent', () => {
    const resolved = resolveSearchProfile({
      queryText: 'dior perfume',
      queryClass: 'brand',
    });
    expect(resolved.profile.id).toBe('fragrance_strict');
  });

  test('resolves lingerie query to strict lingerie profile', () => {
    const resolved = resolveSearchProfile({
      queryText: 'lingerie set',
      queryClass: 'category',
    });
    expect(resolved.profile.id).toBe('lingerie_strict');
    expect(resolved.profile.filterPolicy.mode).toBe('strict_allow_block');
  });

  test('falls back to general profile', () => {
    const resolved = resolveSearchProfile({
      queryText: 'desk lamp',
      queryClass: 'lookup',
    });
    expect(resolved.profile.id).toBe('general');
    expect(resolved.reason).toBe('fallback_general');
  });
});
