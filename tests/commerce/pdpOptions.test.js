const {
  shouldIncludePdp,
  getPdpOptions,
} = require('../../src/commerce/pdp/options');

describe('pdp options helpers', () => {
  test('detects pdp inclusion from view and include list', () => {
    expect(shouldIncludePdp({ view: 'pdp' })).toBe(true);
    expect(shouldIncludePdp({ include: ['offers', 'pdp'] })).toBe(true);
    expect(shouldIncludePdp({ include: ['pdp_payload'] })).toBe(true);
    expect(shouldIncludePdp({ include: ['offers'] })).toBe(false);
  });

  test('normalizes pdp options from payload fields', () => {
    expect(
      getPdpOptions({
        include: ['recommendations', 'reviews_preview'],
        template_hint: 'compact',
        context: {
          entry_point: 'detail',
          experiment: 'exp_a',
          debug: true,
        },
      }),
    ).toEqual({
      includeRecommendations: true,
      includeEmptyReviews: true,
      templateHint: 'compact',
      entryPoint: 'detail',
      experiment: 'exp_a',
      debug: true,
    });
  });
});
