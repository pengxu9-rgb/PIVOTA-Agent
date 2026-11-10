'use strict';

// Shared by the two GET_OFFERS_EMPTY_REASON door suites (flag on, flag off): the env a commerce door needs,
// a caller token, and a tools/call helper whose backend is the wire (nock), answering with offers.resolve
// bodies RECORDED from the backend's own handler (tests/fixtures/offers_resolve_empty_answers.json: a minted
// catalog row and a mirror row on Postgres, placeholder names; ids, links and timings scrubbed).

const assert = require('node:assert/strict');
const supertest = require('supertest');
const nock = require('nock');

const ISS = 'https://as.pivota.test';
const RESOURCE = 'https://agent.test.example/mcp';
const BACKEND = 'http://backend.offers-empty-reason.test';

function setDoorEnv() {
  process.env.NODE_ENV = 'test';
  process.env.AURORA_BFF_USE_MOCK = 'true';
  process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
  process.env.AGENT_CHECKOUT_STRICT = '1';
  process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT = '1';
  process.env.AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED = '1';
  process.env.PIVOTA_API_KEY = 'gateway-service-key';
  process.env.PIVOTA_API_BASE = BACKEND;
  process.env.CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
  process.env.PAYMENT_WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
  process.env.MCP_OAUTH_ENABLED = '1';
  process.env.MCP_OAUTH_RESOURCE = RESOURCE;
  process.env.MCP_OAUTH_AUTHORIZATION_SERVERS = ISS;
  delete process.env.PUBLIC_READ_MCP_ENABLED;
  delete process.env.MCP_OAUTH_ISSUERS_JSON;
  for (const k of ['UCP_LIVE_OFFER_READ', 'GET_OFFERS_LIVE_CART', 'GET_OFFERS_VARIANT_ID', 'PARTNER_DOOR_ONE_PRODUCT_ID']) delete process.env[k];
  // A proxy in the environment routes the upstream request around nock.
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
}

let tokenPromise = null;
function token() {
  if (!tokenPromise) {
    tokenPromise = (async () => {
      const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
      const { publicKey, privateKey } = await generateKeyPair('RS256');
      const pub = await exportJWK(publicKey);
      pub.kid = 'as-1';
      pub.alg = 'RS256';
      process.env.MCP_OAUTH_ISSUERS_JSON = JSON.stringify([{ iss: ISS, jwks: { keys: [pub] }, algs: ['RS256'] }]);
      require('../../src/commerceMcpOAuth.js').__resetVerifierCache();
      return new SignJWT({ scope: 'pivota.checkout', token_type: 'access', client_id: 'mcpc_offers_empty_reason' })
        .setProtectedHeader({ alg: 'RS256', kid: 'as-1' })
        .setIssuer(ISS).setAudience(RESOURCE).setSubject('buyer-1').setIssuedAt().setExpirationTime('10m')
        .sign(privateKey);
    })();
  }
  return tokenPromise;
}

const FIXTURE = require('../fixtures/offers_resolve_empty_answers.json');
const SIG = 'sig_400b9b8df4fb0afa1891c86607e05cf1';
const NATIVE_ARGS = { product_id: SIG, market: 'US' };
const UCP_ARGS = { meta: { 'ucp-agent': { profile: 'https://agent.example/p' } }, insights: { id: SIG, market: 'US' } };

function answerOf(res) {
  const result = res.body && res.body.result;
  assert.ok(result && !result.isError, `get_offers errored: ${JSON.stringify(res.body).slice(0, 600)}`);
  return result.structuredContent || JSON.parse(result.content[0].text);
}

/** tools/call get_offers on `door` ('/mcp' | '/ucp/mcp') with the backend answering `backendBody`. Returns the raw response. */
async function callGetOffersRaw(app, door, backendBody, args) {
  nock.cleanAll();
  nock(BACKEND)
    .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'offers.resolve')
    .reply(200, backendBody);
  const res = await supertest(app)
    .post(door)
    .set('Authorization', `Bearer ${await token()}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_offers', arguments: args || (door === '/mcp' ? NATIVE_ARGS : UCP_ARGS) } });
  nock.cleanAll();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res;
}

async function listTools(app, door) {
  const res = await supertest(app)
    .post(door)
    .set('Authorization', `Bearer ${await token()}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.result.tools;
}

module.exports = { setDoorEnv, token, FIXTURE, SIG, NATIVE_ARGS, UCP_ARGS, answerOf, callGetOffersRaw, listTools };
