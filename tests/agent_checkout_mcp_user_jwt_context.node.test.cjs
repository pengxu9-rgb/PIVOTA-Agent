const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadJose() {
  const josePath = path.join(
    __dirname,
    '..',
    'safety-kernel',
    'node_modules',
    'jose',
    'dist',
    'webapi',
    'index.js',
  );
  return import(pathToFileURL(josePath).href);
}

function mockReq(headers = {}, extra = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    path: '/mcp',
    invokeAuth: { agent_id: 'agent_mcp_test' },
    ...extra,
    header(name) {
      return normalized[String(name || '').toLowerCase()] || '';
    },
  };
}

test('strict MCP context derives user_ref/session only from a verified user JWT', async () => {
  const { SignJWT, generateKeyPair, exportJWK } = await loadJose();
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  jwk.kid = 'mcp-test-k1';

  const iss = 'https://identity.test.pivota.local';
  const aud = 'pivota-agent-mcp';
  process.env.IDENTITY_ISSUERS_JSON = JSON.stringify([
    { iss, aud, jwks: { keys: [jwk] }, algs: ['ES256'] },
  ]);
  process.env.AGENT_CHECKOUT_IDENTITY_MAX_TOKEN_AGE = '1h';

  const server = require('../src/server');
  const token = await new SignJWT({ acp_session_id: 'acp_verified_jwt_session' })
    .setProtectedHeader({ alg: 'ES256', kid: 'mcp-test-k1' })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject('buyer-123')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);

  const ctx = await server._debug.__agentCheckoutStrict.deriveStrictCommerceCtxAsync(
    mockReq({ 'X-Agent-User-JWT': `Bearer ${token}` }),
  );

  assert.match(ctx.user_ref, /^usr_/);
  assert.equal(ctx.acp_session_id, 'acp_verified_jwt_session');
  assert.equal(ctx.agent_id, 'agent_mcp_test');
  assert.equal(ctx.identity_source, 'x_agent_user_jwt');

  const invalid = await server._debug.__agentCheckoutStrict.deriveStrictCommerceCtxAsync(
    mockReq({ 'X-Agent-User-JWT': 'not-a-jwt' }),
  );
  assert.equal(invalid.user_ref, undefined);
  assert.equal(invalid.acp_session_id, undefined);
  assert.equal(invalid.agent_id, 'agent_mcp_test');

  const invalidWithBaseIdentity = await server._debug.__agentCheckoutStrict.deriveStrictCommerceCtxAsync(
    mockReq(
      { 'X-Agent-User-JWT': 'not-a-jwt' },
      { authInfo: { user_ref: 'usr_base_must_not_win', acp_session_id: 'sess_base_must_not_win' } },
    ),
  );
  assert.equal(invalidWithBaseIdentity.user_ref, undefined);
  assert.equal(invalidWithBaseIdentity.acp_session_id, undefined);
  assert.equal(invalidWithBaseIdentity.agent_id, 'agent_mcp_test');
});
