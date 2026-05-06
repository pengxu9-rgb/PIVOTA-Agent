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
    delete process.env.PIVOTA_INTERNAL_API_KEY;
  });

  test('returns 503 when PIVOTA_INTERNAL_API_KEY is unset', () => {
    const req = makeReq({});
    const res = makeRes();
    let nextCalled = false;
    requireInternalKey(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(503);
    expect(res._body.error).toBe('pivota_internal_api_key_not_configured');
  });

  test('returns 401 when header is missing', () => {
    process.env.PIVOTA_INTERNAL_API_KEY = 'secret_xyz';
    const req = makeReq({});
    const res = makeRes();
    let nextCalled = false;
    requireInternalKey(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(401);
  });

  test('returns 401 when header value is wrong', () => {
    process.env.PIVOTA_INTERNAL_API_KEY = 'secret_xyz';
    const req = makeReq({ 'X-Pivota-Internal-Key': 'wrong_key' });
    const res = makeRes();
    let nextCalled = false;
    requireInternalKey(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(401);
  });

  test('passes through when header matches (case-insensitive lookup)', () => {
    process.env.PIVOTA_INTERNAL_API_KEY = 'secret_xyz';
    const req = makeReq({ 'x-pivota-internal-key': 'secret_xyz' });
    const res = makeRes();
    let nextCalled = false;
    requireInternalKey(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(res._status).toBe(null);
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

  test('merchant_store_attribution: text URL match counts as positive', async () => {
    // No grounding chunks here — just a URL inlined in the prose.
    const fake = async () => ({
      text: 'Buy it at https://merchant.com/p/123 for fastest shipping.',
      candidates: [
        {
          content: {
            parts: [{ text: 'Buy it at https://merchant.com/p/123 for fastest shipping.' }],
          },
        },
      ],
    });
    const probe = installFakeClient(fake);
    const out = await probe._internals.buildGeminiProbe({
      scan_mode: 'merchant_store_attribution_test',
      max_runs: 1,
      context: { queries: ['where to buy'], merchant_pdp_url: 'https://merchant.com/p/123' },
    });
    expect(out.scores.visibility_score).toBe(100);
    expect(out.findings).toEqual([]);
    const um = out.raw_runs[0].url_match;
    expect(um.in_grounding).toBe(false);
    expect(um.in_text).toBe(true);
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
});
