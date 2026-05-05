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
