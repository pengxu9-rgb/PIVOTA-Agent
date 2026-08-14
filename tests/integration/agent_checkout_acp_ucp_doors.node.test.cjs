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

    it('serves /.well-known/ucp, advertising NO transport and therefore NO capabilities', async () => {
      const res = await request(app).get('/.well-known/ucp');
      assert.equal(res.status, 200);
      assert.ok(res.body.ucp_version, 'has ucp_version');
      // This boot lights discovery but NOT AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED, so there is no door.
      // It used to assert `capabilities.length > 0` and that checkout was among them — five promises a
      // platform had no endpoint to act on. Under the no-transport rule the list is empty (founder
      // decision 2026-08-13); the CONTRAST test below is the other half.
      assert.deepEqual(res.body.capabilities, [], 'no transport => nothing advertised');

      // THIS ASSERTION USED TO PIN THE DEFECT. It required
      //   rest.endpoint === 'https://agent.test.local/acp'
      // i.e. UCP discovery telling platforms to transact at the OpenAI-ACP door, which speaks ACP wire
      // shapes (`POST /checkout_sessions` with ACP bodies), not UCP's — so a platform following the profile
      // failed on its first call. The profile now advertises a `rest` transport only when a door that
      // genuinely speaks UCP REST is declared, and the gateway declares none.
      const rest = (res.body.services || []).find((s) => s.transport === 'rest');
      assert.equal(rest, undefined, 'must not advertise a REST transport nothing speaks');

      // ...AND NO MCP TRANSPORT EITHER, WHILE THE UCP-DIALECT DOOR IS DARK. This assertion used to read
      // `deepEqual(transports, ['mcp'])`, from when the profile pointed at `/mcp` unconditionally. `/mcp`
      // speaks Pivota's NATIVE tool names, so a platform reading the profile and calling `create_checkout`
      // there got an unknown-tool error — the same "advertised but not executable" defect as the REST entry
      // above, one transport over. This boot sets no AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED, so `/ucp/mcp` is
      // 404 and the profile must honestly carry no transport at all rather than name a door that cannot
      // serve a single UCP call. The lit case is the next test — both sides, so neither direction can rot.
      const transports = (res.body.services || []).map((s) => s.transport);
      assert.deepEqual(transports, [], 'no transport is advertised while the UCP-dialect door is dark');
      assert.equal(
        JSON.stringify(res.body.services || []).includes('/mcp'),
        false,
        'the native /mcp door must never be advertised as a UCP transport',
      );
    });

    it('advertises the UCP-dialect door as the mcp transport ONCE ITS FLAG IS LIT', async () => {
      const litApp = bootApp({
        ...STRICT_BASE,
        AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED: '1',
        AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED: '1',
        UCP_BASE_URL: 'https://agent.test.local',
      });
      const res = await request(litApp).get('/.well-known/ucp');
      assert.equal(res.status, 200);
      const transports = (res.body.services || []).map((s) => s.transport);
      assert.deepEqual(transports, ['mcp'], 'UCP transport is MCP JSON-RPC');
      const mcp = res.body.services.find((s) => s.transport === 'mcp');
      // The UCP-DIALECT endpoint, not the native one: this is the whole point of the flag.
      assert.equal(mcp.endpoint, 'https://agent.test.local/ucp/mcp');
      // ...and the door it names actually answers a UCP call, so the profile is executable, not just filled in.
      const tools = await request(litApp)
        .post('/ucp/mcp')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.equal(tools.status, 200, 'the advertised endpoint must serve the UCP dialect');
      const names = (tools.body?.result?.tools || []).map((t) => t.name);
      assert.ok(names.includes('create_checkout'), `advertised door must know the spec tool names, got ${names}`);
    });

    it('computes the active-capability intersection for a platform', async () => {
      // Needs a profile that HAS capabilities, so this one boots with the UCP door lit: the intersection
      // is the subject here, and the enclosing describe's app deliberately leaves the door dark (which now
      // means an empty capability list — see the test above).
      const litApp = bootApp({
        ...STRICT_BASE,
        AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED: '1',
        AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED: '1',
        UCP_BASE_URL: 'https://agent.test.local',
      });
      const profile = await request(litApp).get('/.well-known/ucp');
      const someCapId = profile.body.capabilities[0].id;
      const res = await request(litApp).post('/ucp/capabilities').send({ capabilities: [someCapId] });
      assert.equal(res.status, 200);
      const ids = (res.body.active_capabilities || []).map((c) => c.id);
      assert.ok(ids.includes(someCapId), 'intersection includes the shared capability');
    });
  });

  describe('UCP discovery decoupled from the checkout kill-switch', () => {
    it('serves /.well-known/ucp with AGENT_CHECKOUT_STRICT off, advertising NOTHING callable', async () => {
      const { AGENT_CHECKOUT_STRICT, ...withoutStrict } = STRICT_BASE;
      const localApp = bootApp({
        ...withoutStrict,
        AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED: '1',
        UCP_BASE_URL: 'https://agent.test.local',
      });
      delete process.env.AGENT_CHECKOUT_STRICT;
      const res = await request(localApp).get('/.well-known/ucp');

      // THE DECOUPLING STILL HOLDS, and it is what this describe block is about: the discovery door is
      // read-only and stays SERVED while the money kill-switch is dark. The profile answers 200 and still
      // identifies Pivota.
      assert.equal(res.status, 200);
      assert.ok(res.body.ucp_version, 'profile stays up while checkout is dark');
      assert.equal(res.body.provider.merchant_of_record, false);

      // WHAT CHANGED (founder decision 2026-08-13). This used to assert that the READ capabilities were
      // still advertised here. With strict off there is no transport — the UCP-dialect door needs strict
      // AND its own flag — so every one of those reads was a capability with no door behind it: the
      // "advertised but not executable" defect the transport filter itself exists to prevent, one level up.
      // A profile now advertises what a platform can CALL, so with no transport it advertises nothing.
      assert.deepEqual(res.body.services, [], 'nothing speaks for this profile while strict is dark');
      assert.deepEqual(res.body.capabilities, [], 'no transport => no capability may be advertised');

      // ...and the intersection cannot resurrect what the profile does not advertise.
      const inter = await request(localApp)
        .post('/ucp/capabilities')
        .send({ capabilities: ['dev.ucp.shopping.catalog.search', 'dev.ucp.shopping.checkout'] });
      assert.equal(inter.status, 200);
      assert.deepEqual(inter.body.active_capabilities, []);
    });

    it('CONTRAST: with strict on and the UCP door lit, the read capabilities ARE advertised', async () => {
      // The other half of the rule. Without this, `capabilities: []` above would also be satisfied by a
      // profile that had simply stopped advertising anything at all.
      const localApp = bootApp({
        ...STRICT_BASE,
        AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED: '1',
        AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED: '1',
        UCP_BASE_URL: 'https://agent.test.local',
      });
      const res = await request(localApp).get('/.well-known/ucp');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.services.map((s) => s.transport), ['mcp']);
      // Assert the RULE — a live door restores the capability list — not which ids are in it. Which
      // capabilities Pivota publishes is the subject of the capability-vocabulary work (#1981/#1984) and
      // moves independently; pinning ids here would make this test fail for reasons that are not its own.
      assert.ok(res.body.capabilities.length > 0, 'a live transport restores the capability list');
      const capIds = res.body.capabilities.map((c) => c.id);
      assert.ok(capIds.includes('dev.ucp.shopping.checkout'), 'checkout advertised while strict is on');
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

    it('a validly-signed create passes the HMAC gate under EVERY spelling Express routes to the door', async () => {
      // The signature binds `${timestamp}.${rawBody}` — the PATH is not signed — so the identical signed bytes
      // must authenticate at every spelling Express serves. They did not: `req.rawBody` was stashed by a
      // prefix test against the RAW url, so `/ACP/checkout_sessions` reached the adapter with no stash and got
      // HMAC'd as an empty body. Fail-closed (401 USER_AUTH_REQUIRED), but it made a live door unusable by
      // capitalisation — the same defect class as the /MCP surface label, on the door whose auth IS the bytes.
      const { SignJWT, generateKeyPair, exportJWK } = await import('jose');
      const { publicKey, privateKey } = await generateKeyPair('ES256');
      const pub = await exportJWK(publicKey);
      pub.kid = 'buyer-k-spelling';
      pub.alg = 'ES256';
      const localApp = bootApp({
        ...STRICT_BASE,
        AGENT_CHECKOUT_ACP_REST_ENABLED: '1',
        ACP_SIGNING_SECRET: ACP_SECRET,
        IDENTITY_ISSUERS_JSON: JSON.stringify([
          { iss: 'https://buyer.test.local', aud: BUYER_AUD, jwks: { keys: [pub] }, algs: ['ES256'] },
        ]),
      });
      const buyerJwt = await new SignJWT({ email: 'buyer-spelling@example.com', email_verified: true })
        .setProtectedHeader({ alg: 'ES256', kid: 'buyer-k-spelling' })
        .setIssuer('https://buyer.test.local')
        .setAudience(BUYER_AUD)
        .setSubject('buyer-spelling')
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey);

      const rawBody = JSON.stringify({ items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }], merchant_id: 'm1' });
      const post = (p, idem) => {
        const timestamp = String(Date.now());
        return request(localApp)
          .post(p)
          .set('content-type', 'application/json')
          .set('idempotency-key', idem)
          .set('signature', crypto.createHmac('sha256', ACP_SECRET).update(`${timestamp}.${rawBody}`).digest('hex'))
          .set('timestamp', timestamp)
          .set('x-buyer-authorization', `Bearer ${buyerJwt}`)
          .send(rawBody);
      };

      // Baseline: the canonical spelling gets past HMAC + identity and dies only on the absent backend.
      const baseline = await post('/acp/checkout_sessions', 'idem-spell-base');
      assert.equal(baseline.status, 503, `baseline: expected 503, got ${baseline.status}: ${JSON.stringify(baseline.body)}`);

      // 503 is the discriminator: a request whose bytes were never stashed cannot reach the backend at all —
      // it is refused at the HMAC gate with 401/USER_AUTH_REQUIRED, which is exactly what these returned
      // before the prefix test was normalized.
      for (const [p, idem] of [
        ['/ACP/checkout_sessions', 'idem-spell-upper'],
        ['/Acp/Checkout_Sessions', 'idem-spell-mixed'],
        ['/acp/checkout_sessions/', 'idem-spell-slash'],
      ]) {
        const res = await post(p, idem);
        assert.notEqual(res.body?.code, 'USER_AUTH_REQUIRED', `${p}: signed bytes must not be refused as unsigned`);
        assert.equal(res.status, 503, `${p}: expected the baseline's 503, got ${res.status}: ${JSON.stringify(res.body)}`);
      }

      // CONTRAST: the gate is genuinely live at those spellings — it is the STASH that was missing, not the
      // signature check. A bad signature to /ACP/... is still refused, so the equalities above are the fix
      // and not a door that stopped verifying.
      const forged = await request(localApp)
        .post('/ACP/checkout_sessions')
        .set('content-type', 'application/json')
        .set('idempotency-key', 'idem-spell-forged')
        .set('signature', 'deadbeef')
        .set('timestamp', String(Date.now()))
        .set('x-buyer-authorization', `Bearer ${buyerJwt}`)
        .send(rawBody);
      assert.equal(forged.status, 401);
      assert.equal(forged.body.code, 'USER_AUTH_REQUIRED');
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
