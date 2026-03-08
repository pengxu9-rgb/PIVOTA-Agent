const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

test('legacy purchasable fallback prompt encodes candidate-only selector rules', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const prompt = __internal.buildProductLookupLlmFallbackPrompt({
      query: 'mineral sunscreen',
      limit: 3,
      productCandidates: [
        {
          name: 'Mineral UV Fluid',
          brand: 'SunLabs',
          category: 'sunscreen',
          pdp_url: 'https://example.com/pdp/mineral-uv-fluid',
          signals: ['mineral filters', 'fragrance-free'],
        },
      ],
    });

    assert.match(prompt, /\[PROMPT_VERSION=inline_selector_v2\]/i);
    assert.match(prompt, /Role: strict fallback product selector/i);
    assert.match(prompt, /Use ONLY products from context\.product_candidates/i);
    assert.match(prompt, /If no valid candidate fits, return \{"products": \[\]\}/i);
    assert.match(prompt, /Do NOT return search URLs/i);
    assert.match(prompt, /Copy product identity from the chosen candidate/i);
    assert.match(prompt, /context=\{\"product_candidates\":/i);
  } finally {
    delete require.cache[moduleId];
  }
});
