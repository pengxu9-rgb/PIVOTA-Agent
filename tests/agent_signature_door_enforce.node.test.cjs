'use strict';

// agentSignatureMiddleware in ENFORCE mode, on the LIVE gateway app (the observe/off behaviour on the same
// app is pinned in tests/agent_signature_door_middleware.node.test.cjs, which this PR leaves as it was).
//
// Every signed request is made with signTapRequest (src/services/tapSigner.js) — no hand-built header
// strings. Env is read per request by the middleware, so each test sets exactly the variables it needs and
// restores them.
//
// The identity probe: a route mounted by this test on a door path (/ucp/…), registered after the app's own
// routes. It answers with what the request carries after the middleware ran — req.agentIdentity, the invoke
// context built from the request, and the order metadata that context produces — so the whole chain from
// "signature verified" to "order row field" is checked on the real middleware, not on a stand-in.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');
const supertest = require('supertest');

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
const ENV_KEYS = ['AGENT_SIGNATURE_VERIFY_MODE', 'AGENT_SIGNATURE_ENFORCE_ROUTE_GROUPS', 'AGENT_SIGNATURE_ENFORCE_MERCHANTS_JSON', 'AGENT_SIGNATURE_TRUSTED_KEY_SOURCES_JSON'];
for (const k of ENV_KEYS) delete process.env[k];

const app = require('../src/server');
const logger = require('../src/logger');
const { signTapRequest } = require('../src/services/tapSigner');

const { _debug } = app;
const HOST = 'commerce.mcp.pivota.cc';
const VISA_URL = 'https://mcp.visa.com/.well-known/jwks';
const visa = nodeCrypto.generateKeyPairSync('ed25519');
const stranger = nodeCrypto.generateKeyPairSync('ed25519');
const JWKS = { keys: [{ ...visa.publicKey.export({ format: 'jwk' }), kid: 'visa-door-key' }] };

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) === VISA_URL) return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(JWKS) };
  return realFetch(url, init);
};
test.after(() => { globalThis.fetch = realFetch; });

const PROBE = '/ucp/__tap_identity_probe';
app.post(PROBE, (req, res) => {
  const ctx = _debug.buildExternalInvokeContext(req);
  const order = _debug.applyStrictHostedOrderMetadata({ quote_id: 'q_1', metadata: { agent_signature: { forged: true }, keep: 1 } }, ctx);
  res.json({ identity: req.agentIdentity || null, ctx_agent_signature: ctx.agent_signature, order_metadata: order.metadata });
});

// ---- helpers --------------------------------------------------------------------------------------------

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
async function captureLogs(fn) {
  const entries = [];
  const original = {};
  for (const level of LOG_LEVELS) {
    if (typeof logger[level] !== 'function') continue;
    original[level] = logger[level];
    logger[level] = (...args) => {
      entries.push(args[0]);
      return original[level].apply(logger, args);
    };
  }
  try {
    return { result: await fn(), entries };
  } finally {
    for (const [level, impl] of Object.entries(original)) logger[level] = impl;
  }
}
const sigEvents = (entries) => entries.filter((e) => e && e.event === 'agent_signature');

async function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// TAP headers for `path`, signed with Visa's test key unless told otherwise.
function tap(path, opts = {}) {
  return signTapRequest({ url: `https://${HOST}${path}`, privateKey: visa.privateKey, keyid: 'visa-door-key', ...opts }).headers;
}

const RPC_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const rpcCall = (name, args = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

function post(path, { headers = {}, body = RPC_LIST } = {}) {
  return supertest(app).post(path).set('host', HOST).set(headers).set('content-type', 'application/json').send(body);
}

const ENFORCE_ALL = { AGENT_SIGNATURE_VERIFY_MODE: 'enforce', AGENT_SIGNATURE_ENFORCE_ROUTE_GROUPS: 'merchant_doors,checkout' };

// ---- the five outcomes on a live door -------------------------------------------------------------------

test('enforce: a VALID TAP signature gets the same response as unsigned, and its identity reaches the order metadata', async () => {
  await withEnv(ENFORCE_ALL, async () => {
    const unsigned = await post('/ucp/mcp');
    const valid = await captureLogs(() => post('/ucp/mcp', { headers: tap('/ucp/mcp') }));
    assert.equal(valid.result.status, unsigned.status);
    assert.deepEqual(valid.result.body, unsigned.body);
    const [event] = sigEvents(valid.entries);
    assert.equal(event.verified, true, event.reason);
    assert.equal(event.enforce_action, 'pass');
    assert.equal(event.enforce_reason, 'verified_tap');
    assert.equal(event.route_group, 'merchant_doors');
    assert.equal(event.authority, HOST);

    const probe = await post(PROBE, { headers: tap(PROBE, { tag: 'agent-payer-auth' }), body: {} });
    assert.equal(probe.status, 200);
    assert.equal(probe.body.identity.protocol, 'visa-tap');
    assert.equal(probe.body.identity.authority, HOST);
    assert.equal(probe.body.identity.keyid, 'visa-door-key');
    assert.equal(probe.body.identity.tag, 'agent-payer-auth');
    assert.deepEqual(probe.body.ctx_agent_signature, probe.body.identity);
    // Recorded on the order: the verified identity, never the caller-supplied one.
    assert.deepEqual(probe.body.order_metadata.agent_signature, probe.body.identity);
    assert.equal(probe.body.order_metadata.keep, 1);
  });
});

test('enforce: an INVALID TAP signature (signed for another path) is 401', async () => {
  await withEnv(ENFORCE_ALL, async () => {
    const { result, entries } = await captureLogs(() => post('/mcp', { headers: tap('/acp/checkout_sessions') }));
    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'AGENT_SIGNATURE_INVALID');
    assert.equal(result.body.reason, 'bad_signature');
    const [event] = sigEvents(entries);
    assert.equal(event.enforce_action, 'reject');
    // The access log still records the refused call.
    const access = entries.find((e) => e && e.path === '/mcp' && e.status === 401 && e.event === undefined);
    assert.ok(access, 'access log line');
    assert.equal(access.agent_sig_enforce, 'reject');
  });
});

test('enforce: an EXPIRED TAP signature is 401', async () => {
  await withEnv(ENFORCE_ALL, async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await post('/mcp', { headers: tap('/mcp', { created: now - 1000, expires: now - 700 }) });
    assert.equal(res.status, 401);
    assert.equal(res.body.reason, 'expired');
  });
});

test('enforce: a REPLAYED TAP signature is 401 the second time', async () => {
  await withEnv(ENFORCE_ALL, async () => {
    const headers = tap('/mcp');
    const first = await post('/mcp', { headers });
    assert.notEqual(first.status, 401);
    const replay = await post('/mcp', { headers });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.reason, 'nonce_replay');
  });
});

test('enforce: an UNKNOWN-KEY TAP signature is 401', async () => {
  await withEnv(ENFORCE_ALL, async () => {
    const headers = signTapRequest({ url: `https://${HOST}/mcp`, privateKey: stranger.privateKey, keyid: 'not-a-visa-key' }).headers;
    const res = await post('/mcp', { headers });
    assert.equal(res.status, 401);
    assert.equal(res.body.reason, 'unknown_key');
  });
});

// ---- unsigned and scope ---------------------------------------------------------------------------------

test('enforce: unsigned requests pass unchanged and log nothing', async () => {
  const before = await post('/mcp');
  await withEnv(ENFORCE_ALL, async () => {
    const { result, entries } = await captureLogs(() => post('/mcp'));
    assert.equal(result.status, before.status);
    assert.deepEqual(result.body, before.body);
    assert.equal(sigEvents(entries).length, 0);
  });
});

test('enforce with no route groups and no opt-ins: a forged TAP signature passes (observe-equivalent)', async () => {
  await withEnv({ AGENT_SIGNATURE_VERIFY_MODE: 'enforce' }, async () => {
    const unsigned = await post('/mcp');
    const { result, entries } = await captureLogs(() => post('/mcp', { headers: tap('/elsewhere') }));
    assert.equal(result.status, unsigned.status);
    const [event] = sigEvents(entries);
    assert.equal(event.enforce_reason, 'scope_not_enforced');
  });
});

test('enforce, checkout group only: forged TAP on a checkout call is 401 on every dialect; on tools/list it passes', async () => {
  await withEnv({ AGENT_SIGNATURE_VERIFY_MODE: 'enforce', AGENT_SIGNATURE_ENFORCE_ROUTE_GROUPS: 'checkout' }, async () => {
    const forged = () => tap('/somewhere-else');
    const list = await post('/mcp', { headers: forged() });
    assert.notEqual(list.status, 401, 'merchant_doors not enforced');
    const mcpCheckout = await post('/mcp', { headers: forged(), body: rpcCall('create_checkout_session', { merchant_id: 'm1', items: [] }) });
    assert.equal(mcpCheckout.status, 401, 'MCP dialect checkout tool');
    const ucpCheckout = await post('/ucp/mcp', { headers: forged(), body: rpcCall('create_checkout', {}) });
    assert.equal(ucpCheckout.status, 401, 'UCP dialect checkout tool (canonical contract lookup)');
    const ucpSearch = await post('/ucp/mcp', { headers: forged(), body: rpcCall('search_catalog', { query: 'x' }) });
    assert.notEqual(ucpSearch.status, 401, 'a catalog tool is not checkout');
    const acp = await post('/acp/checkout_sessions', { headers: forged(), body: { items: [] } });
    assert.equal(acp.status, 401, 'ACP checkout_sessions');
  });
});

test('enforce, merchant opted into tap_only: its unsigned calls are 401, other merchants\' pass, verified TAP passes', async () => {
  await withEnv({ AGENT_SIGNATURE_VERIFY_MODE: 'enforce', AGENT_SIGNATURE_ENFORCE_MERCHANTS_JSON: '{"merch_tap_only":"tap_only"}' }, async () => {
    const body = (merchant) => rpcCall('get_product', { merchant_id: merchant, product_id: 'p1' });
    const baseline = await post('/mcp', { body: body('merch_other') });
    assert.notEqual(baseline.status, 401);
    const { result, entries } = await captureLogs(() => post('/mcp', { body: body('merch_tap_only') }));
    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'AGENT_SIGNATURE_REQUIRED');
    const [event] = sigEvents(entries);
    assert.equal(event.merchant_policy, 'tap_only');
    assert.equal(event.merchant_resolved, true);
    const verified = await post('/mcp', { headers: tap('/mcp'), body: body('merch_tap_only') });
    assert.equal(verified.status, baseline.status);
  });
});

// ---- observe and off are unchanged ----------------------------------------------------------------------

test('observe: even with enforce variables set, a forged TAP signature is never refused and no identity is attached', async () => {
  await withEnv({ ...ENFORCE_ALL, AGENT_SIGNATURE_VERIFY_MODE: 'observe', AGENT_SIGNATURE_ENFORCE_MERCHANTS_JSON: '{"m":"tap_only"}' }, async () => {
    const unsigned = await post('/mcp');
    const { result, entries } = await captureLogs(() => post('/mcp', { headers: tap('/elsewhere') }));
    assert.equal(result.status, unsigned.status);
    const [event] = sigEvents(entries);
    assert.equal(event.verified, false);
    for (const k of ['enforce_action', 'route_group', 'tap_claimed', 'authority']) assert.equal(k in event, false, `${k} is enforce-only`);
    assert.notEqual((await post('/mcp', { body: rpcCall('get_product', { merchant_id: 'm' }) })).status, 401, 'tap_only inert in observe');
    const probe = await post(PROBE, { headers: tap(PROBE), body: {} });
    assert.equal(probe.body.identity, null);
    assert.equal(probe.body.ctx_agent_signature, null);
    assert.equal('agent_signature' in probe.body.order_metadata, false, 'a caller-supplied agent_signature is dropped');
  });
});

test('off: enforce variables are inert, nothing is logged', async () => {
  await withEnv({ AGENT_SIGNATURE_ENFORCE_ROUTE_GROUPS: 'merchant_doors,checkout', AGENT_SIGNATURE_ENFORCE_MERCHANTS_JSON: '{"m":"tap_only"}' }, async () => {
    const unsigned = await post('/mcp');
    const { result, entries } = await captureLogs(() => post('/mcp', { headers: tap('/elsewhere') }));
    assert.equal(result.status, unsigned.status);
    assert.equal(sigEvents(entries).length, 0);
    assert.notEqual((await post('/mcp', { body: rpcCall('get_product', { merchant_id: 'm' }) })).status, 401);
  });
});

test('delegate_payment is never inspected in enforce either', async () => {
  await withEnv({ ...ENFORCE_ALL, AGENT_SIGNATURE_ENFORCE_MERCHANTS_JSON: '{"m":"tap_only"}' }, async () => {
    const { result, entries } = await captureLogs(() => post('/acp/agentic_commerce/delegate_payment', { headers: tap('/elsewhere') }));
    assert.equal(result.status, 501);
    assert.equal(sigEvents(entries).length, 0);
  });
});

test('create_order hands its invoke context to the order metadata builder', () => {
  const src = require('fs').readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(src, /case 'create_order': \{[\s\S]{0,200}applyStrictHostedOrderMetadata\(isPlainObject\(payload\?\.order\) \? payload\.order : \{\}, invokeContext\)/);
});
