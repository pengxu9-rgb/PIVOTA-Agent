'use strict';

// END TO END over the real MCP door: an OAuth access token shaped like Pivota's authorization server
// mints it (iss / sub / aud / scope + RFC 9068 client_id), POST /mcp tools/call get_offers, and the
// backend request that leaves the process. Nothing between the token and the wire is stubbed:
// resolveMcpOAuthIdentity -> req.invokeAuth (oauthClientFromClaims) -> buildExternalInvokeContext ->
// INVOKE_AUTH_CONTEXT -> makeGetOffers.fetchOffers -> invokeCommerceKernelRawUpstream -> header.
// A regression that drops any link of that chain (the OAuth spread, the two context fields, or
// fetchOffers leaving the request's auth store) fails here.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const supertest = require('supertest');
const nock = require('nock');

const ORIGINAL_ENV = { ...process.env };
const ISS = 'https://as.pivota.test';
const RESOURCE = 'https://agent.test.example/mcp';
const SECRET = 'mcp_door_secret';

process.env.NODE_ENV = 'test';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.AGENT_CHECKOUT_STRICT = '1';
process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT = '1';
process.env.PIVOTA_API_KEY = 'gateway-service-key';
process.env.PIVOTA_API_BASE = 'http://backend.mcp-door.test';
process.env.CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
process.env.PAYMENT_WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
process.env.MCP_OAUTH_ENABLED = '1';
process.env.MCP_OAUTH_RESOURCE = RESOURCE;
process.env.MCP_OAUTH_AUTHORIZATION_SERVERS = ISS;
process.env.ISSUING_AGENT_ASSERTION_SECRET = SECRET;
delete process.env.PUBLIC_READ_MCP_ENABLED;
delete process.env.MCP_OAUTH_ISSUERS_JSON;

const app = require('../src/server');

test.after(() => {
  nock.cleanAll();
  process.env = { ...ORIGINAL_ENV };
});

async function tokenFor(claims) {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const pub = await exportJWK(publicKey);
  pub.kid = 'as-1';
  pub.alg = 'RS256';
  process.env.MCP_OAUTH_ISSUERS_JSON = JSON.stringify([{ iss: ISS, jwks: { keys: [pub] }, algs: ['RS256'] }]);
  require('../src/commerceMcpOAuth.js').__resetVerifierCache();
  return new SignJWT({ scope: 'pivota.checkout', token_type: 'access', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'as-1' })
    .setIssuer(ISS).setAudience(RESOURCE).setSubject('buyer-1').setIssuedAt().setExpirationTime('10m')
    .sign(privateKey);
}

async function getOffersUpstreamHeaders(token) {
  let captured = null;
  nock.cleanAll();
  nock(process.env.PIVOTA_API_BASE)
    .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'offers.resolve')
    .reply(function reply() {
      captured = this.req.headers;
      return [200, { status: 'success', offers: [] }];
    });
  const res = await supertest(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_offers', arguments: { merchant_id: 'm_1', product_id: 'p_1' } },
    });
  nock.cleanAll();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(captured, `get_offers must reach offers.resolve upstream: ${JSON.stringify(res.body).slice(0, 400)}`);
  return captured;
}

function payloadOf(token) {
  const [version, body, mac] = String(token).split('.');
  assert.equal(version, 'v1');
  assert.equal(mac, crypto.createHmac('sha256', SECRET).update(`${version}.${body}`).digest('base64url'));
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

test('an OAuth connector calling get_offers over /mcp reaches the backend with its client, signed', async () => {
  const headers = await getOffersUpstreamHeaders(await tokenFor({ client_id: 'mcpc_install_42' }));
  assert.equal(headers['x-api-key'], 'gateway-service-key', 'the upstream key stays the gateway service key');
  const payload = payloadOf(headers['x-pivota-issuing-agent']);
  assert.equal(payload.kind, 'oauth');
  assert.equal(payload.iss, ISS);
  assert.equal(payload.cid, 'mcpc_install_42');
  assert.equal(payload.op, 'offers.resolve');
});

test('a token that names no client sends no header (and still serves the call)', async () => {
  const headers = await getOffersUpstreamHeaders(await tokenFor({}));
  assert.equal(headers['x-pivota-issuing-agent'], undefined);
});
