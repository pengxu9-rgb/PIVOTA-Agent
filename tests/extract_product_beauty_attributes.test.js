const crypto = require('node:crypto');

const {
  buildPrompt,
  extractOne,
  loadCandidateUniverse,
  parseLlmResponse,
} = require('../scripts/extract-product-beauty-attributes');
const { validateExtractionPayload } = require('../src/auroraBff/productBeautyAttributes');

const fixtureSnapshot = {
  product_id: 'ext_fixture',
  brand: 'Example Labs',
  name: 'Barrier Bounce Hydrating Serum',
  category_taxonomy: ['Beauty', 'Skin Care', 'Serums'],
  url: 'https://example.com/p/barrier-bounce',
  price: { amount: 18, currency: 'USD' },
};

function validLlmJson(overrides = {}) {
  return JSON.stringify({
    product_form: 'Serum',
    product_form_source: 'name',
    product_form_confidence: '92%',
    category_leaf: 'Hydrating Serum',
    category_leaf_source: 'category_taxonomy',
    category_leaf_confidence: 88,
    target_area: 'Face',
    target_area_source: 'category_taxonomy',
    target_area_confidence: 0.91,
    shade_or_color_family: null,
    shade_or_color_family_source: 'name',
    shade_or_color_family_confidence: 1,
    scent_family: 'not applicable',
    scent_family_source: 'name',
    scent_family_confidence: 0.95,
    spf_or_otc_flag: 'cosmetic',
    spf_or_otc_flag_source: 'name',
    spf_or_otc_flag_confidence: 0.86,
    skin_concern: ['Hydration', 'Barrier Repair', 'hydration'],
    skin_concern_source: 'name',
    skin_concern_confidence: 0.8,
    claim_risk_level: 'Low',
    claim_risk_level_source: 'name',
    claim_risk_level_confidence: 0.9,
    ...overrides,
  });
}

describe('extract-product-beauty-attributes', () => {
  test('buildPrompt produces a stable prompt for a fixture snapshot', () => {
    const prompt = buildPrompt(fixtureSnapshot);

    expect(prompt).toContain('You are classifying one beauty product for a relation-graph preflight gate.');
    expect(prompt).toContain('Classify product_key "ext_fixture" using only the product snapshot below.');
    expect(prompt).toContain('"spf_or_otc_flag": cosmetic|spf|otc_drug|spf_otc|unknown');
    expect(prompt).toContain('"claim_risk_level": low|medium|high');
    expect(prompt).toContain('Product snapshot JSON:\n{\n  "brand": "Example Labs",');
    expect(prompt).toContain('  "product_id": "ext_fixture",\n  "url": "https://example.com/p/barrier-bounce"\n}');
    expect(crypto.createHash('sha256').update(prompt).digest('hex')).toBe(
      '5c9e8b9fc256f650cd6eb1b841c587b7922e8757fc2d9248121a4aa5c9de9788',
    );
  });

  test('parseLlmResponse rejects malformed JSON', () => {
    const result = parseLlmResponse('not json', 'ext_fixture');

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/^malformed_json:/);
  });

  test('parseLlmResponse accepts well-formed responses and normalizes confidence values', () => {
    const result = parseLlmResponse(validLlmJson(), 'product:ext_fixture', {
      extractorVersion: 'test_v1',
      extractedAt: '2026-05-26T00:00:00.000Z',
    });

    expect(result.ok).toBe(true);
    expect(result.value).toEqual(expect.objectContaining({
      product_key: 'ext_fixture',
      product_form: 'serum',
      product_form_confidence: 0.92,
      category_leaf: 'hydrating_serum',
      category_leaf_confidence: 0.88,
      target_area: 'face',
      shade_or_color_family: null,
      scent_family: null,
      spf_or_otc_flag: 'cosmetic',
      skin_concern: ['hydration', 'barrier_repair'],
      claim_risk_level: 'low',
      extractor_version: 'test_v1',
      audit_status: 'pending',
    }));
    expect(validateExtractionPayload(result.value).ok).toBe(true);
  });

  test('parseLlmResponse rejects missing per-attribute confidence', () => {
    const result = parseLlmResponse(validLlmJson({ scent_family_confidence: undefined }), 'ext_fixture');

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('missing_confidence:scent_family');
  });

  test('loadCandidateUniverse dedupes product keys and keeps the richest snapshot', async () => {
    const queryFn = jest.fn(async () => ({
      rows: [
        { product_key: 'ext_a', snapshot: { product_id: 'ext_a', name: 'Sparse' } },
        {
          product_key: 'ext_a',
          snapshot: {
            product_id: 'ext_a',
            name: 'Rich Serum',
            brand: 'Rich Brand',
            category_taxonomy: ['Beauty', 'Skin Care', 'Serum'],
            url: 'https://example.com/rich',
          },
        },
        { product_key: 'product:ext_b', snapshot: { product_id: 'ext_b', name: 'Lipstick' } },
      ],
    }));

    const result = await loadCandidateUniverse({ queryFn });

    expect(result).toEqual([
      {
        product_key: 'ext_a',
        snapshot: expect.objectContaining({ name: 'Rich Serum', brand: 'Rich Brand' }),
      },
      {
        product_key: 'ext_b',
        snapshot: expect.objectContaining({ name: 'Lipstick' }),
      },
    ]);
  });

  test('extractOne calls injected llmFn and validates against validateExtractionPayload', async () => {
    const llmFn = jest.fn(async () => ({
      text: validLlmJson(),
      provider: 'test_provider',
      model: 'test_model',
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }));

    const result = await extractOne(
      { product_key: 'ext_fixture', snapshot: fixtureSnapshot },
      { llmFn, extractorVersion: 'test_v1' },
    );

    expect(llmFn).toHaveBeenCalledTimes(1);
    expect(llmFn.mock.calls[0][0]).toContain('Barrier Bounce Hydrating Serum');
    expect(llmFn.mock.calls[0][1]).toEqual(expect.objectContaining({
      productKey: 'ext_fixture',
      snapshot: fixtureSnapshot,
    }));
    expect(validateExtractionPayload(result).ok).toBe(true);
    expect(result).toEqual(expect.objectContaining({
      product_key: 'ext_fixture',
      product_form: 'serum',
      category_leaf: 'hydrating_serum',
      raw_extraction: expect.objectContaining({
        llm_provider: 'test_provider',
        llm_model: 'test_model',
      }),
    }));
  });
});
