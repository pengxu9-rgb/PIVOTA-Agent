const request = require('supertest');
const nock = require('nock');
const { validateCopyOverrides, hasInvalidBraces, containsDigits } = require('../src/recommend/validators');
const { sanitizeProduct } = require('../src/recommend/sanitizer');
const { rerankCandidates } = require('../src/recommend/rerank');

// Disable Redis for tests to use in-memory store.
process.env.REDIS_DISABLED = 'true';
process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.RECOMMEND_LLM_ENABLED = '';

const app = require('../src/server');

describe('validators', () => {
  test('allows only {{NAME}} placeholder', () => {
    expect(hasInvalidBraces('Hello {{NAME}}')).toBe(false);
    expect(hasInvalidBraces('Hello {{NAME}} and {{BUY_URL}}')).toBe(true);
    expect(hasInvalidBraces('Hello {NAME}')).toBe(true);
  });

  test('rejects digits/currency', () => {
    expect(containsDigits('no digits here')).toBe(false);
    expect(containsDigits('has 123')).toBe(true);
    expect(containsDigits('costs $5')).toBe(true);
  });

  test('validateCopyOverrides basic success', () => {
    const copy = {
      intro_text: 'Hi there',
      items: [
        { product_id: 'p1', headline_tmpl: 'Try {{NAME}}', copy_tmpl: 'Nice pick', highlights: ['Soft'] },
      ],
      follow_up_question_id: 'Q_BUDGET',
    };
    const res = validateCopyOverrides(copy, ['p1'], 1);
    expect(res.valid).toBe(true);
  });

  test('validateCopyOverrides failure on braces/digits', () => {
    const copy = {
      intro_text: '123',
      items: [{ product_id: 'p1', headline_tmpl: 'See {NAME}', copy_tmpl: 'Nice', highlights: [] }],
    };
    const res = validateCopyOverrides(copy, ['p1'], 1);
    expect(res.valid).toBe(false);
  });

  test('validateCopyOverrides enforces expected product ids and duplicates', () => {
    const copy = {
      intro_text: 'Hi',
      items: [
        { product_id: 'p1', headline_tmpl: 'Try {{NAME}}', copy_tmpl: 'Nice', highlights: [] },
        { product_id: 'p1', headline_tmpl: 'Try {{NAME}}', copy_tmpl: 'Nice', highlights: [] }
      ],
    };
    const res = validateCopyOverrides(copy, ['p1'], 1);
    expect(res.valid).toBe(false);
  });
});

describe('sanitizer', () => {
  test('cleans html/url/claims', () => {
    const product = {
      title: 'Free SHIPPING!! <b>Best</b> clinically proven https://x.test',
      brand: { brand_name: 'Brand' },
      category: { path: ['A', 'B', 'C'] },
      attributes: { style_tags: ['cozy', 'clinically proven warmth'] },
    };
    const out = sanitizeProduct(product);
    expect(out.safe_display_name.toLowerCase()).not.toContain('free shipping');
    expect(out.safe_display_name).not.toContain('<b>');
    expect(out.safe_features.some((f) => f.includes('clinical'))).toBe(false);
  });

  test('uses category path leaf in display name', () => {
    const product = {
      title: 'Lip Color',
      brand: { brand_name: 'Brand' },
      category: { path: ['Beauty', 'Lipstick'] },
      attributes: { style_tags: [] },
    };

    const out = sanitizeProduct(product);

    expect(out.safe_display_name).toContain('Lipstick');
    expect(out.safe_name_parts.category_safe).toBe('Lipstick');
  });

  test('does not use category_id as display text when category path is absent', () => {
    const product = {
      title: 'Lip Color',
      brand: { brand_name: 'Brand' },
      category: { category_id: 'sku_abc123' },
      attributes: { style_tags: [] },
    };

    const out = sanitizeProduct(product);

    expect(out.safe_display_name).not.toContain('sku_abc123');
    expect(out.safe_name_parts.category_safe).not.toContain('sku_abc123');
  });
});

describe('rerank', () => {
  test('drops OOS and dedupes seen', () => {
    const candidates = [
      { product_id: 'p1', availability: { status: 'OUT_OF_STOCK' }, signals: {}, recall: {} },
      { product_id: 'p2', availability: { status: 'IN_STOCK' }, signals: { popularity_7d: 0.9 }, recall: {} },
      { product_id: 'p3', availability: { status: 'IN_STOCK' }, signals: { popularity_7d: 0.1 }, recall: {} },
    ];
    const ranked = rerankCandidates(candidates, { seenProductIds: ['p2'] });
    expect(ranked.find((r) => r.product_id === 'p1')).toBeUndefined();
    expect(ranked.some((r) => r.product_id === 'p2')).toBe(false);
  });
});

describe('/recommend integration', () => {
  afterEach(() => nock.cleanAll());

  test('returns cards with default copy when LLM skipped', async () => {
    const responseBody = require('./samples/find_products_multi_sample.json');
    nock('http://localhost:8080').post('/agent/shop/v1/invoke').reply(200, responseBody);

    const res = await request(app)
      .post('/recommend')
      .send({
        trace_id: 't1',
        creator_id: 'c1',
        anon_id: 'a1',
        locale: 'en-US',
        message: 'cozy hoodie gift',
        events: [],
      })
      .expect(200);

    expect(res.body.trace_id).toBe('t1');
    expect(res.body.cards && res.body.cards.length).toBeGreaterThan(0);
    expect(res.body.copy_overrides).toBeTruthy();
    expect(res.body.meta.llm_used).toBe(false);
  });

  test('short follow-up refines prior mission query (same session)', async () => {
    const responseBody = require('./samples/find_products_multi_sample.json');

    const anonId = 'a_refine_1';
    const creatorId = 'c1';

    const firstScope = nock('http://localhost:8080')
      .post('/agent/shop/v1/invoke', (body) => body?.payload?.search?.query === 'cozy hoodie gift')
      .reply(200, responseBody);

    await request(app)
      .post('/recommend')
      .send({
        trace_id: 't_refine_1',
        creator_id: creatorId,
        anon_id: anonId,
        locale: 'en-US',
        message: 'cozy hoodie gift',
        events: [],
      })
      .expect(200);

    expect(firstScope.isDone()).toBe(true);

    const secondScope = nock('http://localhost:8080')
      .post('/agent/shop/v1/invoke', (body) => {
        const q = body?.payload?.search?.query || '';
        return q.includes('cozy hoodie gift') && q.includes('refinement: under $80');
      })
      .reply(200, responseBody);

    await request(app)
      .post('/recommend')
      .send({
        trace_id: 't_refine_2',
        creator_id: creatorId,
        anon_id: anonId,
        locale: 'en-US',
        message: 'under $80',
        events: [],
      })
      .expect(200);

    expect(secondScope.isDone()).toBe(true);
  });

  test('returns OUT_OF_DOMAIN for beauty/makeup intent under GLOBAL_FASHION taxonomy', async () => {
    process.env.TAXONOMY_VIEW_ID = 'GLOBAL_FASHION';
    const responseBody = require('./samples/find_products_multi_sample.json');

    const upstreamScope = nock('http://localhost:8080')
      .post('/agent/shop/v1/invoke')
      .reply(200, responseBody);

    const res = await request(app)
      .post('/recommend')
      .send({
        trace_id: 't_domain_1',
        creator_id: 'c1',
        anon_id: 'a_domain_1',
        locale: 'ja-JP',
        message: 'メイク ブラシ おすすめ',
        events: [],
      })
      .expect(200);

    expect(res.body.error).toBe('OUT_OF_DOMAIN');
    expect(res.body.cards).toEqual([]);
    expect(res.body.copy_overrides && typeof res.body.copy_overrides.intro_text).toBe('string');
    expect(/[ぁ-んァ-ン一-龥]/.test(res.body.copy_overrides.intro_text)).toBe(true);
    expect(upstreamScope.isDone()).toBe(false);
  });
});

describe('/recommend recall carries the buyer market only when the caller declared one', () => {
  afterEach(() => nock.cleanAll());

  test('a locale is a language, not a market: nothing declared, no metadata.market', async () => {
    const responseBody = require('./samples/find_products_multi_sample.json');
    let seen = null;
    nock('http://localhost:8080')
      .post('/agent/shop/v1/invoke', (body) => {
        seen = body;
        return true;
      })
      .reply(200, responseBody);
    await request(app)
      .post('/recommend')
      .send({ trace_id: 't_mkt_0', creator_id: 'c1', anon_id: 'a_mkt_0', locale: 'en-US', message: 'cozy hoodie gift', events: [] })
      .expect(200);
    expect(seen.metadata.locale).toBe('en-US');
    expect('market' in seen.metadata).toBe(false);
    expect(seen.metadata.invoked_by).toBe('recommend.recall');
  });

  test('an explicit buyer_region travels as metadata.market, upper-cased; junk is dropped', async () => {
    const responseBody = require('./samples/find_products_multi_sample.json');
    const bodies = [];
    nock('http://localhost:8080')
      .post('/agent/shop/v1/invoke', (body) => {
        bodies.push(body);
        return true;
      })
      .times(3)
      .reply(200, responseBody);
    for (const [i, extra] of [[1, { buyer_region: 'sg' }], [2, { market: 'JP' }], [3, { buyer_region: 'USA', market: 'en-US' }]]) {
      await request(app)
        .post('/recommend')
        .send({ trace_id: `t_mkt_${i}`, creator_id: 'c1', anon_id: `a_mkt_${i}`, locale: 'en-US', message: 'cozy hoodie gift', events: [], ...extra })
        .expect(200);
    }
    expect(bodies[0].metadata.market).toBe('SG');
    expect(bodies[1].metadata.market).toBe('JP');
    expect('market' in bodies[2].metadata).toBe(false);
  });
});
