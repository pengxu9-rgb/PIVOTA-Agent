const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.PIVOTA_API_BASE = 'http://backend.issuing-assertion.test';
process.env.PIVOTA_API_KEY = 'backend_test_key';
// find_products_multi is served over loopback by this gateway's own invoke route; intercept that hop too.
process.env.SELF_INVOKE_BASE = 'http://self.issuing-assertion.test';
process.env.ISSUING_AGENT_ASSERTION_SECRET = 'issuing_test_secret';

const nock = require('nock');
const app = require('../src/server');
const {
  ISSUING_AGENT_ASSERTION_HEADER,
  issuingAgentAssertionHeaders,
  issuingSubjectFromInvokeContext,
  signIssuingAgentAssertion,
  oauthClientFromClaims,
} = require('../src/attribution/issuingAgentAssertion');

const HEADER = ISSUING_AGENT_ASSERTION_HEADER.toLowerCase();
const VERIFIED_AGENT = { auth_mode: 'api_key', agent_id: 'agent_minds', introspect_auth_source: 'cache_hit' };
const VERIFIED_OAUTH = {
  auth_mode: 'mcp_oauth',
  agent_id: null,
  oauth_issuer: 'https://auth.example.com/',
  oauth_client_id: 'claude_connector',
};

// An INDEPENDENT verifier: recomputes the MAC from the secret and the wire bytes, the way the backend
// (services/issuing_agent_assertion.py) does, instead of calling the signer back.
function verify(token, secret = 'issuing_test_secret') {
  const [version, body, mac] = String(token).split('.');
  assert.equal(version, 'v1');
  const expected = crypto.createHmac('sha256', secret).update(`${version}.${body}`).digest('base64url');
  assert.equal(mac, expected, 'MAC must verify against the shared secret');
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

async function captureUpstream(op, store, payload = { product: { product_id: 'p1', merchant_id: 'm1' } }) {
  let headers = null;
  let called = false;
  function reply() {
    called = true;
    headers = this.req.headers;
    return [200, { status: 'success', offers: [], products: [] }];
  }
  nock.cleanAll();
  nock(process.env.PIVOTA_API_BASE).post('/agent/shop/v1/invoke').reply(reply);
  nock(process.env.SELF_INVOKE_BASE).post('/agent/shop/v1/invoke').reply(reply);
  try {
    await app._debug.INVOKE_AUTH_CONTEXT.run(store, () => app._debug.invokeCommerceKernelRawUpstream(op, payload));
  } catch (_) {
    // The response mapping is not under test; only what left the process is.
  }
  nock.cleanAll();
  assert.ok(called, `upstream for ${op} must be called`);
  return headers;
}

test.after(() => nock.cleanAll());

test('offers.resolve over the MCP kernel carries the verified agent, signed, beside the gateway key', async () => {
  const headers = await captureUpstream('offers.resolve', VERIFIED_AGENT);
  assert.equal(headers['x-api-key'], 'backend_test_key', 'the upstream key stays the gateway service key');
  const payload = verify(headers[HEADER]);
  assert.deepEqual(
    { v: payload.v, kind: payload.kind, sub: payload.sub, op: payload.op },
    { v: 1, kind: 'agent', sub: 'agent_minds', op: 'offers.resolve' },
  );
  assert.ok(Math.abs(payload.ts - Math.floor(Date.now() / 1000)) <= 5);
});

test('an MCP OAuth caller is asserted as its OAuth client, never as an agent id', async () => {
  const payload = verify((await captureUpstream('offers.resolve', VERIFIED_OAUTH))[HEADER]);
  assert.equal(payload.kind, 'oauth');
  assert.equal(payload.iss, 'https://auth.example.com/');
  assert.equal(payload.cid, 'claude_connector');
  assert.equal(payload.sub, undefined);
});

test('a cached read lane never carries an identity, even for a verified agent', async () => {
  for (const op of ['find_products', 'find_products_multi']) {
    const headers = await captureUpstream(op, VERIFIED_AGENT, { search: { query: 'toner' } });
    assert.equal(headers[HEADER], undefined, `${op} is cached and shared across callers`);
  }
});

test('the header names no agent when the identity is degraded, a fallback, or a service key', async () => {
  const unbound = [
    { ...VERIFIED_AGENT, auth_degraded: true },
    { ...VERIFIED_AGENT, introspect_auth_source: 'configured_service_key' },
    { ...VERIFIED_AGENT, introspect_auth_source: 'emergency_fallback' },
    { ...VERIFIED_AGENT, introspect_auth_source: 'internal_trusted_key' },
    { ...VERIFIED_AGENT, agent_id: 'agent_service_fallback' },
    { ...VERIFIED_AGENT, agent_id: 'agent_emergency_fallback' },
    { ...VERIFIED_AGENT, agent_id: null },
    { auth_mode: 'checkout_token', agent_id: null },
    { auth_mode: 'test_bypass', agent_id: 'agent_minds' },
    { ...VERIFIED_OAUTH, oauth_client_id: null },
    { ...VERIFIED_OAUTH, oauth_issuer: null },
  ];
  for (const store of unbound) {
    const headers = await captureUpstream('offers.resolve', store);
    assert.equal(headers[HEADER], undefined, JSON.stringify(store));
  }
});

test('no secret configured means no header, never an unsigned one', () => {
  const env = { ...process.env, ISSUING_AGENT_ASSERTION_SECRET: '' };
  assert.deepEqual(issuingAgentAssertionHeaders({ op: 'offers.resolve', invokeContext: VERIFIED_AGENT, env }), {});
});

test('only allowlisted operations are signed', () => {
  for (const op of ['get_product_detail', 'create_order', 'find_products', '', undefined]) {
    assert.deepEqual(issuingAgentAssertionHeaders({ op, invokeContext: VERIFIED_AGENT }), {}, String(op));
  }
});

test('a request body cannot name the agent: the subject is read from the auth store only', () => {
  // The store is what buildExternalInvokeContext copies from req.invokeAuth. A body agent_id has no path in.
  assert.equal(issuingSubjectFromInvokeContext({ auth_mode: 'api_key', metadata: { agent_id: 'agent_x' } }), null);
});

test('the OAuth client comes from client_id, else azp, and is dropped when absent or oversized', () => {
  assert.deepEqual(oauthClientFromClaims({ iss: 'https://i/', client_id: 'c1', azp: 'c2' }),
    { oauth_issuer: 'https://i/', oauth_client_id: 'c1' });
  assert.deepEqual(oauthClientFromClaims({ iss: 'https://i/', azp: 'c2' }),
    { oauth_issuer: 'https://i/', oauth_client_id: 'c2' });
  assert.deepEqual(oauthClientFromClaims({ iss: 'https://i/', client_id: 'x'.repeat(513) }),
    { oauth_issuer: 'https://i/', oauth_client_id: null });
  assert.deepEqual(oauthClientFromClaims(null), { oauth_issuer: null, oauth_client_id: null });
});

// SHARED TEST VECTORS. The backend's verifier test (pivota-backend tests/test_issuing_agent_assertion.py)
// pins the same literal tokens; changing the wire format must change both, in the same release.
const VECTOR_SECRET = 'vector_secret';
const VECTOR_TS = 1790000000;
const AGENT_VECTOR =
  'v1.eyJ2IjoxLCJraW5kIjoiYWdlbnQiLCJzdWIiOiJhZ2VudF9taW5kcyIsIm9wIjoib2ZmZXJzLnJlc29sdmUiLCJ0cyI6MTc5MDAwMDAwMH0'
  + '.j8kMIUey8uYQ68qh9fugCF04nyjpbvo2snHUZ7v-i6k';
const OAUTH_VECTOR =
  'v1.eyJ2IjoxLCJraW5kIjoib2F1dGgiLCJpc3MiOiJodHRwczovL2F1dGguZXhhbXBsZS5jb20vIiwiY2lkIjoiY2xhdWRlX2Nvbm5lY3RvciIs'
  + 'Im9wIjoib2ZmZXJzLnJlc29sdmUiLCJ0cyI6MTc5MDAwMDAwMH0.a-Xx2wjaRCwbvgq-5wpOOiJmCff-DQgZ9GRVnkDFNSQ';

test('wire format is pinned by shared test vectors', () => {
  assert.equal(
    signIssuingAgentAssertion({
      subject: { kind: 'agent', sub: 'agent_minds' }, op: 'offers.resolve', secret: VECTOR_SECRET, nowSec: VECTOR_TS,
    }),
    AGENT_VECTOR,
  );
  assert.equal(
    signIssuingAgentAssertion({
      subject: { kind: 'oauth', iss: 'https://auth.example.com/', cid: 'claude_connector' },
      op: 'offers.resolve', secret: VECTOR_SECRET, nowSec: VECTOR_TS,
    }),
    OAUTH_VECTOR,
  );
  assert.equal(verify(AGENT_VECTOR, VECTOR_SECRET).sub, 'agent_minds');
});
