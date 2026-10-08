'use strict';

// agentSignatureMiddleware on the LIVE gateway app: observe mode records who signed a door request and
// changes nothing else.
//
// What only a route-level test can show: that the middleware sits in front of the doors (Express stops at
// the first matching route, so a layer registered after them would silently never run), that a signed
// request gets the SAME response as the same request unsigned, that `off` really is inert, and that the
// delegate_payment refusal route is never inspected.
//
// Conventions: env set BEFORE require('../src/server'); supertest against the exported app; logs captured
// by wrapping the shared pino instance (model: tests/acp_delegate_payment_refusal.node.test.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');
const supertest = require('supertest');

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
delete process.env.AGENT_SIGNATURE_VERIFY_MODE;
delete process.env.AGENT_SIGNATURE_TRUSTED_KEY_SOURCES_JSON;

const app = require('../src/server');
const logger = require('../src/logger');

const HOST = 'commerce.mcp.pivota.cc';
const VISA_URL = 'https://mcp.visa.com/.well-known/jwks';
const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ed25519');
const JWKS = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'visa-test-key' }] };

// ---- fetch stub: only the Visa key set exists; every call is recorded -----------------------------------
const fetchCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  fetchCalls.push(String(url));
  if (String(url) === VISA_URL) return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(JWKS) };
  return realFetch(url, init);
};
test.after(() => { globalThis.fetch = realFetch; });

// ---- log capture --------------------------------------------------------------------------------------
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
    const result = await fn();
    return { result, entries };
  } finally {
    for (const [level, impl] of Object.entries(original)) logger[level] = impl;
  }
}
const sigEvents = (entries) => entries.filter((e) => e && e.event === 'agent_signature');
const accessLines = (entries, path) => entries.filter((e) => e && e.path === path && e.status !== undefined && e.event === undefined);

let nonceCounter = 0;
function tapHeaders(path) {
  const now = Math.floor(Date.now() / 1000);
  nonceCounter += 1;
  const params = `("@authority" "@path");created=${now};expires=${now + 300};keyid="visa-test-key";alg="ed25519";nonce="door-${nonceCounter}";tag="agent-browser-auth"`;
  const base = `"@authority": ${HOST}\n"@path": ${path}\n"@signature-params": ${params}`;
  const sig = nodeCrypto.sign(null, Buffer.from(base, 'utf8'), privateKey).toString('base64');
  return { 'signature-input': `sig2=${params}`, signature: `sig2=:${sig}:` };
}

function post(path, headers = {}) {
  return supertest(app)
    .post(path)
    .set('host', HOST)
    .set(headers)
    .set('content-type', 'application/json')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
}

// ORDER MATTERS: the tests that assert "nothing was fetched" run before any signed request has warmed the
// shared Visa key cache inside the app's verifier (node:test runs a file's tests in order).

test('off (the default): nothing is verified, logged or fetched', async () => {
  assert.equal(fetchCalls.length, 0, 'runs first, before any key fetch');
  const before = fetchCalls.length;
  const { entries } = await captureLogs(() => post('/ucp/mcp', tapHeaders('/ucp/mcp')));
  assert.equal(sigEvents(entries).length, 0);
  assert.equal(fetchCalls.length, before);
});

test('observe: delegate_payment and non-door paths are never inspected', async () => {
  process.env.AGENT_SIGNATURE_VERIFY_MODE = 'observe';
  try {
    const before = fetchCalls.length;
    const refusal = await captureLogs(() => post('/acp/agentic_commerce/delegate_payment', tapHeaders('/acp/agentic_commerce/delegate_payment')));
    assert.equal(refusal.result.status, 501);
    assert.equal(sigEvents(refusal.entries).length, 0);
    const other = await captureLogs(() => supertest(app).get('/healthz').set('host', HOST).set(tapHeaders('/healthz')));
    assert.equal(sigEvents(other.entries).length, 0);
    assert.equal(fetchCalls.length, before);
  } finally {
    delete process.env.AGENT_SIGNATURE_VERIFY_MODE;
  }
});

test('observe: no spelling of the delegate_payment path is inspected (Express matches case- and slash-insensitively)', async () => {
  process.env.AGENT_SIGNATURE_VERIFY_MODE = 'observe';
  try {
    for (const p of ['/acp/agentic_commerce/delegate_payment/', '/acp/agentic_commerce/Delegate_Payment', '/ACP/agentic_commerce/delegate_payment']) {
      const { result, entries } = await captureLogs(() => post(p, tapHeaders(p)));
      assert.equal(result.status, 501, p);
      assert.equal(sigEvents(entries).length, 0, p);
    }
  } finally {
    delete process.env.AGENT_SIGNATURE_VERIFY_MODE;
  }
});

test('observe: every request-target the router sends to delegate_payment is neither inspected nor body-parsed', async () => {
  // Raw TCP: these spellings (absolute-form RFC 9112 §3.2.2, a #fragment, backslashes) are exactly what an
  // HTTP client would normalise away. Each one is routed to the refusal by Express (parseurl/url.parse).
  const net = require('net');
  process.env.AGENT_SIGNATURE_VERIFY_MODE = 'observe';
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const sendRaw = (target, body) => new Promise((resolve, reject) => {
    const sig = tapHeaders('/acp/agentic_commerce/delegate_payment');
    const sock = net.connect(server.address().port, '127.0.0.1', () => {
      sock.end([
        `POST ${target} HTTP/1.1`,
        `Host: ${HOST}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        `Signature-Input: ${sig['signature-input']}`,
        `Signature: ${sig.signature}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'));
    });
    let data = '';
    sock.on('data', (c) => { data += c; });
    sock.on('end', () => resolve(Number((/^HTTP\/1\.1 (\d{3})/.exec(data) || [])[1])));
    sock.on('error', reject);
  });
  try {
    const before = fetchCalls.length;
    for (const target of [
      `http://${HOST}/acp/agentic_commerce/delegate_payment`,
      '/acp/agentic_commerce/delegate_payment#frag',
      `http://${HOST}/acp/agentic_commerce/delegate_payment#f`,
      `http://${HOST}/acp\\agentic_commerce\\delegate_payment`,
    ]) {
      // Invalid JSON: a parser that ran would answer 400; the refusal answers 501 without reading it.
      const { result, entries } = await captureLogs(() => sendRaw(target, '{"number": "4242424242424242", '));
      assert.equal(result, 501, target);
      assert.equal(sigEvents(entries).length, 0, target);
    }
    assert.equal(fetchCalls.length, before);
  } finally {
    delete process.env.AGENT_SIGNATURE_VERIFY_MODE;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('observe: a signed /ucp/mcp request is verified and logged, and gets the same response as unsigned', async () => {
  process.env.AGENT_SIGNATURE_VERIFY_MODE = 'observe';
  try {
    const unsigned = await captureLogs(() => post('/ucp/mcp'));
    const signed = await captureLogs(() => post('/ucp/mcp', tapHeaders('/ucp/mcp')));

    assert.equal(signed.result.status, unsigned.result.status);
    assert.deepEqual(signed.result.body, unsigned.result.body);

    assert.equal(sigEvents(unsigned.entries).length, 0, 'unsigned requests produce no agent_signature line');
    const [event] = sigEvents(signed.entries);
    assert.ok(event, 'signed request produced an agent_signature line');
    assert.equal(event.verified, true, event.reason);
    assert.equal(event.agent, 'visa');
    assert.equal(event.profile, 'visa-tap');
    assert.equal(event.mode, 'observe');

    const [access] = accessLines(signed.entries, '/ucp/mcp');
    assert.ok(access, 'access log line present');
    assert.equal(access.agent_sig_verified, true);
    assert.equal(access.agent_sig_agent, 'visa');
    const [unsignedAccess] = accessLines(unsigned.entries, '/ucp/mcp');
    assert.equal('agent_sig_verified' in unsignedAccess, false);
  } finally {
    delete process.env.AGENT_SIGNATURE_VERIFY_MODE;
  }
});

test('observe: a forged signature is logged as unverified and the request still goes through unchanged', async () => {
  process.env.AGENT_SIGNATURE_VERIFY_MODE = 'observe';
  try {
    const headers = tapHeaders('/acp/checkout_sessions'); // signed for a different path
    const unsigned = await captureLogs(() => post('/mcp'));
    const forged = await captureLogs(() => post('/mcp', headers));
    assert.equal(forged.result.status, unsigned.result.status);
    const [event] = sigEvents(forged.entries);
    assert.equal(event.verified, false);
    assert.equal(event.reason, 'bad_signature');
  } finally {
    delete process.env.AGENT_SIGNATURE_VERIFY_MODE;
  }
});

test('observe: a door reached as /UCP/mcp/ is still inspected; a lone ACP HMAC Signature header is not a signature', async () => {
  process.env.AGENT_SIGNATURE_VERIFY_MODE = 'observe';
  try {
    const spelled = await captureLogs(() => post('/UCP/mcp/', tapHeaders('/UCP/mcp/')));
    const [event] = sigEvents(spelled.entries);
    assert.ok(event, 'inspected');
    assert.equal(event.verified, true, event.reason);
    const hmac = await captureLogs(() => post('/acp/checkout_sessions', { signature: 'deadbeef', timestamp: String(Math.floor(Date.now() / 1000)) }));
    assert.equal(sigEvents(hmac.entries).length, 0);
  } finally {
    delete process.env.AGENT_SIGNATURE_VERIFY_MODE;
  }
});
