const {
  _internals: {
    extractSize,
    dropPlaceholderVariantsWhenSafe,
    inferSingleSkuSpecFromTitle,
    isLikelyNonProductSourceHtml,
    sanitizeJsonPayload,
    buildVariantOnlySeedPatch,
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
      measured: false,
      optionName: 'Format',
      axisKind: 'format',
      value: 'Single mask',
    });
    expect(
      inferSingleSkuSpecFromTitle(
        { title: 'Sheet Mask Set of 5' },
        {},
        {},
      ),
    ).toEqual({
      size: 'Set',
      value: 'Set',
      optionName: 'Format',
      axisKind: 'format',
      source: 'reviewed_title_pattern',
      evidence: 'Sheet Mask Set of 5',
      measured: false,
    });
  });

  test('force-fills single SKU selector labels from title shade or generic format', () => {
    expect(
      inferSingleSkuSpecFromTitle(
        { title: 'Gloss Bomb Cream Color Drip Lip Cream — Fruit Snackz' },
        {},
        {},
      ),
    ).toEqual({
      size: 'Fruit Snackz',
      value: 'Fruit Snackz',
      optionName: 'Shade',
      axisKind: 'shade',
      source: 'reviewed_title_pattern',
      evidence: 'Gloss Bomb Cream Color Drip Lip Cream — Fruit Snackz',
      measured: false,
    });
    expect(
      inferSingleSkuSpecFromTitle(
        { title: 'Tone Brightening Tone-Up Sunscreen' },
        {},
        {},
      ),
    ).toEqual({
      size: 'Single item',
      value: 'Single item',
      optionName: 'Format',
      axisKind: 'format',
      source: 'force_filled_single_sku_default',
      evidence: 'Tone Brightening Tone-Up Sunscreen',
      measured: false,
    });
  });

  test('removes actual and escaped null byte sequences before JSONB writes', () => {
    const payload = sanitizeJsonPayload({
      title: 'Clean\u0000Title',
      nested: {
        raw: 'escaped \\u0000 and double \\\\u0000 values',
      },
    });
    expect(payload).not.toContain('\u0000');
    expect(payload).not.toMatch(/\\+u0000/i);
    expect(JSON.parse(payload)).toEqual({
      title: 'CleanTitle',
      nested: {
        raw: 'escaped  and double  values',
      },
    });
  });

  test('variant-only DB patch excludes legacy snapshot fields', () => {
    const patch = buildVariantOnlySeedPatch({
      variants: [{ title: 'Single item' }],
      variant_detail_label: 'Format: Single item',
      legacy_raw_html: '<div>do not rewrite</div>',
      snapshot: {
        variants: [{ title: 'Single item' }],
        variant_detail_label: 'Format: Single item',
        pdp_description_raw: 'do not replace',
      },
    });
    expect(patch).toEqual({
      rootPatch: {
        variants: [{ title: 'Single item' }],
        variant_detail_label: 'Format: Single item',
      },
      snapshotPatch: {
        variants: [{ title: 'Single item' }],
        variant_detail_label: 'Format: Single item',
      },
    });
  });

  test('drops blocked default variants only when real displayable variants exist', () => {
    const real = {
      title: 'Mini',
      options: [{ name: 'Format', value: 'Mini', axis_kind: 'format' }],
      source_quality_status: 'captured',
    };
    const placeholder = {
      title: 'Default',
      options: [],
      source_quality_status: 'blocked',
    };
    expect(dropPlaceholderVariantsWhenSafe([real, placeholder])).toEqual({
      variants: [real],
      removed: 1,
    });
    expect(dropPlaceholderVariantsWhenSafe([placeholder])).toEqual({
      variants: [placeholder],
      removed: 0,
    });
  });
});
