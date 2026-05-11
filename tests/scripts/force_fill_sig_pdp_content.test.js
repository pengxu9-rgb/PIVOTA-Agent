const {
  _internals: {
    extractSize,
    inferSingleSkuSpecFromTitle,
    isLikelyNonProductSourceHtml,
  },
} = require('../../scripts/force-fill-sig-pdp-content.cjs');

describe('force-fill SIG PDP content script', () => {
  test('extractSize ignores logistics-scale units that commonly appear in page chrome', () => {
    expect(extractSize('shipping carton volume 4.56 L')).toBe('');
    expect(extractSize('package weight 2.1 lbs')).toBe('');
    expect(extractSize('warehouse package 1 kg')).toBe('');
    expect(extractSize('serum 30 ml')).toBe('30 mL');
    expect(extractSize('cream 1.7 fl oz')).toBe('1.7 fl oz');
    expect(extractSize('box of 10 sheets')).toBe('10 sheets');
  });

  test('detects Shopify 404 templates before using source HTML as product evidence', () => {
    expect(isLikelyNonProductSourceHtml('<script>{"template":"404","product":null}</script>')).toBe(true);
    expect(isLikelyNonProductSourceHtml('<script>var payload = { page_type: "404" }</script>')).toBe(true);
    expect(isLikelyNonProductSourceHtml('<title>404 Not Found</title>')).toBe(true);
    expect(isLikelyNonProductSourceHtml('<meta property="og:title" content="Spicule Shot Boosting Mask">')).toBe(false);
  });

  test('uses conservative single-mask selector label for single SKU masks without measured size', () => {
    expect(
      inferSingleSkuSpecFromTitle(
        { title: 'Spicule Shot Boosting Mask' },
        {},
        {},
      ),
    ).toEqual({
      size: 'Single mask',
      source: 'reviewed_title_pattern',
      evidence: 'Spicule Shot Boosting Mask',
    });
    expect(
      inferSingleSkuSpecFromTitle(
        { title: 'Sheet Mask Set of 5' },
        {},
        {},
      ),
    ).toBeNull();
  });
});
