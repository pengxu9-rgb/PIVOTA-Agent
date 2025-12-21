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
});
