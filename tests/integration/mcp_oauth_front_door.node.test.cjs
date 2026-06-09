// End-to-end: boot the real app with the MCP OAuth front door enabled and drive POST /mcp with
// an OAuth access token and NO commerce API key — the exact path a native frontier MCP client uses.
const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

describe('MCP OAuth front door (/mcp keyless via OAuth)', () => {
  const ORIGINAL_ENV = { ...process.env };
  const RESOURCE = 'https://agent.test.local/mcp';
  const ISS = 'https://as.test.local';
  let app;
  let issuersJson;
  let signToken;

  before(async () => {
    const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const pub = await exportJWK(publicKey);
    pub.kid = 'k1';
    pub.alg = 'ES256';
    issuersJson = JSON.stringify([{ iss: ISS, jwks: { keys: [pub] }, algs: ['ES256'] }]);
    signToken = async (claims = {}, { aud = RESOURCE } = {}) =>
      new SignJWT({ ...claims })
        .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
        .setIssuer(ISS)
        .setAudience(aud)
        .setSubject(claims.sub || 'user-oauth')
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey);
  });

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      AGENT_CHECKOUT_STRICT: '1',
      AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT: '1',
      PIVOTA_API_BASE: 'http://localhost:8080',
      PIVOTA_API_KEY: 'test-token',
      CONFIRMATION_SECRET: 'strict-confirmation-secret-0123456789',
      PAYMENT_WEBHOOK_SECRET: 'strict-webhook-secret-0123456789',
      MCP_OAUTH_ENABLED: '1',
      MCP_OAUTH_RESOURCE: RESOURCE,
      MCP_OAUTH_AUTHORIZATION_SERVERS: ISS,
      MCP_OAUTH_ISSUERS_JSON: issuersJson,
    };
    delete require.cache[require.resolve('../../src/server')];
    app = require('../../src/server');
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete require.cache[require.resolve('../../src/server')];
  });

  it('serves RFC 9728 protected-resource metadata', async () => {
    const res = await request(app)
      .get('/.well-known/oauth-protected-resource')
      .set('host', 'agent.test.local');
    assert.equal(res.status, 200);
    assert.equal(res.body.resource, RESOURCE);
    assert.deepEqual(res.body.authorization_servers, [ISS]);
    assert.deepEqual(res.body.bearer_methods_supported, ['header']);
  });

  it('challenges an unauthenticated /mcp with WWW-Authenticate (no api key, no token)', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('host', 'agent.test.local')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(res.status, 401);
    assert.match(res.headers['www-authenticate'] || '', /^Bearer /);
    assert.match(res.headers['www-authenticate'] || '', /resource_metadata=/);
  });

  it('accepts a valid OAuth access token with NO api key (keyless connect)', async () => {
    const token = await signToken({ sub: 'user-oauth', acp_session_id: 'acp_oauth_1' });
    const res = await request(app)
      .post('/mcp')
      .set('host', 'agent.test.local')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(res.status, 200);
    assert.ok(res.body && (res.body.result || res.body.jsonrpc), 'expected a JSON-RPC result');
  });

  it('lists the commerce tools over the keyless OAuth channel', async () => {
    const token = await signToken({ sub: 'user-oauth', acp_session_id: 'acp_oauth_2' });
    const res = await request(app)
      .post('/mcp')
      .set('host', 'agent.test.local')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(res.status, 200);
    const tools = (res.body.result && res.body.result.tools) || [];
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('create_checkout_session'), `tools missing create_checkout_session: ${names}`);
  });

  it('rejects an access token minted for a different resource (aud)', async () => {
    const token = await signToken({ sub: 'user-oauth' }, { aud: 'https://elsewhere.example/mcp' });
    const res = await request(app)
      .post('/mcp')
      .set('host', 'agent.test.local')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(res.status, 401);
    assert.match(res.headers['www-authenticate'] || '', /error="invalid_token"/);
  });
});
