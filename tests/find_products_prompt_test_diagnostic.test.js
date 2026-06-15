'use strict';

// WS3a operator prompt-test (docs/find_products_multi_phase2_scope.md): unit cover
// the two pure helpers behind GET /api/admin/find-products-prompt-test. The endpoint
// + mainline `inspectProductId` hook need a live DB and are validated post-deploy.

const app = require('../src/server.js');
const { mainlineProductMatchesId, diagnosePromptInspect } = app._debug;

describe('mainlineProductMatchesId', () => {
  const product = {
    pivota_signature_id: 'sig_42edfffb0998c8e528926e26e82a7945',
    content_key: 'ck_a80578c9b07c16e0a4a3d4f0dfc1b5eb',
    source_product_id: 'ext_c77c0794a910bcf9efa4f542',
    product_key: 'pk_123',
    title: 'Tofu Collagen Dual-Firming Jelly Cream',
  };

  test('matches by any identifier the product carries', () => {
    expect(mainlineProductMatchesId(product, 'sig_42edfffb0998c8e528926e26e82a7945')).toBe(true);
    expect(mainlineProductMatchesId(product, 'ck_a80578c9b07c16e0a4a3d4f0dfc1b5eb')).toBe(true);
    expect(mainlineProductMatchesId(product, 'ext_c77c0794a910bcf9efa4f542')).toBe(true);
    expect(mainlineProductMatchesId(product, 'pk_123')).toBe(true);
  });

  test('trims the wanted id and is exact (no substring match)', () => {
    expect(mainlineProductMatchesId(product, '  sig_42edfffb0998c8e528926e26e82a7945  ')).toBe(true);
    expect(mainlineProductMatchesId(product, 'sig_42edfffb')).toBe(false);
  });

  test('safe on null/odd input', () => {
    expect(mainlineProductMatchesId(null, 'x')).toBe(false);
    expect(mainlineProductMatchesId(product, null)).toBe(false);
    expect(mainlineProductMatchesId(product, '')).toBe(false);
    expect(mainlineProductMatchesId('not-an-object', 'x')).toBe(false);
  });
});

describe('diagnosePromptInspect', () => {
  test('visible in page', () => {
    expect(diagnosePromptInspect({ display_rank: 5, in_visible_page: true, in_recall_pool: true })).toBe('ranked_visible');
  });
  test('ranked but below the visible page', () => {
    expect(diagnosePromptInspect({ display_rank: 38, in_visible_page: false, in_recall_pool: true })).toBe('ranked_below_page');
  });
  test('recalled but the ranker rejected it', () => {
    expect(diagnosePromptInspect({ display_rank: null, relevant: false, in_recall_pool: true })).toBe('recalled_but_rejected');
  });
  test('never even recalled (authoring/recall gap)', () => {
    expect(diagnosePromptInspect({ display_rank: null, in_recall_pool: false })).toBe('not_recalled');
  });
  test('recalled, relevant-unknown, not in served list', () => {
    expect(diagnosePromptInspect({ display_rank: null, in_recall_pool: true, relevant: null })).toBe('recalled_not_served');
  });
  test('null/garbage → unknown', () => {
    expect(diagnosePromptInspect(null)).toBe('unknown');
    expect(diagnosePromptInspect('x')).toBe('unknown');
  });
});
