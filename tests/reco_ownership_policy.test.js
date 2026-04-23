const {
  shouldKeepTypedRecoRequestOnV1Mainline,
  shouldProxyFrameworkRecoToV1Mainline,
  looksLikeBeautyExactProductAssistAsk,
} = require('../src/auroraBff/recoOwnershipPolicy');

describe('recoOwnershipPolicy beauty exact-product routing', () => {
  test('exact-product beauty asks stay on v1 mainline', () => {
    const request = {
      message: 'Is Beauty of Joseon Relief Sun Aqua-Fresh good for oily skin under makeup?',
      context: {
        normalized_need: {
          beauty_request: {
            domain: 'beauty',
            product_context: {
              canonical_product_ref: 'boj_relief_sun_aqua_fresh',
            },
          },
        },
      },
    };

    expect(looksLikeBeautyExactProductAssistAsk(request)).toBe(true);
    expect(shouldKeepTypedRecoRequestOnV1Mainline(request)).toBe(true);
    expect(shouldProxyFrameworkRecoToV1Mainline(request)).toBe(true);
  });

  test('non-beauty exact-product comparisons do not become beauty reco proxies', () => {
    const request = {
      message: 'Is Breville Bambino better than Barista Express for a small kitchen?',
      context: {
        normalized_need: {
          commerce_request: {
            domain: 'appliances',
          },
        },
      },
    };

    expect(looksLikeBeautyExactProductAssistAsk(request)).toBe(false);
    expect(shouldProxyFrameworkRecoToV1Mainline(request)).toBe(false);
  });
});
