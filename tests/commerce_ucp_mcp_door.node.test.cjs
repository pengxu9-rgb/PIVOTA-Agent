'use strict';

// The UCP-DIALECT commerce door (POST /ucp/mcp) — the mount, its gates, and the money kill-switches.
//
// WHY THIS FILE EXISTS. Mounting a charge-capable door is the step where a guard goes missing quietly. The
// one this nearly lost: `resolveBlockedCommerceMcpOperation` compared the WIRE tool name against
// 'complete_checkout_session'. That is the MCP door's spelling of the charge; the UCP door calls the same
// canonical operation 'complete_checkout'. Mounting against a name-keyed switch would have left
// AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=0 holding /mcp shut while /ucp/mcp charged freely. The first
// suite below asserts the crossing directly, including the CONTRAST that shows the old keying missed it.
//
// The route suite then drives the real Express app: a dark door must 404, a lit door must publish the UCP
// spec names WITH the UCP argument schemas, and the profile must point at the door that can actually serve.

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');

const ORIGINAL_ENV = { ...process.env };

process.env.NODE_ENV = 'test'; // per-request invoke-auth bypass (no introspection config set)
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.AGENT_CHECKOUT_STRICT = '1';
process.env.AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT = '1';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.CONFIRMATION_SECRET = 'strict-confirmation-secret-0123456789';
process.env.PAYMENT_WEBHOOK_SECRET = 'strict-webhook-secret-0123456789';
process.env.UCP_BASE_URL = 'https://shop.pivota.cc';
// Keep /mcp on the commerce lane: the public tier must not capture these requests by host.
delete process.env.PUBLIC_READ_MCP_ENABLED;

const app = require('../src/server');
const {
  resolveBlockedCommerceMcpOperation,
  resolveBlockedUcpMcpOperation,
  blockedCommerceOperationForCanonicalOp,
  buildExternalInvokeContext,
  maybeApplyStrictMcpHostedPaymentDefaults,
  serveCommerceMcpJsonRpc,
} = require('../src/server')._debug;

test.after(() => { process.env = { ...ORIGINAL_ENV }; });

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const call = (name, args) => rpc('tools/call', { name, arguments: args || {} }, 1);

function withEnv(vars, fn) {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  // try/catch on the SYNC path too: a throwing synchronous callback (i.e. a failing assertion) previously
  // skipped `restore`, leaking AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED into every later test and
  // turning one real failure into a cascade that hides its own cause.
  let out;
  try {
    out = fn();
  } catch (err) {
    restore();
    throw err;
  }
  return out && typeof out.then === 'function' ? out.finally(restore) : (restore(), out);
}

const DOOR_DARK = { AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED: undefined };
const DOOR_LIT = { AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED: '1' };
const CHARGE_OFF = { AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED: undefined };
const CHARGE_ON = { AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED: '1' };

// ---- 1. the kill-switch crosses the dialect ----------------------------------------------------------------

test('the canonical contract keeps mcp names == operation ids (what the MCP switch relies on)', async () => {
  const { CANONICAL_OPERATIONS } = await import('../safety-kernel/src/protocol/canonicalContract.js');
  const drifted = CANONICAL_OPERATIONS.filter((op) => op.mcp !== op.id).map((op) => `${op.id}!=${op.mcp}`);
  // resolveBlockedCommerceMcpOperation looks the wire name up as a canonical op id directly. If a future
  // operation ever spells `mcp` differently from `id`, that lookup silently stops matching and the money
  // kill-switch goes dark on /mcp — so the assumption is asserted, not commented.
  assert.deepEqual(drifted, [], 'an op whose mcp name differs from its id would dark the /mcp kill-switch');
});

// AWAITED, not fire-and-forget. This test used to be a SYNCHRONOUS callback that dropped the promise
// (`withEnv(..., () => { ... return blocked.then(assertions) })` with no return/await on the outer callback),
// so node:test scored it before a single assertion inside `.then` had run. Measured: with `dialect`/`tool`
// deleted from resolveBlockedUcpMcpOperation — properties ONLY this test asserts — all 16 tests reported ✔,
// and the file failed only with a bare, diagnostic-free rejection naming no test. The guard on the charge
// kill-switch for this whole door was therefore unattributed. Every promise here is awaited now.
test('submit_payment OFF blocks the UCP charge tool under ITS OWN name', async () => {
  await withEnv(CHARGE_OFF, async () => {
    const b = await resolveBlockedUcpMcpOperation(call('complete_checkout'));
    assert.ok(b, 'the UCP charge must be blocked while submit_payment is disabled');
    // Audited under the CANONICAL id, so one audit query covers both doors...
    assert.equal(b.operation, 'complete_checkout_session');
    assert.equal(b.reason, 'strict_submit_payment_disabled');
    // ...while the dialect and the wire name stay distinguishable.
    assert.equal(b.dialect, 'ucp');
    assert.equal(b.tool, 'complete_checkout');
  });
});

test('CONTRAST: the name-keyed MCP switch does NOT see the UCP charge name', () => {
  withEnv(CHARGE_OFF, () => {
    // This is the defect the canonical keying exists to prevent, stated as an assertion. If someone reverts
    // resolveBlockedUcpMcpOperation to compare wire names, it collapses onto this null and the test above
    // fails. Both halves are needed: this one alone would pass against a door with no switch at all.
    assert.equal(resolveBlockedCommerceMcpOperation(call('complete_checkout')), null);
    // …and the MCP door's own name is still caught, so nothing regressed there.
    const nativeBlocked = resolveBlockedCommerceMcpOperation(call('complete_checkout_session'));
    assert.equal(nativeBlocked.reason, 'strict_submit_payment_disabled');
  });
});

test('submit_payment ON lets the UCP charge through to the adapter', async () => {
  await withEnv(CHARGE_ON, async () => {
    assert.equal(await resolveBlockedUcpMcpOperation(call('complete_checkout')), null);
  });
});

test('a non-charging UCP tool is never blocked by the charge switch', async () => {
  await withEnv(CHARGE_OFF, async () => {
    for (const tool of ['create_checkout', 'update_checkout', 'get_checkout', 'get_product']) {
      assert.equal(await resolveBlockedUcpMcpOperation(call(tool)), null, `${tool} must not be blocked`);
    }
  });
});

test('a tool that is not on the UCP dialect has no switch to trip there', async () => {
  await withEnv({ ...CHARGE_OFF, AGENT_CHECKOUT_HOSTED_LINK_ENABLED: undefined }, async () => {
    // create_payment_link IS gated on the MCP door...
    assert.equal(resolveBlockedCommerceMcpOperation(call('create_payment_link')).reason, 'hosted_link_disabled');
    // ...and is simply absent from the UCP dialect (no evidenced spec name), so the UCP door answers it
    // UNKNOWN_TOOL rather than pretending to gate an operation it does not expose.
    assert.equal(await resolveBlockedUcpMcpOperation(call('create_payment_link')), null);
    assert.equal(await resolveBlockedUcpMcpOperation(call('not_a_ucp_tool')), null);
    assert.equal(await resolveBlockedUcpMcpOperation(rpc('tools/list')), null);
    assert.equal(await resolveBlockedUcpMcpOperation({}), null);
  });
});

test('the rule itself is keyed on the canonical operation, for every dialect', () => {
  withEnv(CHARGE_OFF, () => {
    assert.equal(blockedCommerceOperationForCanonicalOp('complete_checkout_session').reason, 'strict_submit_payment_disabled');
    assert.equal(blockedCommerceOperationForCanonicalOp('create_checkout_session'), null);
    // The WIRE name is not an operation id and must never match the rule directly.
    assert.equal(blockedCommerceOperationForCanonicalOp('complete_checkout'), null);
  });
});

// ---- 1b. the UCP door is the SAME money surface, not a lookalike -------------------------------------------

test('the UCP door reports surface `mcp`, so its charges keep the hosted-payment defaults', () => {
  const header = () => undefined;
  const ucp = buildExternalInvokeContext({ path: '/ucp/mcp', header });
  const mcp = buildExternalInvokeContext({ path: '/mcp', header });
  // maybeApplyStrictMcpHostedPaymentDefaults returns the payment UNCHANGED unless surface === 'mcp'. A UCP
  // door reporting anything else would complete charges with no return_url and no payment_method_hint —
  // a money-path fork created by one missing string, invisible until a buyer lands nowhere after paying.
  assert.equal(ucp.surface, 'mcp');
  assert.equal(mcp.surface, 'mcp', 'the existing door must be unchanged');
  // …and it is the PATH that qualifies, not a blanket default: a non-MCP lane still reports no surface.
  assert.equal(buildExternalInvokeContext({ path: '/agent/shop/v1/invoke', header }).surface, null);
  assert.equal(ucp.path, '/ucp/mcp');
});

// ---- 1c. …and it says so for every spelling Express actually SERVES -----------------------------------------
//
// Express routes case-insensitively and ignores trailing slashes (caseSensitive/strict default off), so all
// four spellings below reach the door and get answered. `req.path` reports the caller's spelling, so an
// exact-match lookup against COMMERCE_MCP_JSON_RPC_PATHS misses them — and the money door answers with
// `surface: null`. This was pre-existing on /mcp and inherited by /ucp/mcp on mount.

const PATH_VARIANTS = ['/ucp/mcp/', '/UCP/MCP', '/Ucp/Mcp/', '/mcp/', '/MCP'];

test('Express really does serve the path variants (so the surface question is live, not theoretical)', async () => {
  await withEnv(DOOR_LIT, async () => {
    // EVERY variant, not a sample: /mcp's spellings are the older half of this defect, and leaving them to
    // the comment above would rest the whole /mcp claim on prose. Both doors, driven the same way.
    for (const p of PATH_VARIANTS) {
      const resp = await supertest(app).post(p).send(rpc('tools/list', undefined, 11)).expect(200);
      assert.ok(
        Array.isArray(resp.body.result.tools),
        `${p} must be served — if this ever 404s, its entry in PATH_VARIANTS stops meaning anything`,
      );
    }
  });
});

test('a DOUBLED trailing slash is normalized by the helper but NOT routed — so it never builds a context', async () => {
  // The one place the helper is looser than the router: `\/+$` strips `//`, but Express's `/^\/mcp\/?$/i`
  // does not match `/mcp//`. Harmless only because a 404'd path never reaches buildExternalInvokeContext —
  // which is a property of the ROUTER, not of this helper, so it is pinned here rather than assumed. If a
  // future route ever serves `/mcp//`, this test fails and says which half to fix.
  const header = () => undefined;
  for (const p of ['/mcp//', '/ucp/mcp//']) {
    assert.equal(buildExternalInvokeContext({ path: p, header }).surface, 'mcp', `${p}: helper normalizes it`);
    await withEnv(DOOR_LIT, async () => {
      await supertest(app).post(p).send(rpc('tools/list', undefined, 12)).expect(404);
    });
  }
});

test('every served spelling reports surface `mcp`, so no variant loses the hosted-payment defaults', () => {
  const header = () => undefined;
  for (const p of PATH_VARIANTS) {
    assert.equal(buildExternalInvokeContext({ path: p, header }).surface, 'mcp', `${p} must be the money surface`);
  }
  // Normalizing must not widen the set: a neighbour that merely SHARES a prefix is still not this surface.
  for (const p of ['/ucp/mcp-preview', '/mcp/tools', '/ucp', '/agent/shop/v1/invoke', '', null]) {
    assert.equal(buildExternalInvokeContext({ path: p, header }).surface, null, `${p} must not be the money surface`);
  }
});

test('the VERDICT: a charge posted to /ucp/mcp/ gets the same hosted-payment defaults as one to /ucp/mcp', () => {
  // Asserted through the real READER, not through ctx.surface: a test that only read the flag would still
  // pass if maybeApplyStrictMcpHostedPaymentDefaults stopped honouring it, and the flag is not the money —
  // return_url is. Without it the buyer pays at the PSP and lands nowhere.
  withEnv({ AGENT_CHECKOUT_MCP_PAYMENT_RETURN_URL: 'https://shop.pivota.cc/order/success' }, () => {
    const header = () => undefined;
    const payment = { order_id: 'ord_1' };
    const canonical = maybeApplyStrictMcpHostedPaymentDefaults(
      payment,
      buildExternalInvokeContext({ path: '/ucp/mcp', header }),
    );
    assert.ok(canonical.return_url, 'baseline: the canonical spelling must get a return_url');
    for (const p of PATH_VARIANTS) {
      const applied = maybeApplyStrictMcpHostedPaymentDefaults(
        payment,
        buildExternalInvokeContext({ path: p, header }),
      );
      assert.equal(applied.return_url, canonical.return_url, `${p} must get the same return_url`);
      assert.equal(applied.payment_method_hint, canonical.payment_method_hint, `${p} must get the same hint`);
    }
    // CONTRAST: the defaults are genuinely surface-gated, so the equalities above are the fix and not a
    // function that fills these fields in for everyone.
    assert.equal(
      maybeApplyStrictMcpHostedPaymentDefaults(payment, buildExternalInvokeContext({ path: '/ucp', header })).return_url,
      undefined,
    );
  });
});

// ---- 1d. a rejecting kill-switch resolver must not take the gateway down -----------------------------------

test('a REJECTING blocked-operation resolver answers 503 instead of crashing the process', async () => {
  // The UCP door's resolver imports the canonical contract, so it can reject where /mcp's synchronous
  // lookup cannot: a broken or partial deploy, on the first UCP tools/call after boot. Express 4 does not
  // catch a rejected handler promise and this process installs no `unhandledRejection` handler, so an
  // unguarded rejection here kills the WHOLE gateway — every lane, not just this request.
  const sent = [];
  const res = {
    headersSent: false,
    setHeader() {},
    status(code) { sent.push({ code }); return { json: (body) => { sent[sent.length - 1].body = body; return res; }, end: () => res }; },
  };
  const req = { method: 'POST', path: '/ucp/mcp', headers: {}, header: () => undefined, body: rpc('tools/call', { name: 'complete_checkout', arguments: {} }) };

  let adapterCalls = 0;
  // Must RESOLVE. An assertion on the status alone would also pass on a rejected promise in some runners,
  // so the await itself is half the test.
  await serveCommerceMcpJsonRpc(req, res, {
    handlerEnteredAtMs: Date.now(),
    getAdapter: async () => { adapterCalls += 1; return { handleJsonRpc: async () => ({ status: 200, body: {} }) }; },
    resolveBlockedOperation: async () => { throw new Error('canonical contract import failed'); },
    failureLabel: 'test dialect route failed',
  });

  assert.deepEqual(sent.map((s) => s.code), [503]);
  assert.deepEqual(sent[0].body, { error: 'mcp_unavailable' });
  // Fail CLOSED: no kill-switch was evaluated, so the adapter must never have been reached.
  assert.equal(adapterCalls, 0, 'a request whose kill-switch could not be resolved must not reach the adapter');
});

// ---- 2. the mount and its gates ----------------------------------------------------------------------------

test('POST /ucp/mcp is 404 while its own flag is dark — and /mcp is unaffected', async () => {
  await withEnv(DOOR_DARK, async () => {
    await supertest(app).post('/ucp/mcp').send(rpc('tools/list')).expect(404);
    // CONTRAST: the same request on the MCP door still serves, so the 404 above is this door's flag and
    // not a broken app or a missing route.
    const mcp = await supertest(app).post('/mcp').send(rpc('tools/list', undefined, 2)).expect(200);
    assert.ok(Array.isArray(mcp.body.result.tools));
  });
});

test('POST /ucp/mcp is 404 when the master checkout kill-switch is dark, even with its own flag lit', async () => {
  await withEnv({ ...DOOR_LIT, AGENT_CHECKOUT_STRICT: undefined }, async () => {
    await supertest(app).post('/ucp/mcp').send(rpc('tools/list')).expect(404);
  });
});

test('a lit door publishes the UCP SPEC names with the UCP ARGUMENT schemas', async () => {
  await withEnv(DOOR_LIT, async () => {
    const resp = await supertest(app).post('/ucp/mcp').send(rpc('tools/list', undefined, 3)).expect(200);
    const tools = resp.body.result.tools;
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['complete_checkout', 'create_checkout', 'get_checkout', 'get_product', 'update_checkout'],
    );

    // The whole point of step 3 reaching the wire: the published schema is UCP's, not Pivota's native one.
    const create = tools.find((t) => t.name === 'create_checkout');
    assert.deepEqual(create.inputSchema.required, ['meta', 'checkout']);
    assert.equal(create.inputSchema.properties.idempotency_key, undefined, 'the native schema must be gone');
    assert.equal(create.inputSchema.properties.quote, undefined);
    // …down to the nested line-item shape a platform actually sends.
    const lineItem = create.inputSchema.properties.checkout.properties.line_items.items;
    assert.deepEqual(lineItem.required, ['item', 'quantity']);
    assert.deepEqual(lineItem.properties.item.required, ['id']);
    // update_checkout's id is TOP-LEVEL, not a member of `checkout`.
    const update = tools.find((t) => t.name === 'update_checkout');
    assert.ok(update.inputSchema.required.includes('id'));
    assert.equal(update.inputSchema.properties.checkout.properties.id, undefined);
  });
});

test('a lit door refuses Pivota-NATIVE tool names (the dialect is not additive)', async () => {
  await withEnv({ ...DOOR_LIT, ...CHARGE_ON }, async () => {
    const resp = await supertest(app)
      .post('/ucp/mcp')
      .send(call('create_checkout_session', { idempotency_key: 'k0123456789', quote: {} }))
      .expect(200);
    const text = JSON.stringify(resp.body);
    assert.match(text, /UNKNOWN_TOOL|Unknown Pivota commerce tool/);
  });
});

test('the charge kill-switch fires on the LIT door, over the wire, under the UCP name', async () => {
  await withEnv({ ...DOOR_LIT, ...CHARGE_OFF }, async () => {
    // A body valid against the PUBLISHED complete_checkout schema ({ meta, id, checkout: { payment } }, with
    // the payment envelope this door advertises), so the ONLY possible reason for the refusal below is the
    // kill-switch — not an argument-shape rejection that would let this pass for the wrong reason.
    // The envelope is `{ method, token }`, NOT the merchant's `instruments` shape: Pivota cannot charge a UCP
    // payment-handler instrument and now refuses one at the door, so a body carrying instruments would be
    // refused on shape and this test would assert the kill-switch while proving nothing about it.
    const resp = await supertest(app)
      .post('/ucp/mcp')
      .send(call('complete_checkout', {
        meta: { 'ucp-agent': { profile: 'https://agent.example/p' }, 'idempotency-key': 'k0123456789' },
        id: 'gid://shopify/Checkout/abc123',
        checkout: { payment: { method: 'ucp_handler', token: 'signed.grant.jwt' } },
      }))
      .expect(200);
    const text = JSON.stringify(resp.body);
    assert.match(text, /OPERATION_NOT_ALLOWED/);
    assert.match(text, /submit_payment is disabled/);
  });
});

// ---- 3. the profile points at a door that can actually serve ------------------------------------------------

test('the UCP profile advertises the UCP-DIALECT endpoint when the door is lit', async () => {
  await withEnv({ ...DOOR_LIT, AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED: '1' }, async () => {
    const resp = await supertest(app).get('/.well-known/ucp').expect(200);
    const mcp = resp.body.services.find((s) => s.transport === 'mcp');
    assert.ok(mcp, 'a lit door must be advertised');
    // The native door is what it used to point at: a platform calling `create_checkout` there got an
    // unknown-tool error, which is the defect this repoint fixes.
    assert.equal(mcp.endpoint, 'https://shop.pivota.cc/ucp/mcp');
    assert.notEqual(mcp.endpoint, 'https://shop.pivota.cc/mcp');
  });
});

test('a DARK door is not advertised at all, rather than advertised as the native endpoint', async () => {
  await withEnv({ ...DOOR_DARK, AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED: '1' }, async () => {
    const resp = await supertest(app).get('/.well-known/ucp').expect(200);
    // An endpoint that cannot serve one UCP call is not a UCP transport. Omitting it is honest; pointing
    // back at /mcp is the "advertised but not executable" defect the rest of this profile already avoids.
    assert.equal(resp.body.services.find((s) => s.transport === 'mcp'), undefined);
    assert.equal(JSON.stringify(resp.body.services).includes('/ucp/mcp'), false);
  });
});

test('the advertised endpoint is one the door actually answers on', async () => {
  await withEnv({ ...DOOR_LIT, AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED: '1' }, async () => {
    const resp = await supertest(app).get('/.well-known/ucp').expect(200);
    const advertised = resp.body.services.find((s) => s.transport === 'mcp').endpoint;
    // Follow the profile the way a platform would: take the advertised path and call it.
    const path = new URL(advertised).pathname;
    const listed = await supertest(app).post(path).send(rpc('tools/list', undefined, 9)).expect(200);
    assert.ok(
      listed.body.result.tools.some((t) => t.name === 'create_checkout'),
      'the endpoint the profile advertises must serve the UCP vocabulary',
    );
  });
});

// ---- the 401 a platform actually receives points at metadata describing THIS door ------------------
//
// Observed live on 2026-08-13, minutes after the door was lit: POST /ucp/mcp answered
//   401 … resource_metadata="https://commerce.mcp.pivota.cc/.well-known/oauth-protected-resource"
// whose document declared `resource: "https://commerce.mcp.pivota.cc/mcp"` — the NATIVE door. A client
// following the challenge from /ucp/mcp learned the identifier of a different endpoint, so it had
// nothing correct to request a token for (RFC 9728 §3.3). Driven end to end through the real app,
// because that mismatch lives in the HTTP response, not in any one function.
const OAUTH_ON = {
  MCP_OAUTH_ENABLED: '1',
  MCP_OAUTH_RESOURCE: 'https://shop.pivota.cc/mcp',
  MCP_OAUTH_AUTHORIZATION_SERVERS: 'https://auth.pivota.example',
};

test('an unauthenticated UCP call challenges with metadata for /ucp/mcp — and that document agrees', async () => {
  await withEnv({ ...DOOR_LIT, ...OAUTH_ON }, async () => {
    const resp = await supertest(app).post('/ucp/mcp').send(rpc('tools/list', undefined, 21)).expect(401);
    const challenge = resp.headers['www-authenticate'];
    assert.match(challenge, /^Bearer /);
    const url = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    assert.ok(url, `no resource_metadata in: ${challenge}`);
    assert.equal(new URL(url).pathname, '/.well-known/oauth-protected-resource/ucp/mcp');

    // Follow it exactly as a client would, and require the identifier to be the door we just called.
    const doc = await supertest(app).get(new URL(url).pathname).expect(200);
    assert.equal(doc.body.resource, 'https://shop.pivota.cc/ucp/mcp');
    assert.equal(new URL(doc.body.resource).pathname, '/ucp/mcp');
  });
});

test('the NATIVE door still challenges with — and serves — its own unchanged identifier', async () => {
  await withEnv(OAUTH_ON, async () => {
    const resp = await supertest(app).post('/mcp').send(rpc('tools/list', undefined, 22)).expect(401);
    const url = /resource_metadata="([^"]+)"/.exec(resp.headers['www-authenticate'])?.[1];
    assert.equal(new URL(url).pathname, '/.well-known/oauth-protected-resource/mcp');
    const doc = await supertest(app).get(new URL(url).pathname).expect(200);
    assert.equal(doc.body.resource, 'https://shop.pivota.cc/mcp');
    // The bare root document is what native clients discovered before path-insertion; it must not move.
    const root = await supertest(app).get('/.well-known/oauth-protected-resource').expect(200);
    assert.equal(root.body.resource, 'https://shop.pivota.cc/mcp');
  });
});
