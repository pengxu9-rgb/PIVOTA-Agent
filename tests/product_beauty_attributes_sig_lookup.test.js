const {
  lookupBeautyAttributesBatch,
  normalizeKey,
  refreshBeautyAttributeSigIds,
} = require('../src/auroraBff/productBeautyAttributes');

// Minimal PBA row returned by a query
function pbaRow(overrides = {}) {
  return {
    product_key: 'ext_abc123',
    sig_id: 'sig_def456',
    product_form: 'serum',
    product_form_confidence: 0.95,
    product_form_source: 'test',
    category_leaf: 'vitamin_c_serum',
    category_leaf_confidence: 0.95,
    category_leaf_source: 'test',
    target_area: 'face',
    target_area_confidence: 0.95,
    target_area_source: 'test',
    shade_or_color_family: null, shade_or_color_family_confidence: null, shade_or_color_family_source: null,
    scent_family: null, scent_family_confidence: null, scent_family_source: null,
    spf_or_otc_flag: 'cosmetic', spf_or_otc_flag_confidence: 0.9, spf_or_otc_flag_source: 'test',
    skin_concern: ['brightening'], skin_concern_confidence: 0.85, skin_concern_source: 'test',
    claim_risk_level: 'low', claim_risk_level_confidence: 0.8, claim_risk_level_source: 'test',
    extractor_version: 'v1', raw_extraction: null, audit_status: 'pending',
    audit_notes: null, extracted_at: null, created_at: new Date(), updated_at: new Date(),
    ...overrides,
  };
}

function makeQueryFn(pbaRows = []) {
  return jest.fn(async (sql) => {
    const isExtQuery = /product_key = ANY/.test(sql);
    const isSigQuery = /sig_id = ANY/.test(sql);
    if (isExtQuery) return { rows: pbaRows.filter(r => r.product_key) };
    if (isSigQuery) return { rows: pbaRows.filter(r => r.sig_id) };
    return { rows: [] };
  });
}

describe('lookupBeautyAttributesBatch — sig_* key support', () => {
  test('ext_* keys use product_key lookup (existing path)', async () => {
    const qFn = makeQueryFn([pbaRow()]);
    const result = await lookupBeautyAttributesBatch(['product:ext_abc123'], { queryFn: qFn });
    expect(result.get('ext_abc123')).toBeDefined();
    expect(result.get('ext_abc123').product_form).toBe('serum');
    // sig_id query not called for ext_* keys
    const calls = qFn.mock.calls.map(c => c[0]);
    expect(calls.some(s => /product_key = ANY/.test(s))).toBe(true);
    expect(calls.some(s => /sig_id = ANY/.test(s))).toBe(false);
  });

  test('sig_* keys use sig_id lookup (new path)', async () => {
    const row = pbaRow({ sig_id: 'sig_def456' });
    const qFn = jest.fn(async (sql) => {
      if (/sig_id = ANY/.test(sql)) return { rows: [row] };
      return { rows: [] };
    });
    const result = await lookupBeautyAttributesBatch(['sig_def456'], { queryFn: qFn });
    // Result indexed by sig_id
    expect(result.get('sig_def456')).toBeDefined();
    expect(result.get('sig_def456').product_form).toBe('serum');
    // Also indexed by product_key for backwards-compat
    expect(result.get('ext_abc123')).toBeDefined();
    const calls = qFn.mock.calls.map(c => c[0]);
    expect(calls.some(s => /sig_id = ANY/.test(s))).toBe(true);
  });

  test('product:sig_* prefix is stripped before sig lookup', async () => {
    const row = pbaRow({ sig_id: 'sig_def456' });
    const qFn = jest.fn(async (sql, params) => {
      if (/sig_id = ANY/.test(sql)) {
        // confirm prefix was stripped
        expect(params[0]).toContain('sig_def456');
        expect(params[0]).not.toContain('product:sig_def456');
        return { rows: [row] };
      }
      return { rows: [] };
    });
    await lookupBeautyAttributesBatch(['product:sig_def456'], { queryFn: qFn });
  });

  test('mixed ext_* and sig_* keys in one call both resolve', async () => {
    const extRow = pbaRow({ product_key: 'ext_111', sig_id: null });
    const sigRow = pbaRow({ product_key: 'ext_222', sig_id: 'sig_333' });
    const qFn = jest.fn(async (sql) => {
      if (/product_key = ANY/.test(sql)) return { rows: [extRow] };
      if (/sig_id = ANY/.test(sql)) return { rows: [sigRow] };
      return { rows: [] };
    });
    const result = await lookupBeautyAttributesBatch(['ext_111', 'sig_333'], { queryFn: qFn });
    expect(result.get('ext_111')).toBeDefined();
    expect(result.get('sig_333')).toBeDefined();
  });

  test('empty input returns empty Map', async () => {
    const qFn = jest.fn(async () => ({ rows: [] }));
    const result = await lookupBeautyAttributesBatch([], { queryFn: qFn });
    expect(result.size).toBe(0);
    expect(qFn).not.toHaveBeenCalled();
  });

  test('normalizeKey strips product: prefix for both ext_* and sig_*', () => {
    expect(normalizeKey('product:ext_abc123')).toBe('ext_abc123');
    expect(normalizeKey('product:sig_abc123')).toBe('sig_abc123');
    expect(normalizeKey('ext_abc123')).toBe('ext_abc123');
    expect(normalizeKey('sig_abc123')).toBe('sig_abc123');
  });
});

describe('refreshBeautyAttributeSigIds', () => {
  test('dry-run selects PBA rows whose catalog signature changed', async () => {
    const queryFn = jest.fn(async () => ({
      rows: [
        {
          product_key: 'ext_abc123',
          old_sig_id: null,
          new_sig_id: 'sig_def456',
        },
      ],
    }));

    const result = await refreshBeautyAttributeSigIds({
      externalProductIds: ['product:ext_abc123'],
      sigIds: ['sig_def456'],
      queryFn,
    });

    expect(result).toEqual({
      dry_run: true,
      matched_count: 1,
      updated_count: 0,
      rows: [
        {
          product_key: 'ext_abc123',
          old_sig_id: null,
          new_sig_id: 'sig_def456',
        },
      ],
    });
    const [sql, params] = queryFn.mock.calls[0];
    expect(sql).toMatch(/FROM product_beauty_attributes pba/);
    expect(sql).toMatch(/JOIN catalog_products cp/);
    expect(sql).toMatch(/pba\.sig_id IS DISTINCT FROM cp\.pivota_signature_id/);
    expect(sql).not.toMatch(/UPDATE product_beauty_attributes/);
    expect(params).toEqual([['ext_abc123'], ['sig_def456']]);
  });

  test('apply updates PBA sig_id from catalog_products', async () => {
    const queryFn = jest.fn(async () => ({
      rowCount: 1,
      rows: [
        {
          product_key: 'ext_abc123',
          old_sig_id: null,
          new_sig_id: 'sig_def456',
        },
      ],
    }));

    const result = await refreshBeautyAttributeSigIds({
      externalProductIds: ['ext_abc123'],
      apply: true,
      queryFn,
    });

    expect(result.updated_count).toBe(1);
    expect(result.dry_run).toBe(false);
    expect(queryFn.mock.calls[0][0]).toMatch(/UPDATE product_beauty_attributes pba/);
  });

  test('requires an explicit filter', async () => {
    await expect(refreshBeautyAttributeSigIds({ queryFn: jest.fn() })).rejects.toMatchObject({
      code: 'MISSING_PBA_SIG_REFRESH_FILTER',
    });
  });
});
