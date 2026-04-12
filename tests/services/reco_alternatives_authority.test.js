const {
  normalizeAuthorityText,
  buildRecoAuthorityAliasTokens,
  buildRecoAuthorityQueryVariants,
  buildRecoAuthoritySearchAliases,
} = require('../../src/services/recoAlternativesAuthority');

describe('recoAlternativesAuthority', () => {
  test('normalizes punctuation and SPF formatting for authority matching', () => {
    expect(
      normalizeAuthorityText("La Roche-Posay Anthelios Ultra-Light Invisible Fluid SPF 50+"),
    ).toBe('la roche posay anthelios ultra light invisible fluid spf 50 plus');
  });

  test('builds alias tokens with shortened normalized phrases and SPF variants', () => {
    const aliases = buildRecoAuthorityAliasTokens({
      brand: 'Skin1004',
      name: 'Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+',
      category: 'Sunscreen',
      searchAliases: ['Water-Fit Sun Serum'],
    });

    expect(aliases).toEqual(
      expect.arrayContaining([
        'madagascar centella hyalu cica water fit sun serum spf50+',
        'madagascar centella hyalu cica water fit sun serum spf 50 plus',
      ]),
    );
    expect(aliases.some((item) => item.includes('water fit'))).toBe(true);
    expect(aliases.some((item) => item.includes('sun serum'))).toBe(true);
    expect(aliases.some((item) => item.includes('spf50'))).toBe(true);
  });

  test('builds ordered authority query variants without duplicate punctuation forms', () => {
    const variants = buildRecoAuthorityQueryVariants({
      brand: "Paula’s Choice",
      name: "10% Niacinamide Booster",
      category: 'Serum',
      searchAliases: ['Niacinamide Booster'],
    });

    expect(variants.slice(0, 4)).toEqual([
      expect.objectContaining({ query: "Paula’s Choice 10% Niacinamide Booster", kind: 'brand_name_exact' }),
      expect.objectContaining({ query: 'paulas choice 10 percent niacinamide booster', kind: 'brand_name_normalized' }),
      expect.objectContaining({ query: '10% Niacinamide Booster', kind: 'name_exact' }),
      expect.objectContaining({ query: '10 percent niacinamide booster', kind: 'name_normalized' }),
    ]);
  });

  test('builds resolver search aliases from normalized query pack', () => {
    const aliases = buildRecoAuthoritySearchAliases({
      brand: 'La Roche-Posay',
      name: 'Anthelios Ultra-Light Invisible Fluid SPF 50+',
      category: 'Sunscreen',
      maxAliases: 6,
    });

    expect(aliases).toEqual(
      expect.arrayContaining([
        'La Roche-Posay Anthelios Ultra-Light Invisible Fluid SPF 50+',
        'la roche posay anthelios ultra light invisible fluid spf 50 plus',
        'Anthelios Ultra-Light Invisible Fluid SPF 50+',
        'anthelios ultra light invisible fluid spf 50 plus',
      ]),
    );
    expect(aliases.length).toBeLessThanOrEqual(6);
  });
});
