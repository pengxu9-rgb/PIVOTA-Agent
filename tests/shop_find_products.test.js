'use strict';

const { detectExplicitProductSearch } = require('../src/auroraBff/findProductsIntent');
const ShopFindProductsSkill = require('../src/auroraBff/skills/shop_find_products');
const { toRecommendationRow } = require('../src/auroraBff/skills/shop_find_products');
const { SkillRouter } = require('../src/auroraBff/orchestrator/skill_router');
const { isCatalogSearchOwnedChatRequest } = require('../src/auroraBff/routes/chat');

// ---------------------------------------------------------------------------
// detectExplicitProductSearch — high-precision routing gate
// ---------------------------------------------------------------------------
describe('detectExplicitProductSearch', () => {
  test.each([
    ['show me acropass products', 'acropass'],
    ['find me goongbe products', 'goongbe'],
    ['products from cerave', 'cerave'],
    ['products by the ordinary', 'the ordinary'],
    ['shop acropass', 'acropass'],
    ['browse cerave', 'cerave'],
    ['buy acropass patches', 'acropass patches'],
    ['where can i buy biodance', 'biodance'],
    ['shop the ordinary', 'the ordinary'], // "the" is a real brand prefix, not guarded
    ['ordinary', 'ordinary'],
    ['knight unicorn', 'knight unicorn'],
    ['only blush', 'only blush'],
    ['show me niacinamide under $10', 'niacinamide under $10'],
  ])('routes %j -> query %j', (msg, query) => {
    const r = detectExplicitProductSearch(msg);
    expect(r).not.toBeNull();
    expect(r.query.toLowerCase()).toBe(query);
  });

  test.each([
    'recommend a moisturizer for dry skin',
    'is cerave good for me',
    'what serum is best for oily skin',
    'find me a good vitamin c serum for my acne', // reco-signal: "for my"
    'compare acropass vs biodance',
    'whats a dupe for that',
    'how is my skin type',
    'buy me something good for sensitive skin', // reco-signal guard
    'buy a moisturizer for winter', // generic category → article guard
    'shop for a sunscreen', // generic category → article guard
    'buy something', // generic filler → article guard
    'hello',
    'how are you',
    'dry skin',
    'what is niacinamide?',
  ])('does NOT route (falls through to LLM): %j', (msg) => {
    expect(detectExplicitProductSearch(msg)).toBeNull();
  });

  test('empty / whitespace returns null', () => {
    expect(detectExplicitProductSearch('')).toBeNull();
    expect(detectExplicitProductSearch('   ')).toBeNull();
  });

  test('distinguishes explicit shopping syntax from ambiguous bare phrases', () => {
    expect(detectExplicitProductSearch('show me niacinamide under $10')?.match_type).toBe('explicit');
    expect(detectExplicitProductSearch('ordinary')?.match_type).toBe('bare');
  });
});

describe('chat entry ownership', () => {
  test.each(['ordinary', 'knight unicorn', 'only blush', 'show me niacinamide under $10'])(
    'current typed catalog turn %j owns the route before all specialist gates',
    (message) => expect(isCatalogSearchOwnedChatRequest({ message })).toBe(true),
  );

  test('does not infer current catalog ownership from prior messages or generated action copy', () => {
    expect(isCatalogSearchOwnedChatRequest({ messages: [{ role: 'user', content: 'ordinary' }] })).toBe(false);
    expect(isCatalogSearchOwnedChatRequest({ action: { data: { reply_text: 'ordinary' } } })).toBe(false);
  });

  test('leaves recommendation and evaluation turns on their specialist owners', () => {
    expect(isCatalogSearchOwnedChatRequest({ message: 'recommend a niacinamide serum for my oily skin' })).toBe(false);
    expect(isCatalogSearchOwnedChatRequest({ message: 'is this serum good for me?' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toRecommendationRow — maps find_products_multi products to the card row shape
// ---------------------------------------------------------------------------
describe('toRecommendationRow', () => {
  test('maps core fields with alias fallbacks', () => {
    const row = toRecommendationRow({
      product_id: 'p1',
      merchant_id: 'external_seed',
      brand: 'ACROPASS',
      title: 'ACROPASS Retinol Micronone Patch',
      images: [{ url: 'https://cdn/img.jpg' }],
      pdp_url: 'https://agent.pivota.cc/products/sig_1',
      category: 'skincare',
      price: 12.5,
      currency: 'USD',
      availability: 'in_stock',
    });
    expect(row).toMatchObject({
      product_id: 'p1',
      merchant_id: 'external_seed',
      brand: 'ACROPASS',
      name: 'ACROPASS Retinol Micronone Patch',
      display_name: 'ACROPASS Retinol Micronone Patch',
      image_url: 'https://cdn/img.jpg',
      pdp_url: 'https://agent.pivota.cc/products/sig_1',
      source: 'catalog_search',
      price: 12.5,
      currency: 'USD',
      availability: 'in_stock',
    });
  });

  test('drops a product with neither name nor id', () => {
    expect(toRecommendationRow({ brand: 'x' })).toBeNull();
    expect(toRecommendationRow(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ShopFindProductsSkill.execute — grounded, honest no-result
// ---------------------------------------------------------------------------
function makeSkill(clientResult) {
  return new ShopFindProductsSkill({
    client: { findProductsMulti: async () => clientResult },
  });
}

describe('ShopFindProductsSkill', () => {
  test('returns a recommendations card built from catalog products', async () => {
    const skill = makeSkill({
      ok: true,
      products: [
        { product_id: 'p1', brand: 'ACROPASS', title: 'ACROPASS Retinol Micronone Patch', merchant_id: 'external_seed' },
        { product_id: 'p2', brand: 'ACROPASS', title: 'ACROPASS Spot Care Microcone', merchant_id: 'external_seed' },
      ],
      metadata: {},
    });
    const res = await skill.execute({ params: { find_products_query: 'acropass' } });
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0].card_type).toBe('recommendations');
    expect(res.cards[0].metadata.recommendations).toHaveLength(2);
    expect(res.cards[0].metadata.source_mode).toBe('catalog_search');
    expect(res.cards[0].metadata.recommendations[0].brand).toBe('ACROPASS');
  });

  test('EMPTY result returns an honest no-result text card — NO substitution', async () => {
    const skill = makeSkill({ ok: true, products: [], metadata: {}, reason: 'no_candidates' });
    const res = await skill.execute({ params: { find_products_query: 'acropass' } });
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0].card_type).toBe('text_response');
    // Must name the query and NOT invent products.
    expect(res.cards[0].sections[0].text_en).toContain('acropass');
    expect(res.cards[0].metadata).toBeUndefined();
  });

  test('backend failure also yields honest no-result (never throws)', async () => {
    const skill = makeSkill({ ok: false, products: [], metadata: {}, reason: 'http_500' });
    const res = await skill.execute({ params: { find_products_query: 'acropass' } });
    expect(res.cards[0].card_type).toBe('text_response');
    expect(res._meta.result_count).toBe(0);
    expect(res._meta.backend_reason).toBe('http_500');
  });

  test('no query -> asks what to look for', async () => {
    const skill = makeSkill({ ok: true, products: [] });
    const res = await skill.execute({ params: {} });
    expect(res.cards[0].card_type).toBe('text_response');
    expect(res.cards[0].sections[0].text_en.toLowerCase()).toContain('looking for');
  });

  test('binds a terse category refinement to the prior catalog brand query', async () => {
    let receivedQuery = null;
    const skill = new ShopFindProductsSkill({
      client: {
        findProductsMulti: async ({ query }) => {
          receivedQuery = query;
          return { ok: true, products: [] };
        },
      },
    });
    await skill.execute({
      params: {
        find_products_query: 'only blush',
        messages: [{ role: 'user', content: 'knight unicorn' }],
      },
    });
    expect(receivedQuery).toMatch(/knight unicorn/i);
    expect(receivedQuery).toMatch(/blush/i);
  });

  test('forwards a parsed hard price ceiling to canonical catalog recall', async () => {
    let received = null;
    const skill = new ShopFindProductsSkill({
      client: {
        findProductsMulti: async (input) => {
          received = input;
          return { ok: true, products: [] };
        },
      },
    });
    await skill.execute({ params: { find_products_query: 'Niacinamide 10% + Zinc 1% under $8' } });
    expect(received.maxPrice).toBe(8);
  });

  test('never projects an over-budget catalog row into the chat card', async () => {
    const skill = makeSkill({
      ok: true,
      products: [
        { product_id: 'sig_under', title: 'Niacinamide Serum', price: '6.00', currency: 'USD' },
        { product_id: 'sig_over', title: 'Niacinamide Emulsion', price: '10.78', currency: 'USD' },
      ],
    });
    const res = await skill.execute({ params: { find_products_query: 'niacinamide under $10' } });
    expect(res.cards[0].metadata.recommendations.map((row) => row.product_id)).toEqual(['sig_under']);
    expect(res._meta.budget_filtered_out_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Router wiring — explicit search resolves to shop.find_products WITHOUT the LLM
// ---------------------------------------------------------------------------
describe('SkillRouter routing', () => {
  test('explicit product search routes to shop.find_products before the LLM classifier', async () => {
    let llmCalled = false;
    const stubGateway = { call: async () => { llmCalled = true; return { parsed: { intent: 'general_chat', confidence: 0.9 } }; } };
    const router = new SkillRouter(stubGateway);
    const request = { params: { user_message: 'show me acropass products' } };
    const resolved = await router._resolveSkillRequest(request, {});
    expect(resolved.skillId).toBe('shop.find_products');
    expect(request.params.find_products_query).toBe('acropass');
    expect(llmCalled).toBe(false); // deterministic rule short-circuits the LLM
  });

  test('a recommendation query does NOT hit the deterministic rule (falls to classifier)', async () => {
    let llmCalled = false;
    const stubGateway = { call: async () => { llmCalled = true; return { parsed: { intent: 'recommend_products', confidence: 0.9 } }; } };
    const router = new SkillRouter(stubGateway);
    const request = { params: { user_message: 'recommend a moisturizer for dry skin' } };
    const resolved = await router._resolveSkillRequest(request, {});
    expect(llmCalled).toBe(true);
    expect(resolved.skillId).toBe('reco.step_based');
  });

  test.each(['ordinary', 'knight unicorn', 'only blush'])(
    'a short catalog phrase %j routes before the LLM classifier',
    async (message) => {
      let llmCalled = false;
      const router = new SkillRouter({
        call: async () => {
          llmCalled = true;
          return { parsed: { intent: 'general_chat', confidence: 0.9 } };
        },
      });
      const request = { params: { user_message: message } };
      const resolved = await router._resolveSkillRequest(request, {});
      expect(resolved.skillId).toBe('shop.find_products');
      expect(request.params.find_products_query).toBe(message);
      expect(llmCalled).toBe(false);
    },
  );
});

describe('shopGatewayClient canonical catalog contract', () => {
  test('requests canonical SIG entities from the unified backend recall lane', async () => {
    const previousBase = process.env.PIVOTA_BACKEND_BASE_URL;
    process.env.PIVOTA_BACKEND_BASE_URL = 'https://backend.example';
    jest.resetModules();
    const client = require('../src/auroraBff/clients/shopGatewayClient');
    let sentBody = null;
    const http = {
      post: async (_url, body) => {
        sentBody = body;
        return { status: 200, data: { products: [] } };
      },
    };

    try {
      await client.findProductsMulti({ query: 'ordinary', maxPrice: 10, deps: { axios: http } });
      expect(sentBody.payload.search.catalog_entity_mode).toBe('canonical_sig');
      expect(sentBody.payload.search.max_price).toBe(10);
      expect(sentBody.metadata.invoked_by).toBe('chat.shop_find_products');
    } finally {
      if (previousBase === undefined) delete process.env.PIVOTA_BACKEND_BASE_URL;
      else process.env.PIVOTA_BACKEND_BASE_URL = previousBase;
      jest.resetModules();
    }
  });
});

// The template guards, once these results reach the v1 ingress and become user-visible searches.
describe('detectExplicitProductSearch template guards', () => {
  const { detectExplicitProductSearch } = require('../src/auroraBff/findProductsIntent');

  test('the shop-verb test and its strip agree on POSITION', () => {
    // The test matched the verb anywhere while the strip is ^-anchored, so a sentence that merely
    // mentioned shopping entered the branch, stripped nothing, and returned itself as the query.
    expect(detectExplicitProductSearch('i shop at sephora')?.match_type).not.toBe('explicit');
    // `purchase` heads a noun phrase far more often than an imperative.
    expect(detectExplicitProductSearch('purchase history')?.query).not.toBe('history');
    // ...and the leading-imperative forms still work.
    expect(detectExplicitProductSearch('shop cerave')).toEqual({ query: 'cerave', match_type: 'explicit' });
    expect(detectExplicitProductSearch('buy cerave')).toEqual({ query: 'cerave', match_type: 'explicit' });
    // "the" is deliberately not filler — it is part of the brand.
    expect(detectExplicitProductSearch('browse the ordinary')).toEqual({
      query: 'the ordinary',
      match_type: 'explicit',
    });
  });

  test('a generic head REFUSES on every template, not just the shop-verb one', () => {
    // Each of these is an open-ended category ask for the profile-aware reco lane. Returning null
    // rather than falling through matters: the bare check would otherwise re-admit the whole
    // sentence as a catalog query — the same wrong search wearing a different label.
    expect(detectExplicitProductSearch('find me a moisturizer')).toBeNull();
    expect(detectExplicitProductSearch('show me a serum')).toBeNull();
    expect(detectExplicitProductSearch('buy a moisturizer')).toBeNull();
    expect(detectExplicitProductSearch('where can i buy a refund')).toBeNull();
  });

  test('the phrasings this lane exists for are unaffected', () => {
    expect(detectExplicitProductSearch('show me Murad products')).toEqual({
      query: 'Murad',
      match_type: 'explicit',
    });
    expect(detectExplicitProductSearch('where can i buy cerave')).toEqual({
      query: 'cerave',
      match_type: 'explicit',
    });
    expect(detectExplicitProductSearch('show me niacinamide under $10')).toEqual({
      query: 'niacinamide under $10',
      match_type: 'explicit',
    });
    expect(detectExplicitProductSearch('ordinary')?.match_type).toBe('bare');
  });
});
