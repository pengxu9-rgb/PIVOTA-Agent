const {
  _internals: {
    extractSize,
    dropPlaceholderVariantsWhenSafe,
    hasOnlyNonDisplayableVariants,
    hydrateFlatVariantOptions,
    inferSingleSkuSpecFromTitle,
    isLikelyNonProductSourceHtml,
    sanitizeJsonPayload,
    buildVariantOnlySeedPatch,
    buildSingleVariantFromSpec,
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

  test('variant-only DB patch strips legacy long-form variant fields', () => {
    const patch = buildVariantOnlySeedPatch({
      variants: [{
        title: 'Mini',
        option_name: 'Format',
        option_value: 'Mini',
        image_urls: ['https://example.com/legacy.jpg'],
        description: 'legacy long text',
      }],
      snapshot: {},
    });
    expect(patch.rootPatch.variants).toEqual([{
      title: 'Mini',
      option_name: 'Format',
      option_value: 'Mini',
    }]);
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

  test('builds a force-filled single variant when a row has no variants', () => {
    expect(
      buildSingleVariantFromSpec(
        { external_product_id: 'ext_missing_variants' },
        { value: 'Single item', optionName: 'Format', axisKind: 'format' },
      ),
    ).toEqual({
      variant_id: 'ext_missing_variants:single',
      sku_id: 'ext_missing_variants',
      title: 'Single item',
      options: [{ name: 'Format', value: 'Single item', axis_kind: 'format' }],
      option_name: 'Format',
      option_value: 'Single item',
      display_label: 'Format: Single item',
      axis_kind: 'format',
      source_quality_status: 'captured',
      force_filled: true,
    });
  });

  test('hydrates flat variant option fields into displayable options arrays', () => {
    const result = hydrateFlatVariantOptions([
      {
        title: 'Risky Rose',
        option_name: 'shade',
        option_value: 'risky rose',
      },
    ]);
    expect(result).toEqual({
      changed: true,
      variants: [
        {
          title: 'Risky Rose',
          option_name: 'Shade',
          option_value: 'risky rose',
          options: [{ name: 'Shade', value: 'risky rose', axis_kind: 'shade' }],
          display_label: 'Shade: risky rose',
          axis_kind: 'shade',
          source_quality_status: 'captured',
        },
      ],
    });
  });

  test('hydrates object-shaped variant options into displayable options arrays', () => {
    const result = hydrateFlatVariantOptions([
      {
        title: '40ml',
        options: { Size: '40ml' },
      },
    ]);
    expect(result.changed).toBe(true);
    expect(result.variants[0].options).toEqual([{ name: 'Size', value: '40ml', axis_kind: 'size' }]);
    expect(result.variants[0].display_label).toBe('Size: 40ml');
  });

  test('splits color-size mini descriptors into shade and size options', () => {
    const result = hydrateFlatVariantOptions([
      {
        title: 'Hot Cherry / Mini',
        option_name: 'Color / Size',
        option_value: 'Hot Cherry / Mini',
      },
    ]);

    expect(result.changed).toBe(true);
    expect(result.variants[0].options).toEqual([
      { name: 'Shade', value: 'Hot Cherry', axis_kind: 'shade' },
      { name: 'Size', value: 'Mini', axis_kind: 'size' },
    ]);
    expect(result.variants[0].option_name).toBeUndefined();
    expect(result.variants[0].option_value).toBeUndefined();
    expect(result.variants[0].display_label).toBeUndefined();
    expect(result.variants[0].axis_kind).toBeUndefined();
  });

  test('splits already-array color-size mini options before DB patching', () => {
    const result = hydrateFlatVariantOptions([
      {
        title: 'Hot Cherry / Mini',
        options: [{ name: 'Color / Size', value: 'Hot Cherry / Mini', axis_kind: 'color_size' }],
        display_label: 'Color / Size: Hot Cherry / Mini',
        axis_kind: 'color_size',
      },
    ]);

    expect(result.changed).toBe(true);
    expect(result.variants[0].options).toEqual([
      { name: 'Shade', value: 'Hot Cherry', axis_kind: 'shade' },
      { name: 'Size', value: 'Mini', axis_kind: 'size' },
    ]);
    expect(result.variants[0].option_name).toBeUndefined();
    expect(result.variants[0].option_value).toBeUndefined();
    expect(result.variants[0].display_label).toBeUndefined();
    expect(result.variants[0].axis_kind).toBeUndefined();
  });

  test('detects multi-variant lists that have no displayable options', () => {
    expect(
      hasOnlyNonDisplayableVariants(
        { variants: [{ title: 'Default', options: [] }, { title: 'Default', options: [] }] },
        {},
      ),
    ).toBe(true);
    expect(
      hasOnlyNonDisplayableVariants(
        { variants: [{ title: 'Mini', options: [{ name: 'Format', value: 'Mini' }] }] },
        {},
      ),
    ).toBe(false);
  });
});
