const {
  BEAUTY_ATTRIBUTE_FIELDS,
  normalizeKey,
  validateExtractionPayload,
  hasGateableAttributes,
  lookupBeautyAttributes,
  lookupBeautyAttributesBatch,
  upsertBeautyAttributes,
} = require('../src/auroraBff/productBeautyAttributes');

describe('product beauty attributes helpers', () => {
  test('normalizeKey strips the relation-graph product: prefix', () => {
    expect(normalizeKey('product:ext_abc123')).toBe('ext_abc123');
    expect(normalizeKey('ext_abc123')).toBe('ext_abc123');
    expect(normalizeKey('  product:ext_pad  ')).toBe('ext_pad');
    expect(normalizeKey(null)).toBe('');
    expect(normalizeKey('')).toBe('');
  });

  test('validateExtractionPayload accepts a fully-formed payload', () => {
    const result = validateExtractionPayload({
      product_key: 'ext_abc',
      product_form: 'lipstick',
      product_form_confidence: 0.92,
      target_area: 'lips',
      target_area_confidence: 0.95,
      spf_or_otc_flag: 'cosmetic',
      spf_or_otc_flag_confidence: 0.88,
      skin_concern: ['hydration', 'sensitivity'],
      skin_concern_confidence: 0.7,
      claim_risk_level: 'low',
      claim_risk_level_confidence: 0.9,
    });
    expect(result.ok).toBe(true);
  });

  test('validateExtractionPayload rejects out-of-range confidences', () => {
    const r = validateExtractionPayload({
      product_key: 'ext_x',
      product_form_confidence: 1.5,
      target_area_confidence: -0.1,
    });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(expect.arrayContaining([
      'invalid_confidence:product_form',
      'invalid_confidence:target_area',
    ]));
  });

  test('validateExtractionPayload rejects unknown enum values', () => {
    const r = validateExtractionPayload({
      product_key: 'ext_x',
      spf_or_otc_flag: 'sometimes',
      claim_risk_level: 'extreme',
      target_area: 'snout',
    });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(expect.arrayContaining([
      'invalid_spf_or_otc_flag:sometimes',
      'invalid_claim_risk_level:extreme',
      'invalid_target_area:snout',
    ]));
  });

  test('validateExtractionPayload accepts every documented target_area value', () => {
    for (const area of ['face', 'lips', 'body', 'hair', 'eyes', 'brows', 'cheeks', 'hands', 'nails', 'scalp', 'oral', 'fragrance', 'multi_area', 'unknown']) {
      const r = validateExtractionPayload({ product_key: 'ext_x', target_area: area });
      expect(r.ok).toBe(true);
    }
  });

  test('validateExtractionPayload allows null target_area', () => {
    const r = validateExtractionPayload({ product_key: 'ext_x', target_area: null });
    expect(r.ok).toBe(true);
  });

  test('validateExtractionPayload requires skin_concern to be an array if provided', () => {
    const r = validateExtractionPayload({
      product_key: 'ext_x',
      skin_concern: 'hydration',
    });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('skin_concern_not_array');
  });

  test('validateExtractionPayload requires product_key', () => {
    const r = validateExtractionPayload({});
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('missing_product_key');
  });

  test('hasGateableAttributes requires non-null product_form + confidence', () => {
    expect(hasGateableAttributes(null)).toBe(false);
    expect(hasGateableAttributes({})).toBe(false);
    expect(hasGateableAttributes({ product_form: 'lipstick' })).toBe(false);
    expect(hasGateableAttributes({ product_form: 'lipstick', product_form_confidence: 0.8 })).toBe(true);
    expect(hasGateableAttributes({
      product_form: 'lipstick',
      product_form_confidence: 0.8,
      audit_status: 'rejected',
    })).toBe(false);
  });

  test('BEAUTY_ATTRIBUTE_FIELDS exports the expected 8 fields', () => {
    expect(BEAUTY_ATTRIBUTE_FIELDS).toEqual([
      'product_form',
      'category_leaf',
      'target_area',
      'shade_or_color_family',
      'scent_family',
      'spf_or_otc_flag',
      'skin_concern',
      'claim_risk_level',
    ]);
  });

  test('lookupBeautyAttributes normalizes the key and returns mapped row', async () => {
    const queryFn = jest.fn(async () => ({
      rows: [{
        product_key: 'ext_abc',
        product_form: 'lipstick',
        product_form_source: 'deepseek_v1',
        product_form_confidence: '0.92',
        category_leaf: null,
        category_leaf_source: null,
        category_leaf_confidence: null,
        target_area: 'lips',
        target_area_source: null,
        target_area_confidence: null,
        shade_or_color_family: null,
        shade_or_color_family_source: null,
        shade_or_color_family_confidence: null,
        scent_family: null,
        scent_family_source: null,
        scent_family_confidence: null,
        spf_or_otc_flag: null,
        spf_or_otc_flag_source: null,
        spf_or_otc_flag_confidence: null,
        skin_concern: null,
        skin_concern_source: null,
        skin_concern_confidence: null,
        claim_risk_level: null,
        claim_risk_level_source: null,
        claim_risk_level_confidence: null,
        extractor_version: 'deepseek_v1',
        raw_extraction: null,
        audit_status: 'pending',
        audit_notes: null,
        extracted_at: null,
        created_at: '2026-05-26T00:00:00.000Z',
        updated_at: '2026-05-26T00:00:00.000Z',
      }],
    }));
    const r = await lookupBeautyAttributes('product:ext_abc', { queryFn });
    expect(queryFn).toHaveBeenCalledWith(expect.any(String), ['ext_abc']);
    expect(r).toEqual(expect.objectContaining({
      product_key: 'ext_abc',
      product_form: 'lipstick',
      product_form_confidence: 0.92,
      target_area: 'lips',
      audit_status: 'pending',
    }));
  });

  test('lookupBeautyAttributes returns null when no row', async () => {
    const queryFn = jest.fn(async () => ({ rows: [] }));
    expect(await lookupBeautyAttributes('ext_missing', { queryFn })).toBeNull();
  });

  test('lookupBeautyAttributes returns null on empty/missing key', async () => {
    const queryFn = jest.fn();
    expect(await lookupBeautyAttributes('', { queryFn })).toBeNull();
    expect(await lookupBeautyAttributes(null, { queryFn })).toBeNull();
    expect(queryFn).not.toHaveBeenCalled();
  });

  test('lookupBeautyAttributesBatch dedupes and normalizes keys, returns Map', async () => {
    const queryFn = jest.fn(async () => ({
      rows: [
        { product_key: 'ext_a', product_form: 'lipstick', product_form_confidence: 0.9, audit_status: 'pending', created_at: 'x', updated_at: 'x' },
        { product_key: 'ext_b', product_form: 'serum', product_form_confidence: 0.85, audit_status: 'pending', created_at: 'x', updated_at: 'x' },
      ],
    }));
    const r = await lookupBeautyAttributesBatch([
      'product:ext_a',
      'ext_a', // dupe after normalization
      'ext_b',
      '',
      null,
    ], { queryFn });
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn.mock.calls[0][1][0].sort()).toEqual(['ext_a', 'ext_b']);
    expect(r.size).toBe(2);
    expect(r.get('ext_a').product_form).toBe('lipstick');
  });

  test('upsertBeautyAttributes builds an INSERT...ON CONFLICT and passes typed array for skin_concern', async () => {
    const queryFn = jest.fn(async () => ({ rows: [] }));
    await upsertBeautyAttributes({
      product_key: 'product:ext_abc',
      product_form: 'serum',
      product_form_source: 'deepseek_v1',
      product_form_confidence: 0.88,
      skin_concern: ['hydration', 'sensitivity'],
      skin_concern_confidence: 0.7,
      claim_risk_level: 'low',
      audit_status: 'pending',
      extractor_version: 'deepseek_v1',
      raw_extraction: { foo: 'bar' },
    }, { queryFn });
    expect(queryFn).toHaveBeenCalledTimes(1);
    const [sql, params] = queryFn.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO product_beauty_attributes/);
    expect(sql).toMatch(/ON CONFLICT \(product_key\) DO UPDATE/);
    expect(sql).toMatch(/\$\d+::text\[\]/); // skin_concern typed cast
    expect(params[0]).toBe('ext_abc'); // normalized key
    expect(params).toContainEqual(['hydration', 'sensitivity']);
    expect(params).toContain('serum');
    expect(params).toContain(0.88);
  });

  test('upsertBeautyAttributes rejects invalid payloads loudly', async () => {
    const queryFn = jest.fn();
    await expect(upsertBeautyAttributes({
      product_form_confidence: 2,
    }, { queryFn })).rejects.toMatchObject({
      code: 'INVALID_BEAUTY_ATTRIBUTES',
      errors: expect.arrayContaining(['missing_product_key']),
    });
    expect(queryFn).not.toHaveBeenCalled();
  });
});
