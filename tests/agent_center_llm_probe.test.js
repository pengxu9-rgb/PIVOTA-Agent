/**
 * Unit tests for src/internal/agentCenterLlmProbe.js — the V1 contract that
 * pivota-backend's Agent Center calls into.
 *
 * These tests cover the mock provider end-to-end, the request validator, and
 * the auth middleware. The gemini provider's HTTP path is not exercised here
 * (it requires GEMINI_API_KEY + the real @google/genai client); the structural
 * tests below are sufficient to lock the V1 contract.
 */

'use strict';

describe('agentCenterLlmProbe — request validation', () => {
  const { _internals } = require('../src/internal/agentCenterLlmProbe');
  const { validateRequest, ALLOWED_SCAN_MODES } = _internals;

  test('rejects non-object body', () => {
    expect(validateRequest(null).ok).toBe(false);
    expect(validateRequest(undefined).ok).toBe(false);
    expect(validateRequest('string').ok).toBe(false);
    expect(validateRequest([]).ok).toBe(false);
  });

  test('rejects unknown scan_mode', () => {
    const r = validateRequest({
      scan_mode: 'totally_made_up_mode',
      scan_target_id: 'acst_1',
      merchant_id: 'm1',
      store_id: 's1',
      context: {},
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unsupported scan_mode/);
  });

  test('rejects missing scan_target_id / merchant_id / store_id', () => {
    const base = {
      scan_mode: 'open_product_visibility_test',
      context: {},
    };
    expect(validateRequest({ ...base }).ok).toBe(false);
    expect(validateRequest({ ...base, scan_target_id: 'x' }).ok).toBe(false);
    expect(validateRequest({ ...base, scan_target_id: 'x', merchant_id: 'm1' }).ok).toBe(false);
  });

  test('rejects unknown provider', () => {
    const r = validateRequest({
      scan_mode: 'open_product_visibility_test',
      scan_target_id: 'acst_1',
      merchant_id: 'm1',
      store_id: 's1',
      context: {},
      options: { provider: 'gpt' },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unsupported provider/);
  });

  test('caps max_runs at HARD_MAX_RUNS', () => {
    const r = validateRequest({
      scan_mode: 'open_product_visibility_test',
      scan_target_id: 'acst_1',
      merchant_id: 'm1',
      store_id: 's1',
      context: {},
      options: { max_runs: 9999 },
    });
    expect(r.ok).toBe(true);
    expect(r.normalized.max_runs).toBeLessThanOrEqual(8);
  });

  test('accepts a fully-formed request and normalizes context', () => {
    const r = validateRequest({
      scan_mode: 'pivota_pdp_attribution_test',
      scan_target_id: 'acst_xx',
      merchant_id: 'merch_a',
      store_id: 'store_a',
      context: {
        queries: ['lookup query 1', '  ', 'lookup query 2'],
        merchant_pdp_url: 'https://example.com/p',
        pivota_pdp_url: 'https://agent.pivota.cc/products/pe_xxx',
        product_entity_id: 'pe_xxx',
      },
      options: { provider: 'mock', max_runs: 4 },
    });
    expect(r.ok).toBe(true);
    expect(r.normalized.scan_mode).toBe('pivota_pdp_attribution_test');
    expect(r.normalized.provider).toBe('mock');
    expect(r.normalized.max_runs).toBe(4);
    // Empty/whitespace strings filtered from queries.
    expect(r.normalized.context.queries).toEqual(['lookup query 1', 'lookup query 2']);
    expect(r.normalized.context.pivota_pdp_url).toBe('https://agent.pivota.cc/products/pe_xxx');
  });

  test('PRIMARY_ISSUE_TYPE_BY_SCAN_MODE covers all four demand-test modes', () => {
    const { PRIMARY_ISSUE_TYPE_BY_SCAN_MODE } = _internals;
    for (const mode of ALLOWED_SCAN_MODES) {
      expect(PRIMARY_ISSUE_TYPE_BY_SCAN_MODE[mode]).toBeTruthy();
    }
  });
});

describe('agentCenterLlmProbe — mock provider', () => {
  const { _internals } = require('../src/internal/agentCenterLlmProbe');
  const { buildMockProbe } = _internals;

  test('returns a finding for every demand-test scan_mode', () => {
    const modes = [
      'open_product_visibility_test',
      'merchant_store_attribution_test',
      'pivota_pdp_attribution_test',
      'search_grounded_product_discovery_test',
    ];
    for (const mode of modes) {
      const out = buildMockProbe({ scan_mode: mode, max_runs: 3 });
      expect(out.provider).toBe('mock');
      expect(out.scan_mode).toBe(mode);
      expect(Array.isArray(out.findings)).toBe(true);
      expect(out.findings.length).toBeGreaterThan(0);
      expect(typeof out.scores.visibility_score).toBe('number');
      expect(typeof out.scores.attribution_echo_rate).toBe('number');
      expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    }
  });

  test('runs_count matches max_runs (clamped)', () => {
    expect(buildMockProbe({ scan_mode: 'open_product_visibility_test', max_runs: 1 }).runs_count).toBe(1);
    expect(buildMockProbe({ scan_mode: 'open_product_visibility_test', max_runs: 99 }).runs_count).toBe(8);
  });
});

describe('agentCenterLlmProbe — auth middleware', () => {
  const { _internals } = require('../src/internal/agentCenterLlmProbe');
  const { requireInternalKey } = _internals;

  function makeReq(headers) {
    return {
      header: (name) => headers[name.toLowerCase()] || headers[name],
    };
  }
  function makeRes() {
    return {
      _status: null,
      _body: null,
      status(code) { this._status = code; return this; },
      json(body) { this._body = body; return this; },
    };
  }

  beforeEach(() => {
    delete process.env.PROMOTIONS_ADMIN_KEY;
    delete process.env.AGENT_API_KEY;
    delete process.env.PIVOTA_INTERNAL_API_KEY;
  });

  test('returns 503 when no probe-auth env var is set', () => {
    const req = makeReq({});
    const res = makeRes();
    let nextCalled = false;
    requireInternalKey(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(503);
    expect(res._body.error).toBe('internal_probe_key_not_configured');
    expect(res._body.detail).toContain('PROMOTIONS_ADMIN_KEY');
  });

  test('returns 401 when header is missing (PIVOTA_INTERNAL_API_KEY backward compat)', () => {
    process.env.PIVOTA_INTERNAL_API_KEY = 'secret_xyz';
    const req = makeReq({});
    const res = makeRes();
    let nextCalled = false;
    requireInternalKey(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(401);
  });

  test('returns 401 when header value is wrong', () => {
    process.env.AGENT_API_KEY = 'secret_xyz';
    const req = makeReq({ 'X-Pivota-Internal-Key': 'wrong_key' });
    const res = makeRes();
    let nextCalled = false;
    requireInternalKey(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(401);
  });

  test('passes through when header matches PROMOTIONS_ADMIN_KEY (production preference)', () => {
    process.env.PROMOTIONS_ADMIN_KEY = 'promo_admin_secret';
    const req = makeReq({ 'x-pivota-internal-key': 'promo_admin_secret' });
    const res = makeRes();
    let nextCalled = false;
    requireInternalKey(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(res._status).toBe(null);
  });

  test('passes through when header matches AGENT_API_KEY (gateway convention)', () => {
    process.env.AGENT_API_KEY = 'agent_secret';
    const req = makeReq({ 'x-pivota-internal-key': 'agent_secret' });
    const res = makeRes();
    let nextCalled = false;
    requireInternalKey(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  test('passes through when header matches PIVOTA_INTERNAL_API_KEY (V1 fallback)', () => {
    process.env.PIVOTA_INTERNAL_API_KEY = 'v1_secret';
    const req = makeReq({ 'X-Pivota-Internal-Key': 'v1_secret' });
    const res = makeRes();
    let nextCalled = false;
    requireInternalKey(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  test('PROMOTIONS_ADMIN_KEY wins priority when multiple are set', () => {
    // Production already has PROMOTIONS_ADMIN_KEY set on both services.
    // If ops also sets one of the others later, the priority must keep
    // matching the existing live shared-secret to avoid silently breaking auth.
    process.env.PROMOTIONS_ADMIN_KEY = 'promo';
    process.env.AGENT_API_KEY = 'agent';
    process.env.PIVOTA_INTERNAL_API_KEY = 'v1';
    const req = makeReq({ 'X-Pivota-Internal-Key': 'promo' });
    const res = makeRes();
    let nextCalled = false;
    requireInternalKey(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    // Sending one of the lower-priority values must fail.
    const req2 = makeReq({ 'X-Pivota-Internal-Key': 'agent' });
    const res2 = makeRes();
    requireInternalKey(req2, res2, () => { });
    expect(res2._status).toBe(401);
  });
});

describe('agentCenterLlmProbe — handleProbeRequest end-to-end (mock)', () => {
  const { _internals } = require('../src/internal/agentCenterLlmProbe');
  const { handleProbeRequest } = _internals;

  function makeRes() {
    return {
      _status: null,
      _body: null,
      status(code) { this._status = code; return this; },
      json(body) { this._body = body; return this; },
    };
  }

  test('valid request returns 200 + a structured result', async () => {
    const req = {
      body: {
        scan_mode: 'pivota_pdp_attribution_test',
        scan_target_id: 'acst_test',
        merchant_id: 'merch_a',
        store_id: 'store_a',
        context: {
          queries: ['where can I buy product X'],
          pivota_pdp_url: 'https://agent.pivota.cc/products/pe_x',
        },
        options: { provider: 'mock', max_runs: 2 },
      },
    };
    const res = makeRes();
    await handleProbeRequest(req, res);
    expect(res._status).toBe(200);
    expect(res._body.ok).toBe(true);
    const r = res._body.result;
    expect(r.scan_mode).toBe('pivota_pdp_attribution_test');
    expect(r.provider).toBe('mock');
    expect(r.runs_count).toBe(2);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings[0].issue_type).toBe('pivota_pdp_attribution_gap');
  });

  test('invalid request returns 400 with error message', async () => {
    const req = { body: { scan_mode: 'bogus' } };
    const res = makeRes();
    await handleProbeRequest(req, res);
    expect(res._status).toBe(400);
    expect(res._body.ok).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// URL helpers — replace LLM self-reporting in attribution scoring
// ---------------------------------------------------------------------------

describe('agentCenterLlmProbe — URL helpers', () => {
  const { _internals } = require('../src/internal/agentCenterLlmProbe');
  const { normalizeUrl, textContainsUrl, groundingContainsUrl, textMentionsHostOnly } =
    _internals;

  test('normalizeUrl strips utm + trailing slash + lowercases host + drops www', () => {
    const a = normalizeUrl('https://www.Example.com/p/123/?utm_source=g&size=lg#section');
    const b = normalizeUrl('https://example.com/p/123?size=lg');
    expect(a.full).toBe(b.full);
  });

  test('normalizeUrl returns null for non-URL input', () => {
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl(null)).toBeNull();
    // Whitespace in host throws inside `new URL`, so we return null —
    // safer than producing a host-like field that could match by accident.
    expect(normalizeUrl('not a url')).toBeNull();
    // Bare host (no scheme) is OK — we prepend https://.
    const bareHost = normalizeUrl('example.com/p/1');
    expect(bareHost).toEqual(expect.objectContaining({ host: 'example.com', path: '/p/1' }));
  });

  test('textContainsUrl finds URL even with query-string drift', () => {
    const text = 'You can buy it at https://example.com/p/123?variant=red';
    expect(textContainsUrl(text, 'https://example.com/p/123')).toBe(true);
    expect(textContainsUrl(text, 'https://other.com/p/123')).toBe(false);
  });

  test('textContainsUrl returns false when target URL is empty', () => {
    expect(textContainsUrl('lots of text https://example.com/x', '')).toBe(false);
    expect(textContainsUrl('lots of text https://example.com/x', null)).toBe(false);
  });

  test('groundingContainsUrl matches against cited sources from Gemini', () => {
    const grounding = {
      groundingChunks: [
        { web: { uri: 'https://merchant.com/products/abc' } },
        { web: { uri: 'https://other.io/' } },
      ],
    };
    expect(groundingContainsUrl(grounding, 'https://merchant.com/products/abc?utm_source=x'))
      .toBe(true);
    expect(groundingContainsUrl(grounding, 'https://nope.com/products/abc')).toBe(false);
  });

  test('textMentionsHostOnly distinguishes echoes from real attribution', () => {
    // Mentions pivota.io but not the verified PDP URL → echo
    const echo = 'Pivota (pivota.io) is a service that helps shoppers.';
    expect(textMentionsHostOnly(echo, 'https://pivota.io/p/123')).toBe(true);
    // Mentions the verified URL → not just an echo
    const real = 'See https://pivota.io/p/123 for details.';
    expect(textMentionsHostOnly(real, 'https://pivota.io/p/123')).toBe(false);
    // No mention at all → neither echo nor real
    const none = 'Nothing relevant here.';
    expect(textMentionsHostOnly(none, 'https://pivota.io/p/123')).toBe(false);
  });
});


describe('agentCenterLlmProbe — buildAutoQueries', () => {
  const { _internals } = require('../src/internal/agentCenterLlmProbe');
  const { buildAutoQueries } = _internals;

  test('returns empty array when product.title is missing', () => {
    expect(buildAutoQueries(null)).toEqual([]);
    expect(buildAutoQueries({})).toEqual([]);
    expect(buildAutoQueries({ title: '' })).toEqual([]);
    expect(buildAutoQueries({ title: '   ' })).toEqual([]);
  });

  test('builds buyer-style queries from title alone', () => {
    const qs = buildAutoQueries({ title: 'Vitamin C Tonic 50ml' });
    expect(qs.length).toBeGreaterThanOrEqual(8);
    // Must include the title (real signal) — this is the whole point.
    expect(qs.every((q) => q.includes('Vitamin C Tonic 50ml'))).toBe(true);
    // Must include direct buying intent.
    expect(qs.some((q) => /where can I buy/i.test(q))).toBe(true);
    // Must include comparative.
    expect(qs.some((q) => /reviews/i.test(q))).toBe(true);
  });

  test('adds vendor-anchored variants when vendor is present', () => {
    const qs = buildAutoQueries({ title: 'Vitamin C Tonic', vendor: 'Acme' });
    expect(qs.some((q) => q.includes('Acme Vitamin C Tonic'))).toBe(true);
  });

  test('adds category-anchored "best X" when product_type is present', () => {
    const qs = buildAutoQueries({ title: 'Vitamin C Tonic', product_type: 'serum' });
    expect(qs.some((q) => /best serum/i.test(q))).toBe(true);
  });

  test('order is deterministic (snapshot-friendly)', () => {
    const a = buildAutoQueries({ title: 'X', vendor: 'V', product_type: 't' });
    const b = buildAutoQueries({ title: 'X', vendor: 'V', product_type: 't' });
    expect(a).toEqual(b);
  });
});


describe('agentCenterLlmProbe — buildCategoryQueries', () => {
  const { _internals } = require('../src/internal/agentCenterLlmProbe');
  const { buildCategoryQueries } = _internals;

  it('returns [] when product_type is missing', () => {
    expect(buildCategoryQueries({ title: 'X' })).toEqual([]);
    expect(buildCategoryQueries({})).toEqual([]);
    expect(buildCategoryQueries(null)).toEqual([]);
  });

  it('emits open category queries that DO NOT name the product title', () => {
    // Critical anti-tautology: if the test query says "best Multi-Peptide
    // Lash and Brow Serum", we're back to the V1 problem (model sees
    // product, says yes). Category queries must not include the title.
    const qs = buildCategoryQueries({
      title: 'Multi-Peptide Lash and Brow Serum',
      product_type: 'serum',
    });
    expect(qs.length).toBeGreaterThanOrEqual(4);
    for (const q of qs) {
      expect(q).not.toContain('Multi-Peptide Lash and Brow Serum');
    }
    // Standard category-buyer patterns
    expect(qs.some((q) => /best serums/i.test(q))).toBe(true);
    expect(qs.some((q) => /under \$/i.test(q))).toBe(true);
    expect(qs.some((q) => /dermatologists/i.test(q))).toBe(true);
  });

  it('pluralizes product_type for natural-sounding queries', () => {
    // "best serum 2026" reads weird; "best serums 2026" reads natural.
    const qs = buildCategoryQueries({ title: 'X', product_type: 'serum' });
    expect(qs[0]).toBe('best serums 2026');
    const qs2 = buildCategoryQueries({ title: 'X', product_type: 'eye patch' });
    expect(qs2[0]).toBe('best eye patches 2026');
    // -sh pluralizes with -es
    const qs3 = buildCategoryQueries({ title: 'X', product_type: 'brush' });
    expect(qs3[0]).toBe('best brushes 2026');
    // Already plural — don't double-pluralize
    const qs4 = buildCategoryQueries({ title: 'X', product_type: 'sneakers' });
    expect(qs4[0]).toBe('best sneakers 2026');
  });

  it('includes vendor-anchored peer-set query when vendor is given', () => {
    const qs = buildCategoryQueries({
      title: 'X',
      vendor: 'Beauty of Joseon',
      product_type: 'eye patch',
    });
    // Vendor-soft-constraint query: "top eye patches like Beauty of Joseon"
    expect(qs.some((q) => /like Beauty of Joseon/i.test(q))).toBe(true);
  });
});


describe('agentCenterLlmProbe — category_visibility_test scoring', () => {
  function loadModule() {
    jest.resetModules();
    return require('../src/internal/agentCenterLlmProbe');
  }
  function installFakeClient(generateContentImpl) {
    const probe = loadModule();
    process.env.GEMINI_API_KEY = 'fake-key-for-tests';
    jest.doMock('@google/genai', () => ({
      GoogleGenAI: function GoogleGenAI() {
        return { models: { generateContent: generateContentImpl } };
      },
    }));
    return probe;
  }

  afterEach(() => {
    jest.resetModules();
    jest.dontMock('@google/genai');
    delete process.env.GEMINI_API_KEY;
  });

  test('scores positive when grounding chunk title matches merchant brand', async () => {
    const fake = async () => ({
      text: '{"brand_appears": true, "evidence_excerpt": "Beauty of Joseon ranked #2 in our list"}',
      candidates: [
        {
          content: { parts: [{ text: '{"brand_appears": true}' }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://vertexaisearch.cloud.google.com/x', title: 'Allure: Best K-beauty eye patches' } },
              { web: { uri: 'https://vertexaisearch.cloud.google.com/y', title: 'Beauty of Joseon Official Store' } },
            ],
          },
        },
      ],
    });
    const probe = installFakeClient(fake);
    const out = await probe._internals.buildGeminiProbe({
      scan_mode: 'category_visibility_test',
      max_runs: 1,
      context: {
        queries: ['best Korean eye patches 2026'],
        merchant_pdp_url: 'https://beautyofjoseon.com/products/under-eye-patch',
        product: { title: 'Under Eye Patch', vendor: 'Beauty of Joseon', product_type: 'eye patch' },
      },
    });
    // Grounding title "Beauty of Joseon Official Store" matches brand.
    expect(out.scores.visibility_score).toBe(100);
    expect(out.raw_runs[0].url_match.in_grounding).toBe(true);
  });

  test('scores zero when grounding cites only competitors, not the merchant brand', async () => {
    const fake = async () => ({
      text: '{"brand_appears": false, "competitors_appearing": ["Sephora", "Olive Young"]}',
      candidates: [
        {
          content: { parts: [{ text: '{"brand_appears": false}' }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://vertexaisearch.cloud.google.com/a', title: 'Sephora Top 10 Picks' } },
              { web: { uri: 'https://vertexaisearch.cloud.google.com/b', title: 'Olive Young Best Sellers' } },
            ],
          },
        },
      ],
    });
    const probe = installFakeClient(fake);
    const out = await probe._internals.buildGeminiProbe({
      scan_mode: 'category_visibility_test',
      max_runs: 1,
      context: {
        queries: ['best Korean eye patches 2026'],
        merchant_pdp_url: 'https://beautyofjoseon.com/products/under-eye-patch',
        product: { title: 'Under Eye Patch', vendor: 'Beauty of Joseon', product_type: 'eye patch' },
      },
    });
    expect(out.scores.visibility_score).toBe(0);
    expect(out.raw_runs[0].url_match.in_grounding).toBe(false);
    expect(out.raw_runs[0].url_match.in_text).toBe(false); // category mode never trusts text match
  });

  test('emits category_discoverability_gap finding when score < 50', async () => {
    const fake = async () => ({
      text: '{"brand_appears": false}',
      candidates: [
        {
          content: { parts: [{ text: '{"brand_appears": false}' }] },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: 'https://x.com', title: 'Some Other Brand' } }],
          },
        },
      ],
    });
    const probe = installFakeClient(fake);
    const out = await probe._internals.buildGeminiProbe({
      scan_mode: 'category_visibility_test',
      max_runs: 1,
      context: {
        queries: ['best K-beauty eye patches'],
        merchant_pdp_url: 'https://beautyofjoseon.com/p/x',
        product: { title: 'X', vendor: 'Beauty of Joseon', product_type: 'eye patch' },
      },
    });
    expect(out.findings.length).toBeGreaterThanOrEqual(1);
    const types = out.findings.map((f) => f.issue_type);
    expect(types).toContain('category_discoverability_gap');
  });

  test('uses category-open queries (NOT product-named) when context.queries is empty', async () => {
    const observedPrompts = [];
    const fake = async (args) => {
      const text = args.contents?.[0]?.parts?.[0]?.text || '';
      observedPrompts.push(text);
      return {
        text: '{"brand_appears": false}',
        candidates: [{ content: { parts: [{ text: '{"brand_appears": false}' }] } }],
      };
    };
    const probe = installFakeClient(fake);
    await probe._internals.buildGeminiProbe({
      scan_mode: 'category_visibility_test',
      max_runs: 4,
      context: {
        queries: [],
        merchant_pdp_url: 'https://x.com',
        product: { title: 'My Specific Product Name', vendor: 'BrandX', product_type: 'serum' },
      },
    });
    // Anti-tautology: queries must NOT include the product title.
    for (const p of observedPrompts) {
      expect(p).not.toContain('My Specific Product Name');
    }
    // Category-open queries should fire.
    expect(observedPrompts.some((p) => /best serums/i.test(p))).toBe(true);
  });

  test('mock provider supports category_visibility_test with conservative score', async () => {
    const probe = require('../src/internal/agentCenterLlmProbe');
    const out = probe._internals.buildMockProbe({
      scan_mode: 'category_visibility_test',
      max_runs: 3,
    });
    // Mock score is 25 — finding fires (< 50 threshold).
    expect(out.scores.visibility_score).toBe(25);
    expect(out.findings.length).toBe(1);
    expect(out.findings[0].issue_type).toBe('category_discoverability_gap');
  });

  test('validateRequest accepts category_visibility_test scan_mode', () => {
    const probe = require('../src/internal/agentCenterLlmProbe');
    const r = probe._internals.validateRequest({
      scan_mode: 'category_visibility_test',
      scan_target_id: 'acst_1',
      merchant_id: 'm1',
      store_id: 's1',
      context: {},
    });
    expect(r.ok).toBe(true);
    expect(r.normalized.scan_mode).toBe('category_visibility_test');
  });
});


// ---------------------------------------------------------------------------
// buildGeminiProbe — full path with a mocked @google/genai client. We mock
// `client.models.generateContent` directly so we can construct realistic
// response shapes (with groundingMetadata) without burning real API quota.
// ---------------------------------------------------------------------------

describe('agentCenterLlmProbe — buildGeminiProbe with mocked client + grounding', () => {
  // Lazy-load the module fresh for each test so we can re-monkeypatch the
  // cached client.
  function loadModule() {
    jest.resetModules();
    return require('../src/internal/agentCenterLlmProbe');
  }

  function installFakeClient(generateContentImpl) {
    const probe = loadModule();
    // Replace getGeminiClient via require() cache. The module caches the
    // client privately; we patch by setting GEMINI_API_KEY (so getGeminiClient
    // tries to load @google/genai) and stubbing the constructor.
    process.env.GEMINI_API_KEY = 'fake-key-for-tests';
    jest.doMock('@google/genai', () => ({
      GoogleGenAI: function GoogleGenAI() {
        return {
          models: { generateContent: generateContentImpl },
        };
      },
    }));
    return probe;
  }

  afterEach(() => {
    jest.resetModules();
    jest.dontMock('@google/genai');
    delete process.env.GEMINI_API_KEY;
  });

  test('config passes Google Search grounding tool', async () => {
    let observedConfig = null;
    const fake = async (args) => {
      observedConfig = args.config;
      return {
        text: '{"product_visible": true}',
        candidates: [{ content: { parts: [{ text: '{"product_visible": true}' }] } }],
      };
    };
    const probe = installFakeClient(fake);
    await probe._internals.buildGeminiProbe({
      scan_mode: 'open_product_visibility_test',
      max_runs: 1,
      context: { queries: ['test query'], product_entity_id: 'p1' },
    });
    expect(observedConfig).toBeTruthy();
    expect(observedConfig.tools).toEqual([{ googleSearch: {} }]);
    // Strict JSON mode must be OFF — incompatible with grounding.
    expect(observedConfig.responseMimeType).toBeUndefined();
  });

  test('pivota_pdp_attribution scores from grounding URL match, not LLM self-report', async () => {
    // Critical fix: the LLM hallucinates `pivota_url_found: false` (lying),
    // but the grounding chunks PROVE the URL was cited. Score must reflect
    // the evidence (positive), not the lie.
    const fake = async () => ({
      text: '{"pivota_url_found": false, "pivota_echo_only": false, "evidence_excerpt": "..."}',
      candidates: [
        {
          content: { parts: [{ text: '{"pivota_url_found": false}' }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://pivota.io/p/abc-123' } },
              { web: { uri: 'https://other.com/whatever' } },
            ],
          },
        },
      ],
    });
    const probe = installFakeClient(fake);
    const out = await probe._internals.buildGeminiProbe({
      scan_mode: 'pivota_pdp_attribution_test',
      max_runs: 1,
      context: { queries: ['where to buy'], pivota_pdp_url: 'https://pivota.io/p/abc-123' },
    });
    expect(out.scores.visibility_score).toBe(100);
    expect(out.findings).toEqual([]);
    // Audit trail: url_match block must show in_grounding=true and the
    // disagreement with the LLM self-report.
    const um = out.raw_runs[0].url_match;
    expect(um.in_grounding).toBe(true);
    expect(um.llm_self_report.pivota_url_found).toBe(false);
  });

  test('pivota_pdp_attribution echo: host mentioned but URL not cited', async () => {
    // The LLM says "Pivota helps you shop" but doesn't actually cite the
    // verified PDP. Score = 0 (no real attribution), echo rate > 0.
    const fake = async () => ({
      text: 'Pivota (pivota.io) is a useful service.',
      candidates: [
        {
          content: { parts: [{ text: 'Pivota (pivota.io) is a useful service.' }] },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: 'https://unrelated.com/article' } }],
          },
        },
      ],
    });
    const probe = installFakeClient(fake);
    const out = await probe._internals.buildGeminiProbe({
      scan_mode: 'pivota_pdp_attribution_test',
      max_runs: 1,
      context: { queries: ['where to buy'], pivota_pdp_url: 'https://pivota.io/p/abc-123' },
    });
    expect(out.scores.visibility_score).toBe(0);
    expect(out.scores.attribution_echo_rate).toBe(100);
    // Two findings: gap (because score < 50) AND unverified attribution
    // (because echoRate>0 and positives==0).
    const types = out.findings.map((f) => f.issue_type);
    expect(types).toContain('pivota_pdp_attribution_gap');
    expect(types).toContain('unverified_pivota_attribution');
  });

  test('merchant_store_attribution: text URL match alone does NOT count as positive', async () => {
    // POST-AUDIT FIX: real Beauty of Joseon run had the model writing
    // its own merchant URL in prose while explaining "this URL is NOT
    // in the search results" — counted as a false positive under the
    // V1 in_text logic. Only grounding chunks (real search citations)
    // count toward the score now. in_text is preserved in audit only.
    const fake = async () => ({
      text:
        "The merchant URL 'https://merchant.com/p/123' is NOT directly " +
        "mentioned in the search results, but Sephora and Ulta both list it.",
      candidates: [
        {
          content: {
            parts: [{ text:
              "The merchant URL 'https://merchant.com/p/123' is NOT directly " +
              "mentioned in the search results, but Sephora and Ulta both list it." }],
          },
          // NO groundingMetadata → in_grounding=false
        },
      ],
    });
    const probe = installFakeClient(fake);
    const out = await probe._internals.buildGeminiProbe({
      scan_mode: 'merchant_store_attribution_test',
      max_runs: 1,
      context: { queries: ['where to buy'], merchant_pdp_url: 'https://merchant.com/p/123' },
    });
    // Visibility score = 0 because no grounding evidence.
    expect(out.scores.visibility_score).toBe(0);
    const um = out.raw_runs[0].url_match;
    expect(um.in_grounding).toBe(false);
    // Text DID match (prose contains the URL) — preserved for audit.
    expect(um.in_text).toBe(true);
    // BUT the score didn't include it as positive — that's the fix.
  });

  test('merchant_store_attribution: positive when grounding title contains brand', async () => {
    // Real Beauty of Joseon run: chunk URI is a vertexaisearch redirector,
    // but title is "Beauty of Joseon Official Store". Title-based match
    // catches this case (host-via-redirector match would fail).
    const fake = async () => ({
      text: '{"merchant_url_found": true, "evidence_excerpt": "Beauty of Joseon Official Store"}',
      candidates: [
        {
          content: { parts: [{ text: '{"merchant_url_found": true}' }] },
          groundingMetadata: {
            groundingChunks: [
              {
                web: {
                  uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc',
                  title: 'Beauty of Joseon Official Store',
                },
              },
            ],
          },
        },
      ],
    });
    const probe = installFakeClient(fake);
    const out = await probe._internals.buildGeminiProbe({
      scan_mode: 'merchant_store_attribution_test',
      max_runs: 1,
      context: {
        queries: ['where to buy'],
        merchant_pdp_url: 'https://beautyofjoseon.com/products/under-eye-patch',
        product: { vendor: 'Beauty of Joseon', title: 'Under Eye Patch' },
      },
    });
    expect(out.scores.visibility_score).toBe(100);
    expect(out.raw_runs[0].url_match.in_grounding).toBe(true);
  });

  test('open_visibility: self-report=true with NO grounding does NOT score positive (anti-tautology)', async () => {
    // POST-AUDIT FIX: real Beauty of Joseon run had visibility=100% from
    // 3 self-reports with empty grounding_chunks — the model just echoed
    // "yes" because the query mentioned the product. No real signal.
    // Now requires hasAnyGrounding for positive scoring.
    const fake = async () => ({
      text: '{"product_visible": true, "evidence_excerpt": "the query"}',
      candidates: [
        {
          content: { parts: [{ text: '{"product_visible": true}' }] },
          // NO groundingMetadata
        },
      ],
    });
    const probe = installFakeClient(fake);
    const out = await probe._internals.buildGeminiProbe({
      scan_mode: 'open_product_visibility_test',
      max_runs: 3,
      context: { queries: ['where to buy X', 'shop X online', 'X for sale'],
                 product: { title: 'X' } },
    });
    expect(out.scores.visibility_score).toBe(0);
  });

  test('open_visibility: self-report=true WITH grounding scores positive', async () => {
    const fake = async () => ({
      text: '{"product_visible": true}',
      candidates: [
        {
          content: { parts: [{ text: '{"product_visible": true}' }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://vertexaisearch.cloud.google.com/x', title: 'Sephora' } },
            ],
          },
        },
      ],
    });
    const probe = installFakeClient(fake);
    const out = await probe._internals.buildGeminiProbe({
      scan_mode: 'open_product_visibility_test',
      max_runs: 1,
      context: { queries: ['where to buy X'], product: { title: 'X' } },
    });
    expect(out.scores.visibility_score).toBe(100);
  });

  test('raw_runs include grounding_sources with both uri AND title', async () => {
    // Title is the canonical signal for "what site did Gemini cite";
    // backend uses it to extract real competitor hosts.
    const fake = async () => ({
      text: '{"product_visible": true}',
      candidates: [
        {
          content: { parts: [{ text: '{"product_visible": true}' }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://vertexaisearch.cloud.google.com/abc', title: 'Sephora' } },
              { web: { uri: 'https://vertexaisearch.cloud.google.com/def', title: 'Olive Young Global' } },
            ],
          },
        },
      ],
    });
    const probe = installFakeClient(fake);
    const out = await probe._internals.buildGeminiProbe({
      scan_mode: 'open_product_visibility_test',
      max_runs: 1,
      context: { queries: ['X'], product: { title: 'X' } },
    });
    expect(out.raw_runs[0].grounding_sources).toEqual([
      { uri: 'https://vertexaisearch.cloud.google.com/abc', title: 'Sephora' },
      { uri: 'https://vertexaisearch.cloud.google.com/def', title: 'Olive Young Global' },
    ]);
  });

  test('grounding chunks are surfaced in raw_runs for evidence', async () => {
    const fake = async () => ({
      text: '{"product_visible": true}',
      candidates: [
        {
          content: { parts: [{ text: '{"product_visible": true}' }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://a.example/1' } },
              { web: { uri: 'https://b.example/2' } },
            ],
          },
        },
      ],
    });
    const probe = installFakeClient(fake);
    const out = await probe._internals.buildGeminiProbe({
      scan_mode: 'open_product_visibility_test',
      max_runs: 1,
      context: { queries: ['test'], product_entity_id: 'p1' },
    });
    expect(out.raw_runs[0].grounding_chunks).toEqual([
      'https://a.example/1',
      'https://b.example/2',
    ]);
  });

  test('unwrapJson recovers JSON wrapped in prose (grounding mode)', async () => {
    const probe = loadModule();
    const { unwrapJson } = probe._internals;
    // Without strict JSON mode, Gemini sometimes prefaces the JSON with prose.
    expect(
      unwrapJson('Here is the result:\n{"product_visible": true, "evidence_excerpt": "..."}\n'),
    ).toEqual({ product_visible: true, evidence_excerpt: '...' });
    // ```json fences still work
    expect(unwrapJson('```json\n{"x": 1}\n```')).toEqual({ x: 1 });
    // Bare unparseable returns null
    expect(unwrapJson('not json at all')).toBeNull();
  });

  test('pivota_pdp_attribution aborts cleanly when pivota_pdp_url missing', async () => {
    // Critical: V1 ran the test anyway, scored 0%, and produced a
    // misleading `pivota_pdp_attribution_gap` finding — when the real
    // problem was the operator forgot to provide the URL.
    let calls = 0;
    const fake = async () => {
      calls += 1;
      return { text: '{}', candidates: [{ content: { parts: [{ text: '{}' }] } }] };
    };
    const probe = installFakeClient(fake);
    const out = await probe._internals.buildGeminiProbe({
      scan_mode: 'pivota_pdp_attribution_test',
      max_runs: 3,
      context: { queries: ['where to buy'], pivota_pdp_url: '' },
    });
    expect(calls).toBe(0); // No Gemini call burned
    expect(out.aborted).toBe('missing_input');
    expect(out.findings).toEqual([
      expect.objectContaining({
        issue_type: 'missing_pivota_pdp_url',
        evidence: expect.objectContaining({ kind: 'missing_input' }),
      }),
    ]);
    // Score is 0 but that's because the test didn't run, not because the
    // PDP wasn't found. The `aborted` field is what the UI keys off of.
  });

  test('merchant_store_attribution aborts cleanly when merchant_pdp_url missing', async () => {
    let calls = 0;
    const fake = async () => {
      calls += 1;
      return { text: '{}', candidates: [{ content: { parts: [{ text: '{}' }] } }] };
    };
    const probe = installFakeClient(fake);
    const out = await probe._internals.buildGeminiProbe({
      scan_mode: 'merchant_store_attribution_test',
      max_runs: 3,
      context: { queries: ['where to buy'], merchant_pdp_url: '   ' }, // whitespace-only
    });
    expect(calls).toBe(0);
    expect(out.aborted).toBe('missing_input');
    expect(out.findings[0].issue_type).toBe('missing_merchant_pdp_url');
  });

  test('auto query generator runs when context.queries is empty and product.title is set', async () => {
    // Critical: V1 fallback was `[product_entity_id]` which is meaningless
    // garbage to an LLM. PR 15 generates real buyer-style queries from
    // product.title — this test asserts the generator is wired in.
    const calls = [];
    const fake = async (args) => {
      const part = args.contents?.[0]?.parts?.[0]?.text || '';
      calls.push(part);
      return {
        text: '{"product_visible": true}',
        candidates: [{ content: { parts: [{ text: '{"product_visible": true}' }] } }],
      };
    };
    const probe = installFakeClient(fake);
    const out = await probe._internals.buildGeminiProbe({
      scan_mode: 'open_product_visibility_test',
      max_runs: 4,
      context: {
        queries: [],
        product_entity_id: 'm1|shopify|P1',
        product: { title: 'Vitamin C Tonic 50ml', vendor: 'Acme', product_type: 'serum' },
      },
    });
    expect(out.runs_count).toBe(4);
    // None of the prompts should contain the meaningless product_entity_id.
    for (const p of calls) {
      expect(p).not.toContain('m1|shopify|P1');
    }
    // At least one query should reference the product title.
    expect(calls.some((p) => p.includes('Vitamin C Tonic 50ml'))).toBe(true);
  });

  test('auto query generator falls back to product_entity_id when product.title is missing', async () => {
    // Backward-compat: existing scan_targets without product info still
    // work (just less well, as before).
    const calls = [];
    const fake = async (args) => {
      calls.push(args.contents?.[0]?.parts?.[0]?.text || '');
      return {
        text: '{"product_visible": true}',
        candidates: [{ content: { parts: [{ text: '{"product_visible": true}' }] } }],
      };
    };
    const probe = installFakeClient(fake);
    const out = await probe._internals.buildGeminiProbe({
      scan_mode: 'open_product_visibility_test',
      max_runs: 1,
      context: {
        queries: [],
        product_entity_id: 'm1|shopify|P1',
        product: null,
      },
    });
    expect(out.runs_count).toBe(1);
    expect(calls[0]).toContain('m1|shopify|P1');
  });

  test('auto query generator is bypassed when operator wrote queries manually', async () => {
    const calls = [];
    const fake = async (args) => {
      calls.push(args.contents?.[0]?.parts?.[0]?.text || '');
      return {
        text: '{"product_visible": true}',
        candidates: [{ content: { parts: [{ text: '{"product_visible": true}' }] } }],
      };
    };
    const probe = installFakeClient(fake);
    await probe._internals.buildGeminiProbe({
      scan_mode: 'open_product_visibility_test',
      max_runs: 1,
      context: {
        queries: ['my custom query'],
        product: { title: 'Vitamin C Tonic 50ml' },
      },
    });
    // Operator's query wins.
    expect(calls[0]).toContain('my custom query');
    // Auto-generated buyer-intent phrasing must NOT appear when operator
    // provided their own queries (the auto generator is bypassed).
    expect(calls[0]).not.toContain('where can I buy');
    expect(calls[0]).not.toContain('shop Vitamin C Tonic 50ml online');
  });

  test('open_visibility tests do NOT require a URL — runs as normal', async () => {
    // Regression guard: the URL guard must not affect non-attribution modes.
    let called = 0;
    const fake = async () => {
      called += 1;
      return {
        text: '{"product_visible": true}',
        candidates: [{ content: { parts: [{ text: '{"product_visible": true}' }] } }],
      };
    };
    const probe = installFakeClient(fake);
    const out = await probe._internals.buildGeminiProbe({
      scan_mode: 'open_product_visibility_test',
      max_runs: 1,
      context: { queries: ['test'], product_entity_id: 'p1' },
    });
    expect(called).toBe(1);
    expect(out.aborted).toBeUndefined();
  });
});
