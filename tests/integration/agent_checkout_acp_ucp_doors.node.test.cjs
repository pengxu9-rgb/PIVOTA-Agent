// End-to-end wiring test for the additive ACP REST + UCP discovery doors mounted on the live app
// (registerCommerceAcpRestRoutes / registerCommerceUcpRoutes). Proves: fail-closed 404 gating when the door
// flags are off, UCP discovery + capability intersection when on, the ACP HMAC platform-auth gate, and the
// submit_payment kill-switch on the ACP complete (charge) endpoint. All doors share the live kernel/executor.
const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

describe('Agent checkout ACP REST + UCP discovery doors', () => {
  const ORIGINAL_ENV = { ...process.env };
  const ACP_SECRET = 'acp-signing-secret-0123456789abc';
  const BUYER_AUD = 'https://agent.test.local/acp';
  let identityIssuersJson;

  const STRICT_BASE = {
    NODE_ENV: 'test',
    AGENT_CHECKOUT_STRICT: '1',
    AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT: '1',
    PIVOTA_API_BASE: 'http://localhost:8080',
    PIVOTA_API_KEY: 'test-token',
    CONFIRMATION_SECRET: 'strict-confirmation-secret-0123456789',
    PAYMENT_WEBHOOK_SECRET: 'strict-webhook-secret-0123456789',
  };

  before(async () => {
    const { generateKeyPair, exportJWK } = await import('jose');
    const { publicKey } = await generateKeyPair('ES256');
    const pub = await exportJWK(publicKey);
    pub.kid = 'buyer-k1';
    pub.alg = 'ES256';
    identityIssuersJson = JSON.stringify([
      { iss: 'https://buyer.test.local', aud: BUYER_AUD, jwks: { keys: [pub] }, algs: ['ES256'] },
    ]);
  });

  const bootApp = (env) => {
    process.env = { ...ORIGINAL_ENV, ...env };
    delete require.cache[require.resolve('../../src/server')];
    return require('../../src/server');
  };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete require.cache[require.resolve('../../src/server')];
  });

  describe('fail-closed gating (strict on, door flags off)', () => {
    let app;
    beforeEach(() => { app = bootApp(STRICT_BASE); });

    it('ACP routes return 404 when AGENT_CHECKOUT_ACP_REST_ENABLED is unset', async () => {
      const res = await request(app).post('/acp/checkout_sessions').send({ items: [{ product_id: 'p1', quantity: 1 }] });
      assert.equal(res.status, 404);
    });

    it('UCP discovery returns 404 when AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED is unset', async () => {
      const res = await request(app).get('/.well-known/ucp');
      assert.equal(res.status, 404);
    });
  });

  describe('UCP discovery (enabled)', () => {
    let app;
    beforeEach(() => {
      app = bootApp({
        ...STRICT_BASE,
        AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED: '1',
        UCP_BASE_URL: 'https://agent.test.local',
      });
    });

    it('serves /.well-known/ucp with version and capabilities, and NO mis-typed REST transport', async () => {
      const res = await request(app).get('/.well-known/ucp');
      assert.equal(res.status, 200);
      assert.ok(res.body.ucp_version, 'has ucp_version');
      assert.ok(Array.isArray(res.body.capabilities) && res.body.capabilities.length > 0, 'has capabilities');
      const capIds = res.body.capabilities.map((c) => c.id);
      // Strict ON: the money capabilities ARE advertised (their doors serve).
      assert.ok(capIds.includes('dev.ucp.shopping.checkout'), 'checkout advertised while strict is on');

      // THIS ASSERTION USED TO PIN THE DEFECT. It required
      //   rest.endpoint === 'https://agent.test.local/acp'
      // i.e. UCP discovery telling platforms to transact at the OpenAI-ACP door, which speaks ACP wire
      // shapes (`POST /checkout_sessions` with ACP bodies), not UCP's — so a platform following the profile
      // failed on its first call. The profile now advertises a `rest` transport only when a door that
      // genuinely speaks UCP REST is declared, and the gateway declares none.
      const rest = (res.body.services || []).find((s) => s.transport === 'rest');
      assert.equal(rest, undefined, 'must not advertise a REST transport nothing speaks');
      const transports = (res.body.services || []).map((s) => s.transport);
      assert.deepEqual(transports, ['mcp'], 'UCP transport is MCP JSON-RPC');
    });

    it('computes the active-capability intersection for a platform', async () => {
      const profile = await request(app).get('/.well-known/ucp');
      const someCapId = profile.body.capabilities[0].id;
      const res = await request(app).post('/ucp/capabilities').send({ capabilities: [someCapId] });
      assert.equal(res.status, 200);
      const ids = (res.body.active_capabilities || []).map((c) => c.id);
      assert.ok(ids.includes(someCapId), 'intersection includes the shared capability');
    });
  });

  describe('UCP discovery decoupled from the checkout kill-switch', () => {
    it('serves /.well-known/ucp with AGENT_CHECKOUT_STRICT off (discovery is read-only; the kill-switch governs money paths)', async () => {
      const { AGENT_CHECKOUT_STRICT, ...withoutStrict } = STRICT_BASE;
      const localApp = bootApp({
        ...withoutStrict,
        AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED: '1',
        UCP_BASE_URL: 'https://agent.test.local',
      });
      delete process.env.AGENT_CHECKOUT_STRICT;
      const res = await request(localApp).get('/.well-known/ucp');
      assert.equal(res.status, 200);
      assert.ok(res.body.ucp_version, 'profile stays up while checkout is dark');
      // ...but it must not advertise capabilities whose doors are hard-404 while the switch is dark.
      const capIds = res.body.capabilities.map((c) => c.id);
      assert.ok(!capIds.includes('dev.ucp.shopping.checkout'), 'checkout withheld while checkout is dark');
      assert.ok(!capIds.includes('dev.ucp.shopping.ap2_mandate'), 'ap2 mandate withheld while checkout is dark');
      assert.ok(capIds.includes('dev.ucp.shopping.discovery'), 'read capabilities still advertised');
    });
  });

  describe('ACP REST (enabled)', () => {
    let app;
    beforeEach(() => {
      app = bootApp({
        ...STRICT_BASE,
        AGENT_CHECKOUT_ACP_REST_ENABLED: '1',
        ACP_SIGNING_SECRET: ACP_SECRET,
        IDENTITY_ISSUERS_JSON: identityIssuersJson,
      });
    });

    it('rejects an unsigned create with 401 (HMAC platform auth required)', async () => {
      const res = await request(app)
        .post('/acp/checkout_sessions')
        .set('idempotency-key', 'idem-1')
        .send({ items: [{ product_id: 'p1', quantity: 1 }] });
      assert.equal(res.status, 401);
      assert.equal(res.body.code, 'USER_AUTH_REQUIRED');
    });

    it('blocks the complete (charge) endpoint with 405 while submit_payment is disabled', async () => {
      // The kill-switch fires before signature checking, so an unsigned request still proves the gate.
      const res = await request(app)
        .post('/acp/checkout_sessions/sess_x/complete')
        .set('idempotency-key', 'idem-2')
        .send({ payment_data: { token: 'tok' } });
      assert.equal(res.status, 405);
      assert.equal(res.body.code, 'OPERATION_NOT_ALLOWED');
    });

    it('accepts a validly-signed create past every auth gate (reaches the backend → 503, no backend in test)', async () => {
      const { SignJWT } = await import('jose');
      // A signed buyer credential the configured identity verifier will accept: rebuild the app with an issuer
      // whose jwks is the public half of the key we sign the buyer JWT with.
      const privForBuyer = await (async () => {
        const { generateKeyPair, exportJWK } = await import('jose');
        const { publicKey, privateKey } = await generateKeyPair('ES256');
        const pub = await exportJWK(publicKey);
        pub.kid = 'buyer-k2';
        pub.alg = 'ES256';
        return { privateKey, pub };
      })();
      const localApp = bootApp({
        ...STRICT_BASE,
        AGENT_CHECKOUT_ACP_REST_ENABLED: '1',
        ACP_SIGNING_SECRET: ACP_SECRET,
        IDENTITY_ISSUERS_JSON: JSON.stringify([
          { iss: 'https://buyer.test.local', aud: BUYER_AUD, jwks: { keys: [privForBuyer.pub] }, algs: ['ES256'] },
        ]),
      });
      // `email` is an ATTESTED claim: it satisfies the door's buyer-email intake (PR-E / P1) without the
      // request body asserting an identity, which is the precedence the ACP door is built around. It does
      // NOT participate in user_ref derivation (still iss|sub).
      const buyerJwt = await new SignJWT({ email: 'buyer-123@example.com', email_verified: true })
        .setProtectedHeader({ alg: 'ES256', kid: 'buyer-k2' })
        .setIssuer('https://buyer.test.local')
        .setAudience(BUYER_AUD)
        .setSubject('buyer-123')
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privForBuyer.privateKey);

      // A REAL variant_id: the door refuses an item whose variant_id the shared quote-body builder would
      // otherwise synthesise from its product_id.
      const rawBody = JSON.stringify({ items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }], merchant_id: 'm1' });
      const timestamp = String(Date.now());
      const signature = crypto.createHmac('sha256', ACP_SECRET).update(`${timestamp}.${rawBody}`).digest('hex');

      const res = await request(localApp)
        .post('/acp/checkout_sessions')
        .set('content-type', 'application/json')
        .set('idempotency-key', 'idem-3')
        .set('signature', signature)
        .set('timestamp', timestamp)
        .set('x-buyer-authorization', `Bearer ${buyerJwt}`)
        .send(rawBody);

      // Past HMAC + buyer identity + quote mapping; the only thing missing is a reachable backend → 503.
      assert.equal(res.status, 503, `expected 503 (no backend), got ${res.status}: ${JSON.stringify(res.body)}`);

      // NEGATIVE CONTROL (review F5): 503 alone does not prove the ATTESTED email did the work — the
      // request would reach the backend either way. The same request with a buyer credential carrying NO
      // email claim must be refused at intake, so the only difference between 400 and 503 here is the
      // attested claim itself.
      const noEmailJwt = await new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: 'buyer-k2' })
        .setIssuer('https://buyer.test.local')
        .setAudience(BUYER_AUD)
        .setSubject('buyer-123')
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privForBuyer.privateKey);
      const ts2 = String(Date.now());
      const sig2 = crypto.createHmac('sha256', ACP_SECRET).update(`${ts2}.${rawBody}`).digest('hex');
      const noEmailRes = await request(localApp)
        .post('/acp/checkout_sessions')
        .set('content-type', 'application/json')
        .set('idempotency-key', 'idem-3-noemail')
        .set('signature', sig2)
        .set('timestamp', ts2)
        .set('x-buyer-authorization', `Bearer ${noEmailJwt}`)
        .send(rawBody);
      assert.equal(noEmailRes.status, 400, 'a credential with no email claim must be refused at intake');
      assert.equal(noEmailRes.body?.detail?.reason, 'acp_buyer_email_required');
      // And the refusal names FIELDS, never a value.
      assert.ok(!JSON.stringify(noEmailRes.body).includes('@'), 'refusal body must not echo any address');
    });

    it('an item with NO variant_id is resolved through the LIVE executor read, and fails CLOSED when that read cannot answer', async () => {
      // The door resolves an item's default variant through the canonical `get_product` read on the SAME
      // shared executor src/server.js wires for /mcp — no separate transport is threaded for it. That read
      // is unreachable in this test (no backend), which is precisely the interesting case: the request must
      // be REFUSED at intake, not priced against a variant_id forged from the product_id.
      //
      // The discriminator is the status. A forged id would have travelled on to `preview_quote` and produced
      // the 503 the test above asserts for a fully-specified item; a 400 here can only come from the door.
      const { SignJWT, generateKeyPair, exportJWK } = await import('jose');
      const { publicKey, privateKey } = await generateKeyPair('ES256');
      const pub = await exportJWK(publicKey);
      pub.kid = 'buyer-k3';
      pub.alg = 'ES256';
      const localApp = bootApp({
        ...STRICT_BASE,
        AGENT_CHECKOUT_ACP_REST_ENABLED: '1',
        ACP_SIGNING_SECRET: ACP_SECRET,
        IDENTITY_ISSUERS_JSON: JSON.stringify([
          { iss: 'https://buyer.test.local', aud: BUYER_AUD, jwks: { keys: [pub] }, algs: ['ES256'] },
        ]),
      });
      const buyerJwt = await new SignJWT({ email: 'buyer-124@example.com', email_verified: true })
        .setProtectedHeader({ alg: 'ES256', kid: 'buyer-k3' })
        .setIssuer('https://buyer.test.local')
        .setAudience(BUYER_AUD)
        .setSubject('buyer-124')
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey);

      const rawBody = JSON.stringify({ items: [{ product_id: 'p1', quantity: 1 }], merchant_id: 'm1' });
      const timestamp = String(Date.now());
      const signature = crypto.createHmac('sha256', ACP_SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
      const res = await request(localApp)
        .post('/acp/checkout_sessions')
        .set('content-type', 'application/json')
        .set('idempotency-key', 'idem-4-novariant')
        .set('signature', signature)
        .set('timestamp', timestamp)
        .set('x-buyer-authorization', `Bearer ${buyerJwt}`)
        .send(rawBody);

      assert.equal(res.status, 400, `expected an intake refusal, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body?.code, 'QUOTE_REQUIRED');
      assert.equal(res.body?.detail?.reason, 'acp_item_identity_required');
      assert.ok(
        ['resolution_unavailable', 'no_variants'].includes(res.body?.detail?.variant_resolution),
        `an unanswerable read must refuse, got ${JSON.stringify(res.body?.detail)}`,
      );
      assert.deepEqual(res.body?.detail?.required_item_fields, ['product_id', 'variant_id']);
    });
  });
});
