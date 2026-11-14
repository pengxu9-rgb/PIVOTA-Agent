'use strict';

const authModule = require.resolve('google-auth-library', {
  paths: [require.resolve('@google/genai')],
});
const geminiGateModule = '../src/lib/geminiGlobalGate';
const cloudScope = 'https://www.googleapis.com/auth/cloud-platform';
const productUrl = 'https://shop.example/products/test-essence';
const merchantId = 'legacy_merchant';
const runId = '12345678-abcd-4cde-8f01-123456789abc';
const brandedTarget = `${runId}:test-sku:gemini:per_sku:branded:1`;
const discoveryTarget = `${runId}:test-sku:gemini:per_sku:discovery:1`;

let priorEnv;

beforeEach(() => {
  priorEnv = process.env;
  process.env = {
    ...priorEnv,
    VERTEX_AI_ENABLED: 'false',
    GOOGLE_GENAI_USE_VERTEXAI: 'false',
    GOOGLE_CLOUD_LOCATION: 'global',
    GOOGLE_CLOUD_PROJECT: 'legacy-vertex',
    GOOGLE_APPLICATION_CREDENTIALS: '/will-not-be-used.json',
    GOOGLE_APPLICATION_CREDENTIALS_JSON: 'will-not-be-parsed',
    GEMINI_API_KEY: 'fake-legacy-gemini-key',
    GOOGLE_API_KEY: 'fake-global-google-key',
    PIVOTA_CONSUMER_ANSWER_ENABLED: 'true',
  };
  delete process.env.PIVOTA_AGENT_CENTER_GEMINI_VERTEX_PROJECT;
  jest.resetModules();
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = priorEnv;
});

function simulateProvider() {
  return jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
    modelVersion: 'gemini-2.5-flash',
    candidates: [{
      finishReason: 'STOP',
      content: { role: 'model', parts: [{ text: '{"product_visible": true}' }] },
      groundingMetadata: { groundingChunks: [{ web: { uri: productUrl } }] },
    }],
  }), { headers: { 'content-type': 'application/json' } }));
}

async function requestProbe(scanMode, storeId, target, merchant = merchantId) {
  const { handleProbeRequest } = require('../src/internal/agentCenterLlmProbe')._internals;
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await handleProbeRequest({ body: {
    merchant_id: merchant,
    store_id: storeId,
    scan_target_id: target,
    scan_mode: scanMode,
    context: { queries: ['Where can I buy this essence?'], product: { title: 'Test Essence' } },
    options: { provider: 'gemini', max_runs: 1 },
  } }, response);
  expect(response.status).toHaveBeenCalledWith(200);
  return response.json.mock.calls[0][0].result;
}

test('merchant diagnostic and answer capture use the configured Vertex project and attached identity', async () => {
  process.env.PIVOTA_AGENT_CENTER_GEMINI_VERTEX_PROJECT = 'audit-vertex';
  // Vertex is already enabled on production. Poison both legacy credential
  // sources above so accidental fallback fails instead of contacting Google.
  process.env.VERTEX_AI_ENABLED = 'true';
  const { Compute } = require(authModule);
  const credentials = jest.spyOn(Compute.prototype, 'getAccessToken').mockResolvedValue({ token: 'fake-attached-token' });
  const request = simulateProvider();

  const diagnostic = await requestProbe('open_product_visibility_test', `${merchantId}_audit`, brandedTarget);
  await requestProbe('category_visibility_test', `${merchantId}_audit`, discoveryTarget);
  await requestProbe('open_product_visibility_test', `${merchantId}_audit`, 'adhoc:competitor_attrs:test_brand:gemini');
  const answer = await requestProbe('consumer_answer_test', `${merchantId}_audit`, `${runId}:consumer:${'a'.repeat(64)}`);

  expect(diagnostic.raw_runs[0].grounding_chunks).toEqual([productUrl]);
  expect(answer.raw_runs[0].answer).toMatchObject({ complete: true, provider: 'gemini' });
  expect(request).toHaveBeenCalledTimes(4);
  expect(credentials).toHaveBeenCalledTimes(4);
  expect(credentials.mock.contexts[0].scopes).toEqual([cloudScope]);
  expect(credentials.mock.contexts[0].serviceAccountEmail).toBe('default');
  for (const [url, init] of request.mock.calls) {
    expect(String(url)).toMatch(/^https:\/\/aiplatform\.googleapis\.com\/v1beta1\/projects\/audit-vertex\/locations\/global\//);
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer fake-attached-token');
    expect(headers.has('x-goog-api-key')).toBe(false);
    expect(JSON.parse(init.body).tools).toEqual([{ googleSearch: {} }]);
  }
});

test.each([
  ['unset project', null, `${merchantId}_audit`, discoveryTarget, merchantId],
  ['lead probe', 'audit-vertex', `${merchantId}_lead`, 'bd-category_visibility_test-123', merchantId],
  ['different tenant suffix', 'audit-vertex', 'other_merchant_audit', discoveryTarget, merchantId],
  ['demand test with audit-like store', 'audit-vertex', `${merchantId}_audit`, 'acst_169763e3d1e8', merchantId],
  ['staff prospect', 'audit-vertex', 'prospect_sample_audit', 'adhoc:test-sku:gemini:per_sku:discovery:1', 'prospect_sample'],
])('retains the shared Gemini transport for %s', async (_label, project, storeId, target, merchant) => {
  if (project) process.env.PIVOTA_AGENT_CENTER_GEMINI_VERTEX_PROJECT = project;
  delete process.env.GOOGLE_API_KEY;
  const request = simulateProvider();

  await requestProbe('category_visibility_test', storeId, target, merchant);

  const [url, init] = request.mock.calls[0];
  expect(String(url)).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\//);
  const headers = new Headers(init.headers);
  expect(headers.get('x-goog-api-key')).toBe('fake-legacy-gemini-key');
  expect(headers.has('authorization')).toBe(false);
});

test('an open shared Gemini circuit cannot block enabled merchant audit probes', async () => {
  process.env.PIVOTA_AGENT_CENTER_GEMINI_VERTEX_PROJECT = 'audit-vertex';
  process.env.GEMINI_GLOBAL_CIRCUIT_FAIL_THRESHOLD = '1';
  const gates = require(geminiGateModule);
  const sharedGate = gates.getGeminiGlobalGate();
  const auditGate = gates.getMerchantAuditGeminiGate();
  const { withProbeCostGate } = require('../src/internal/agentCenterLlmProbe')._internals;

  const broken = async () => { throw new Error('legacy project billing disabled'); };
  await expect(sharedGate.withGate('legacy', broken)).rejects.toThrow('legacy project billing disabled');
  expect(sharedGate.snapshot().gate.circuitOpen).toBe(true);
  expect(auditGate.snapshot().gate.circuitOpen).toBe(false);
  const store = {
    merchant_id: merchantId,
    store_id: `${merchantId}_audit`,
    scan_mode: 'category_visibility_test',
    scan_target_id: discoveryTarget,
  };
  await expect(withProbeCostGate(store, 'gemini', async () => 'audited')).resolves.toBe('audited');
});
