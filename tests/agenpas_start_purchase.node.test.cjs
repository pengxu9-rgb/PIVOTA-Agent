'use strict';

// `start_purchase` / `get_order` and AgenPas: the answer gains `agenpas_url` ONLY while AGENPAS_ENABLED is on (and
// everything the link needs is there), and is otherwise exactly the answer it was; the two tool descriptions gain one
// sentence each under the same condition and are otherwise byte-identical. Through the REAL surface, tool, clients and money
// filter, with a stubbed backend fetch and a recording catalog read (same harness as
// tests/orchestrated_purchase_tool.node.test.cjs). Placeholder merchant and product. No network.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAgentPurchaseCreateClient } = require('../src/services/agentPurchaseCreateClient');
const { createAgentPurchaseReadClient } = require('../src/services/agentPurchaseReadClient');
const { createAgenpasLinkMinter } = require('../src/agenpas/link');
const { verifyLinkToken } = require('../src/agenpas/linkToken');

const SECRET = 'start-purchase-test-secret-0123456789abcdef';
const AP = 'ap_283fba3ce85c4e59bb331e54';
const PP = 'pp_aaaaaaaaaaaaaaaaaaaaaaaa';
const CARD_PAGE = 'https://pay.partner.example/bind?token=abc';
const SESSION = Object.freeze({ user_ref: 'usr_buyerFixture0001', acp_session_id: 'sess_1', agent_id: 'agent_fixture_1' });
const AUTH = () => ({ 'X-API-Key': 'ak_fixture', 'X-Agent-User-JWT': 'jwt-fixture' });

const ROW = Object.freeze({
  product_id: 'sig_fixture_0001',
  title: 'Sample Lip Gloss',
  price: 18,
  currency: 'USD',
  merchant_id: 'merch_fixture',
  platform: 'shopify',
  product_key: 'prod::merch_fixture::shopify::1001',
  external_redirect_url: 'https://merchant.example/products/sample-lip-gloss?variant=40000000000001',
  purchase_grain: 'product',
  variants: [{ variant_id: 'sig_fixture_0001', source_variant_id: '40000000000001' }],
});

let modsPromise = null;
function mods() {
  if (!modsPromise) {
    modsPromise = (async () => ({
      surface: await import('../mcp-server/src/commerceToolSurface.js'),
      executor: await import('../safety-kernel/src/protocol/canonicalExecutor.js'),
    }))();
  }
  return modsPromise;
}

function unified(railId = AP) {
  return {
    purchase_id: PP, rail: railId.startsWith('ap_') ? 'a2a' : 'reap', executor: 'rail_managed', rail_purchase_id: railId, state: 'needs_payment_method',
    rail_state: 'needs_payment_method', created_at: '2026-11-17T00:00:00Z', totals: { currency: 'USD', our_price_minor: 1800 },
    poll_after_seconds: 15,
    next_action: { type: 'open_url', kind: 'card_binding', url: CARD_PAGE, expires_at: '2026-11-17T00:30:00Z' },
    detail: { id: AP, state: 'needs_payment_method', hosted_url: CARD_PAGE },
  };
}

const RP = 'rp_0123456789abcdef01234567';

function fakeBackend(rail = 'a2a') {
  return async (url, init = {}) => {
    const created = rail === 'a2a'
      ? { purchase_id: AP, rail: 'a2a', state: 'routing', rail_state: 'opened', poll_after_seconds: 5 }
      : { purchase_id: RP, status: 'resolving' };
    const r = init.method === 'POST' ? { status: 202, body: created } : { status: 200, body: unified(rail === 'a2a' ? AP : RP) };
    return { status: r.status, text: async () => JSON.stringify(r.body) };
  };
}

async function build({ withMinter = true, orderRailId = AP, createRail = 'a2a' } = {}) {
  const m = await mods();
  const deps = { baseUrl: 'https://backend.example', fetchImpl: fakeBackend(createRail), authHeaders: AUTH };
  const executor = {
    async execute(op, params) {
      if (op === 'get_product') return { product: params.payload.product.product_id === ROW.product_id ? { ...ROW } : null };
      // The canonical executor's own mapper (it marks the answer as a rail purchase read).
      if (op === 'get_order') return m.executor.agentPurchaseOrder(params.order_id, { kind: 'accepted', purchase: unified(orderRailId) });
      throw new Error(`unexpected op ${op}`);
    },
  };
  return m.surface.createCommerceToolSurface(executor, {
    cache: false,
    orchestratedPurchase: {
      createClient: createAgentPurchaseCreateClient(deps),
      readClient: createAgentPurchaseReadClient(deps),
      ...(withMinter ? { agenpasLink: createAgenpasLinkMinter() } : {}),
    },
  });
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const TOOL_ON = { ORCHESTRATED_PURCHASE_TOOL_ENABLED: '1', AGENT_PURCHASE_ORDER_READ_ENABLED: '1' };
const AGENPAS_CONFIG = { AGENPAS_LINK_SECRET: SECRET, AGENPAS_PUBLIC_BASE_URL: 'https://agenpas.example' };

function args() {
  return {
    idempotency_key: 'idem-agenpas-0001',
    merchant_id: 'merch_fixture',
    product_id: ROW.product_id,
    quantity: 1,
    expected_unit_price_minor: 1800,
    expected_currency: 'USD',
    consent_version: 'terms-fixture',
    customer_email: 'buyer@example.test',
    shipping_address: { name: 'Sam Placeholder', phone: '+15550100', address_line1: '1 Example Way', city: 'Sample City', postal_code: '00000', country: 'US' },
  };
}

test('flag off: the answer is exactly the answer without AgenPas (no agenpas_url), even with the link configured', async () => {
  const withMinter = await build();
  const without = await build({ withMinter: false });
  for (const env of [{ AGENPAS_ENABLED: undefined }, { AGENPAS_ENABLED: '0' }]) {
    await withEnv({ ...TOOL_ON, ...AGENPAS_CONFIG, ...env }, async () => {
      const a = await withMinter.callTool('start_purchase', args(), SESSION);
      const b = await without.callTool('start_purchase', args(), SESSION);
      assert.equal(Object.hasOwn(a, 'agenpas_url'), false);
      assert.deepEqual(a, b);
      assert.equal(JSON.stringify(a), JSON.stringify(b));
      assert.equal(a.order_id, PP);
      assert.equal(a.next_action.action_url, CARD_PAGE);
    });
  }
});

test('flag on: an additive agenpas_url for the answered purchase, minted for the verified caller', async () => {
  const surface = await build();
  const without = await build({ withMinter: false });
  await withEnv({ ...TOOL_ON, ...AGENPAS_CONFIG, AGENPAS_ENABLED: '1' }, async () => {
    const a = await surface.callTool('start_purchase', args(), SESSION);
    const b = await without.callTool('start_purchase', args(), SESSION);
    const { agenpas_url: url, ...rest } = a;
    assert.deepEqual(rest, b, 'nothing else changes');
    const u = new URL(url);
    assert.equal(u.origin, 'https://agenpas.example');
    assert.equal(u.pathname, `/agenpas/p/${PP}`);
    assert.equal(u.search, '');
    const verdict = verifyLinkToken(new URLSearchParams(u.hash.slice(1)).get('t'), { purchaseId: PP, aud: 'https://agenpas.example', secret: SECRET });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.claims.agentId, SESSION.agent_id);
    assert.equal(verdict.claims.userRef, SESSION.user_ref);
  });
});

test('flag on but no secret, no base URL, or no verified agent id: no agenpas_url', async () => {
  const surface = await build();
  for (const [env, session] of [
    [{ AGENPAS_LINK_SECRET: undefined }, SESSION],
    [{ AGENPAS_PUBLIC_BASE_URL: undefined }, SESSION],
    [{}, { user_ref: SESSION.user_ref, acp_session_id: SESSION.acp_session_id }],
  ]) {
    await withEnv({ ...TOOL_ON, ...AGENPAS_CONFIG, AGENPAS_ENABLED: '1', ...env }, async () => {
      const a = await surface.callTool('start_purchase', args(), session);
      assert.equal(Object.hasOwn(a, 'agenpas_url'), false, JSON.stringify(env));
    });
  }
});

// ---- get_order -------------------------------------------------------------------------------------------------

const ON_ALL = { ...TOOL_ON, ...AGENPAS_CONFIG, AGENPAS_ENABLED: '1' };

test('get_order of an A2A purchase: a FRESH agenpas_url while on (a new token each call), nothing while off', async () => {
  const surface = await build();
  const without = await build({ withMinter: false });
  await withEnv(ON_ALL, async () => {
    const a = await surface.callTool('get_order', { order_id: PP }, SESSION);
    const b = await surface.callTool('get_order', { order_id: PP }, SESSION);
    const base = await without.callTool('get_order', { order_id: PP }, SESSION);
    const { agenpas_url: url, ...rest } = a;
    assert.deepEqual(rest, base, 'nothing else changes');
    assert.notEqual(url, b.agenpas_url, 'each read mints a fresh link');
    const u = new URL(url);
    assert.equal(u.pathname, `/agenpas/p/${PP}`);
    assert.equal(u.search, '');
    const verdict = verifyLinkToken(new URLSearchParams(u.hash.slice(1)).get('t'), { purchaseId: PP, aud: 'https://agenpas.example', secret: SECRET });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.claims.agentId, SESSION.agent_id);
    assert.equal(verdict.claims.userRef, SESSION.user_ref);
  });
  for (const env of [{ AGENPAS_ENABLED: undefined }, { AGENPAS_LINK_SECRET: undefined }, { AGENPAS_PUBLIC_BASE_URL: undefined }]) {
    await withEnv({ ...ON_ALL, ...env }, async () => {
      const a = await surface.callTool('get_order', { order_id: PP }, SESSION);
      const base = await without.callTool('get_order', { order_id: PP }, SESSION);
      assert.equal(Object.hasOwn(a, 'agenpas_url'), false, JSON.stringify(env));
      assert.equal(JSON.stringify(a), JSON.stringify(base));
    });
  }
});

test('get_order: no agenpas_url for a purchase on another rail, on the UCP dialect, or without a verified agent id', async () => {
  const reap = await build({ orderRailId: 'rp_0123456789abcdef01234567' });
  const a2a = await build();
  await withEnv(ON_ALL, async () => {
    assert.equal(Object.hasOwn(await reap.callTool('get_order', { order_id: PP }, SESSION), 'agenpas_url'), false);
    const noAgent = { user_ref: SESSION.user_ref, acp_session_id: SESSION.acp_session_id };
    assert.equal(Object.hasOwn(await a2a.callTool('get_order', { order_id: PP }, noAgent), 'agenpas_url'), false);
    const ucp = await a2a.callTool('get_order', { order_id: PP }, SESSION, { dialect: 'ucp' }).catch(() => ({}));
    assert.equal(JSON.stringify(ucp).includes('agenpas'), false);
  });
});

// ---- tool descriptions -----------------------------------------------------------------------------------------

test('descriptions: byte-identical while links are not minted; one sentence each on start_purchase and get_order while they are', async () => {
  const m = await mods();
  const surface = await build();
  const without = await build({ withMinter: false });
  const describe = (s) => JSON.stringify(s.tools);
  for (const env of [{ AGENPAS_ENABLED: undefined }, { AGENPAS_ENABLED: '0' }, { AGENPAS_LINK_SECRET: undefined }, { AGENPAS_PUBLIC_BASE_URL: undefined }]) {
    await withEnv({ ...ON_ALL, ...env }, async () => {
      assert.equal(describe(surface), describe(without), JSON.stringify(env));
      assert.equal(describe(surface).includes('agenpas'), false);
    });
  }
  await withEnv(ON_ALL, async () => {
    const off = without.tools;
    const on = surface.tools;
    assert.equal(on.length, off.length);
    for (let i = 0; i < on.length; i += 1) {
      const expected = on[i].name === 'start_purchase' ? `${off[i].description} ${m.surface.agenpasStartPurchaseSentence(30)}`
        : on[i].name === 'get_order' ? `${off[i].description} ${m.surface.agenpasGetOrderSentence(30)}`
          : off[i].description;
      assert.equal(on[i].description, expected, on[i].name);
      assert.deepEqual({ ...on[i], description: null }, { ...off[i], description: null });
    }
    assert.ok(on.some((t) => t.name === 'start_purchase'));
    assert.ok(on.some((t) => t.name === 'get_order'));
  });
});

test('start_purchase on the Reap rail: no agenpas_url, even with links on (AgenPas serves the A2A rail only)', async () => {
  const reap = await build({ createRail: 'reap' });
  const without = await build({ createRail: 'reap', withMinter: false });
  await withEnv(ON_ALL, async () => {
    const a = await reap.callTool('start_purchase', args(), SESSION);
    assert.equal(a.rail_purchase_id, RP);
    assert.equal(Object.hasOwn(a, 'agenpas_url'), false);
    assert.equal(JSON.stringify(a), JSON.stringify(await without.callTool('start_purchase', args(), SESSION)));
  });
});

test('start_purchase whose read-back is pending still gets the link for an A2A purchase (the ap_ id)', async () => {
  const m = await mods();
  const deps = {
    baseUrl: 'https://backend.example', authHeaders: AUTH,
    fetchImpl: async (url, init = {}) => (init.method === 'POST'
      ? { status: 202, text: async () => JSON.stringify({ purchase_id: AP, rail: 'a2a', state: 'routing', rail_state: 'opened' }) }
      : { status: 503, text: async () => '{}' }),
  };
  const surface = m.surface.createCommerceToolSurface({
    async execute(op, params) { return { product: params.payload.product.product_id === ROW.product_id ? { ...ROW } : null }; },
  }, { cache: false, orchestratedPurchase: {
    createClient: createAgentPurchaseCreateClient(deps), readClient: createAgentPurchaseReadClient(deps), agenpasLink: createAgenpasLinkMinter(),
  } });
  await withEnv(ON_ALL, async () => {
    const a = await surface.callTool('start_purchase', args(), SESSION);
    assert.equal(a.read_pending, true);
    assert.equal(new URL(a.agenpas_url).pathname, `/agenpas/p/${AP}`);
  });
});

test('descriptions follow the configured link lifetime', async () => {
  const surface = await build();
  await withEnv({ ...ON_ALL, AGENPAS_LINK_TTL_SECONDS: '600' }, async () => {
    const sp = surface.tools.find((t) => t.name === 'start_purchase').description;
    const go = surface.tools.find((t) => t.name === 'get_order').description;
    assert.match(sp, /works for 10 minutes\.$/);
    assert.match(go, /valid 10 minutes/);
    assert.equal(/30 minutes/.test(sp + go), false);
  });
});
