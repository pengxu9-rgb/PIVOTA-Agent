'use strict';

// THE STORE-CART HARDENING FIXTURE: the storefront-cart door fixture (mcpStorefrontCartDoor.cjs: the real gateway
// app, offline, with a catalog, a backend and seller storefronts) plus what the hardening changes need:
//
//   - PARTNERS. Two partner agents call the doors with their own api keys (introspection answered in-process), so
//     the gateway has a partner to sign for.
//   - THE BACKEND'S REFERRAL ROUTE (POST /agent/v2/storefront-cart-referrals), answered with the REAL backend
//     handler's recorded answers (tests/fixtures/backend_storefront_cart_referral.backend.json, recorded from
//     pivota-backend; see its `generated_from`). The recording holds one placeholder click id per case; each
//     minted answer here gets its own (a counter), as each real call does, and the campaign of the market asked. The partner assertion on a request is
//     verified the way the backend verifies it (MAC, method, path, exact body bytes, a fresh nonce, 60 s).
//   - THE BACKEND'S HAND-OFF RECORD ROUTE, answered as recorded for every well-formed write.
//
// Shared by tests/store_cart_referral_door.node.test.cjs and the private differential harness. Every name is a
// placeholder.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const nock = require('nock');

const support = require('./mcpStorefrontCartDoor.cjs');

const REFERRAL_FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'backend_storefront_cart_referral.backend.json'), 'utf8'));
const REFERRAL_PATH = '/agent/v2/storefront-cart-referrals';
const HANDOFF_PATH = '/agent/v2/storefront-handoffs';
const ASSERTION_SECRET = 'store_cart_hardening_test_secret';
const INTROSPECT_BASE = 'https://auth.store-cart-hardening.test';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const KEY_A = `ak_live_${'a1'.repeat(32)}`;
const KEY_B = `ak_live_${'b2'.repeat(32)}`;
const PARTNER_A = 'agent_partner_a';
const PARTNER_B = 'agent_partner_b';
// A buyer of partner A, another buyer of partner A, and a buyer of partner B.
const AS = Object.freeze({
  A: Object.freeze({ ...support.BUYER, 'X-Agent-API-Key': KEY_A }),
  A_OTHER_BUYER: Object.freeze({ ...support.OTHER_BUYER, 'X-Agent-API-Key': KEY_A }),
  B: Object.freeze({ 'X-Test-User-Ref': 'buyer-0003', 'X-Test-Acp-Session-Id': 'sess-0003', 'X-Agent-API-Key': KEY_B }),
  // THE SAME BUYER AND SESSION AS `A`, calling through partner B: one person using two partners' agents.
  A_BUYER_VIA_B: Object.freeze({ ...support.BUYER, 'X-Agent-API-Key': KEY_B }),
  // The same buyer and partner as `A`, in another session.
  A_OTHER_SESSION: Object.freeze({ ...support.BUYER, 'X-Test-Acp-Session-Id': 'sess-0009', 'X-Agent-API-Key': KEY_A }),
});

const REFERRAL_FLAG = 'AGENT_CHECKOUT_UCP_CART_REFERRAL_ENABLED';
const ATTRIBUTION_FLAG = 'AGENT_CHECKOUT_UCP_CART_ATTRIBUTION_ENABLED';
const FORWARDING_FLAG = 'PARTNER_IDENTITY_FORWARDING_ENABLED';
const HANDOFF_RECORD_FLAG = 'UCP_STOREFRONT_HANDOFF_RECORD_ENABLED';
const NATIVE_DOOR_FLAG = 'AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED';
const IDEMPOTENCY_FLAG = 'AGENT_CHECKOUT_STORE_CART_IDEMPOTENCY_ENABLED';
const ID_BINDING_FLAG = 'AGENT_CHECKOUT_STORE_CART_ID_BINDING';
// THE `/mcp` STOREFRONT PATH RUNS ONLY UNDER THE CURRENCY RULE (mcp-server/src/mcpStorefrontCart.js
// `mcpStorefrontCartPath`): with its own switch on and the rule off, nothing of it runs. So a test that turns the
// native door on gets the rule with it (setFlags), unless it names the rule's state itself (`CURRENCY_OFF`).
const CURRENCY_FLAG = 'AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET';
const CURRENCY_OFF = `${CURRENCY_FLAG}=`;
const BIND_MINT = `${ID_BINDING_FLAG}=mint`;
const BIND_ENFORCE = `${ID_BINDING_FLAG}=enforce`;
const PER_CALL_FLAGS = Object.freeze([REFERRAL_FLAG, ATTRIBUTION_FLAG, FORWARDING_FLAG, HANDOFF_RECORD_FLAG, NATIVE_DOOR_FLAG, IDEMPOTENCY_FLAG, ID_BINDING_FLAG, CURRENCY_FLAG]);

/**
 * Set exactly these per-call flags (`NAME` = '1', or `NAME=value`; an empty value unsets); every other one of
 * PER_CALL_FLAGS is unset. The native door's switch brings the currency rule with it unless the rule is named.
 */
function setFlags(on = []) {
  const wanted = new Map(on.map((entry) => (entry.includes('=') ? entry.split('=') : [entry, '1'])));
  if (wanted.has(NATIVE_DOOR_FLAG) && !wanted.has(CURRENCY_FLAG)) wanted.set(CURRENCY_FLAG, '1');
  for (const flag of PER_CALL_FLAGS) {
    if (wanted.has(flag) && wanted.get(flag) !== '') process.env[flag] = wanted.get(flag);
    else delete process.env[flag];
  }
}

function bootHardeningDoor({ root, port = 4461, env = {} } = {}) {
  const door = support.bootDoor({
    ...(root ? { root } : {}),
    port,
    env: {
      AGENT_AUTH_INTROSPECT_URL: `${INTROSPECT_BASE}${INTROSPECT_PATH}`,
      AGENT_AUTH_INTROSPECT_INTERNAL_KEY: 'internal_test_key',
      AGENT_AUTH_INTROSPECT_TIMEOUT_MS: '1200',
      INVOKE_AUTH_BYPASS_IN_TEST: '0',
      ISSUING_AGENT_ASSERTION_SECRET: ASSERTION_SECRET,
      ...env,
    },
  });
  for (const [key, agentId] of [[KEY_A, PARTNER_A], [KEY_B, PARTNER_B]]) {
    nock(INTROSPECT_BASE).persist()
      .post(INTROSPECT_PATH, (body) => body && body.api_key === key)
      .reply(200, { valid: true, agent_id: agentId, is_active: true, auth_source: 'api_keys' });
  }

  // ---- the partner assertion, verified as the backend verifies it -------------------------------------------
  const seenNonces = new Set();
  function assertionOf(headers, { requestPath, body }) {
    const token = headers['x-pivota-issuing-agent'];
    if (!token) return null;
    const [version, encoded, mac] = String(token).split('.');
    const expected = crypto.createHmac('sha256', ASSERTION_SECRET).update(`${version}.${encoded}`).digest('base64url');
    let payload = null;
    try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { payload = null; }
    const raw = JSON.stringify(body);
    const ok = version === 'v2' && mac === expected && payload && payload.v === 2 && payload.m === 'POST'
      && payload.p === requestPath
      && payload.bh === crypto.createHash('sha256').update(raw, 'utf8').digest('hex')
      && typeof payload.jti === 'string' && !seenNonces.has(payload.jti)
      && Math.abs(Date.now() / 1000 - payload.ts) <= 60;
    if (payload && typeof payload.jti === 'string') seenNonces.add(payload.jti);
    return { ok: Boolean(ok), payload };
  }

  // ---- the referral route --------------------------------------------------------------------------------------
  const referralCalls = [];
  const state = { referral: 'recorded', delayMs: 0, clickSeq: 0, handoff: 'recorded' };
  const withOwnClickId = (recorded) => {
    state.clickSeq += 1;
    const placeholder = recorded.body.click_id;
    const own = `clk_${state.clickSeq.toString(16).padStart(24, '0')}`;
    return [recorded.status, JSON.parse(JSON.stringify(recorded.body).split(placeholder).join(own))];
  };
  nock(support.BACKEND_BASE).persist()
    .post(REFERRAL_PATH)
    .reply(async function reply(uri, body) {
      if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      const assertion = assertionOf(this.req.headers, { requestPath: uri.split('?')[0], body });
      const storeToolCallsSoFar = door.storeCalls.filter((c) => c.kind === 'tool').length;
      referralCalls.push({ headers: { ...this.req.headers }, assertion, body, storeToolCallsSoFar });
      const mode = state.referral;
      if (mode === 'malformed') {
        return [200, { click_id: 'clk_malformed', surface: 'x', attribution: { utm_source: 'pivota', pvt_click_id: 'clk_malformed', note: 'https://elsewhere.example/?x=1' } }];
      }
      if (mode !== 'recorded') return [REFERRAL_FIXTURE[mode].status, REFERRAL_FIXTURE[mode].body];
      // As the real handler: a caller that is not our own service is refused; a bad assertion is refused; a
      // good one names the partner; none names nobody.
      if (assertion && (!assertion.ok || assertion.payload.op !== 'ucp_storefront_cart.referral' || assertion.payload.rid !== null)) {
        return [REFERRAL_FIXTURE.assertion_rejected.status, REFERRAL_FIXTURE.assertion_rejected.body];
      }
      const known = new Set(['seller_host', 'market', 'merchant_id']);
      if (!body || typeof body.seller_host !== 'string' || Object.keys(body).some((k) => !known.has(k))) {
        return [REFERRAL_FIXTURE.invalid_body.status, REFERRAL_FIXTURE.invalid_body.body];
      }
      // THE MARKET IS REQUIRED, as the real handler requires it: none (absent, null or blank) and one that is not
      // two capital letters are refused with the recorded refusals, and nothing is minted. A well-formed market
      // the handler's registry does not list (the recorded one: "ZZ") is refused with the recorded `market_unknown`.
      if (body.market === undefined || body.market === null || String(body.market).trim() === '') {
        return [REFERRAL_FIXTURE.market_required.status, REFERRAL_FIXTURE.market_required.body];
      }
      if (typeof body.market !== 'string' || !/^[A-Z]{2}$/.test(body.market)) {
        return [REFERRAL_FIXTURE.market_invalid.status, REFERRAL_FIXTURE.market_invalid.body];
      }
      if (body.market === REFERRAL_FIXTURE.market_unknown.request.market) {
        return [REFERRAL_FIXTURE.market_unknown.status, REFERRAL_FIXTURE.market_unknown.body];
      }
      // The recorded answer for this request's shape. The recordings hold the campaign of the market they were
      // made with (US, SG, GB); for any other market the campaign is that market, as the recorded SG and GB
      // answers show the handler does.
      const recorded = assertion ? REFERRAL_FIXTURE.minted_for_partner
        : body.market === 'SG' ? REFERRAL_FIXTURE.minted_market_sg
          : body.market === 'GB' ? REFERRAL_FIXTURE.minted_market_gb : REFERRAL_FIXTURE.minted_no_partner;
      const [status, answer] = withOwnClickId(recorded);
      answer.attribution.utm_campaign = body.market;
      return [status, answer];
    });

  // ---- the hand-off record route -------------------------------------------------------------------------------
  const handoffCalls = [];
  const handoffReads = [];
  const handoffRows = new Map();
  nock(support.BACKEND_BASE).persist()
    .post(HANDOFF_PATH)
    .reply(function reply(uri, body) {
      const assertion = assertionOf(this.req.headers, { requestPath: uri.split('?')[0], body });
      handoffCalls.push({ assertion, body });
      if (!assertion || !assertion.ok) return [409, { detail: { error: 'partner_identity_required' } }];
      handoffRows.set(body.record_id, { partner: assertion.payload.sub, ...body });
      return [200, { record_id: body.record_id, status: 'handed_off' }];
    })
    .post(`${HANDOFF_PATH}/read`)
    .reply(function reply(uri, body) {
      const assertion = assertionOf(this.req.headers, { requestPath: uri.split('?')[0], body });
      handoffReads.push({ assertion, body });
      const row = handoffRows.get(body.record_id);
      if (!assertion || !assertion.ok) return [409, { detail: { error: 'partner_identity_required' } }];
      if (!row || row.binding !== body.binding) return [404, { detail: { error: 'handoff_not_found' } }];
      if (row.partner !== assertion.payload.sub) return [409, { detail: { error: 'not_owner' } }];
      return [200, {
        record_id: body.record_id, status: 'handed_off', handed_off_at: '2026-11-11T12:00:00Z', seller_host: row.seller_host,
        quote_source: row.quote_source, quoted_total: { amount: row.quoted_total_minor, currency: row.currency },
      }];
    });

  /**
   * How the referral route answers next: 'recorded' (the real handler's behaviour), or one recorded refusal by name
   * ('dark', 'store_unavailable', 'assertion_rejected', 'not_a_service_caller', 'invalid_body', 'market_required',
   * 'market_invalid', 'market_unknown'), or 'malformed';
   * `delayMs` holds every answer back that long.
   */
  const setReferralBackend = (mode = 'recorded', { delayMs = 0 } = {}) => { state.referral = mode; state.delayMs = delayMs; };
  const resetHardening = () => {
    referralCalls.length = 0;
    handoffCalls.length = 0;
    handoffReads.length = 0;
    handoffRows.clear();
    state.clickSeq = 0;
    setReferralBackend('recorded');
    door.reset();
  };
  /** tools/call that also reports the referral and hand-off calls it caused. */
  async function call(doorPath, name, args, options) {
    const before = { referral: referralCalls.length, handoff: handoffCalls.length, reads: handoffReads.length, tools: door.storeCalls.filter((c) => c.kind === 'tool').length };
    const out = await door.call(doorPath, name, args, options);
    return {
      ...out,
      // `storeToolCallsBefore`: how many store tool calls THIS call had made when the referral was asked for.
      referral: referralCalls.slice(before.referral).map((r) => ({ ...r, storeToolCallsBefore: r.storeToolCallsSoFar - before.tools })),
      handoff: handoffCalls.slice(before.handoff),
      handoffReads: handoffReads.slice(before.reads),
    };
  }
  return { ...door, call, referralCalls, handoffCalls, setReferralBackend, resetHardening };
}

const { IDS, ucpCreate, nativeCreate, idem } = support;
const UCP_META = Object.freeze({ 'ucp-agent': { profile: 'https://agent.example/profile' } });
/** UCP create with its own idempotency key. */
const ucpCreateKeyed = (items, market, n, extra = {}) => {
  const args = ucpCreate(items, market);
  return { ...args, meta: { ...args.meta, 'idempotency-key': idem(n) }, checkout: { ...args.checkout, ...extra } };
};

/**
 * THE HARDENING REQUEST SET, in one fixed order: store carts with and without a stamped catalog link, retries with
 * the same and with a different body, and reads of a cart by its buyer and by other buyers, on both doors. Returns
 * `{ key: answer }`; each answer carries what reached the store, the backend, the referral route and the hand-off
 * route during that call. The private differential runs it over this tree and the base tree under each flag set.
 */
async function runHardeningRequests(door) {
  const out = {};
  const ucp = async (key, name, args, as = AS.A) => { out[key] = await door.call('/ucp/mcp', name, args, { buyer: as }); return out[key]; };
  const mcp = async (key, name, args, as = AS.A) => { out[key] = await door.call('/mcp', name, args, { buyer: as }); return out[key]; };
  const idOf = (answer) => (answer.value && (answer.value.id || answer.value.session_id)) || support.FORGED_ESC_ID;

  // ---- carts with and without a stamped link ----
  const plain = await ucp('ucp.cart_unstamped_link', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A, 1]], 'US', 101));
  const stamped = await ucp('ucp.cart_stamped_link', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A_STAMPED, 1]], 'US', 102));
  await ucp('ucp.cart_no_market', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A, 1]], undefined, 103));
  await ucp('ucp.cart_two_products', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A, 2], [IDS.SIG_A_SECOND, 1]], 'US', 104));
  await ucp('ucp.cart_store_answer_rejected', 'create_checkout', ucpCreateKeyed([[IDS.SIG_B, 1]], 'US', 105));
  await ucp('ucp.cart_unresolved_variant', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A_MULTI, 1]], 'US', 106));
  await ucp('ucp.cart_declined_seller', 'create_checkout', ucpCreateKeyed([[IDS.SIG_C, 1]], 'US', 107));
  await ucp('ucp.cart_other_partner', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A, 1]], 'US', 108), AS.B);
  await ucp('ucp.get_unstamped', 'get_checkout', { meta: UCP_META, id: idOf(plain) });
  await ucp('ucp.get_stamped', 'get_checkout', { meta: UCP_META, id: idOf(stamped) });
  const nativePlain = await mcp('mcp.cart_unstamped_link', 'create_checkout_session', nativeCreate(IDS.SELLER_A, [[IDS.SIG_A, 1]], { market: 'US', n: 111 }));
  await mcp('mcp.cart_stamped_link', 'create_checkout_session', nativeCreate(IDS.SELLER_A, [[IDS.SIG_A_STAMPED, 1]], { market: 'US', n: 112 }));
  await mcp('mcp.get_unstamped', 'get_checkout_session', { session_id: idOf(nativePlain) });

  // ---- retries ----
  const first = await ucp('ucp.retry_first', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A_SECOND, 1]], 'US', 121));
  await ucp('ucp.retry_same_body', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A_SECOND, 1]], 'US', 121));
  await ucp('ucp.retry_same_body_again', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A_SECOND, 1]], 'US', 121));
  await ucp('ucp.retry_different_quantity', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A_SECOND, 2]], 'US', 121));
  await ucp('ucp.retry_different_market', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A_SECOND, 1]], 'SG', 121));
  await ucp('ucp.retry_different_product', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A, 1]], 'US', 121));
  await ucp('ucp.retry_same_key_other_buyer', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A_SECOND, 1]], 'US', 121), AS.A_OTHER_BUYER);
  await ucp('ucp.retry_same_key_other_partner', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A_SECOND, 1]], 'US', 121), AS.B);
  await ucp('ucp.same_body_new_key', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A_SECOND, 1]], 'US', 122));
  await ucp('ucp.retry_get_first', 'get_checkout', { meta: UCP_META, id: idOf(first) });
  const nativeFirst = await mcp('mcp.retry_first', 'create_checkout_session', nativeCreate(IDS.SELLER_A, [[IDS.SIG_A_SECOND, 1]], { market: 'US', n: 131 }));
  await mcp('mcp.retry_same_body', 'create_checkout_session', nativeCreate(IDS.SELLER_A, [[IDS.SIG_A_SECOND, 1]], { market: 'US', n: 131 }));
  await mcp('mcp.retry_different_quantity', 'create_checkout_session', nativeCreate(IDS.SELLER_A, [[IDS.SIG_A_SECOND, 3]], { market: 'US', n: 131 }));
  await mcp('mcp.retry_chosen_variant_first', 'create_checkout_session', nativeCreate(IDS.SELLER_A, [[IDS.SIG_A_MULTI, 1, IDS.VARIANT_A_MULTI[1]]], { market: 'US', n: 132 }));
  await mcp('mcp.retry_chosen_variant_same', 'create_checkout_session', nativeCreate(IDS.SELLER_A, [[IDS.SIG_A_MULTI, 1, IDS.VARIANT_A_MULTI[1]]], { market: 'US', n: 132 }));
  await mcp('mcp.retry_other_variant', 'create_checkout_session', nativeCreate(IDS.SELLER_A, [[IDS.SIG_A_MULTI, 1, IDS.VARIANT_A_MULTI[0]]], { market: 'US', n: 132 }));
  // The same key on the other door is another door's key: the two doors do not share one.
  await ucp('ucp.retry_native_key_on_ucp', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A_SECOND, 1]], 'US', 131));
  // A kernel checkout keeps its own idempotency (the connected merchant), untouched.
  await mcp('mcp.kernel_create', 'create_checkout_session', nativeCreate(IDS.SELLER_CONNECTED, [[IDS.SOURCE_CONNECTED, 1, IDS.VARIANT_CONNECTED]], { n: 141 }));
  await mcp('mcp.kernel_create_retry', 'create_checkout_session', nativeCreate(IDS.SELLER_CONNECTED, [[IDS.SOURCE_CONNECTED, 1, IDS.VARIANT_CONNECTED]], { n: 141 }));

  // ---- a cart read by its buyer and by others ----
  const owned = await ucp('ucp.owned_create', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A, 3]], 'US', 151));
  const ownedId = idOf(owned);
  await ucp('ucp.owned_get_by_owner', 'get_checkout', { meta: UCP_META, id: ownedId });
  await ucp('ucp.owned_get_by_other_buyer', 'get_checkout', { meta: UCP_META, id: ownedId }, AS.A_OTHER_BUYER);
  await ucp('ucp.owned_get_by_other_partner', 'get_checkout', { meta: UCP_META, id: ownedId }, AS.B);
  await ucp('ucp.owned_update_by_owner', 'update_checkout', { meta: { ...UCP_META, 'idempotency-key': idem(152) }, id: ownedId, checkout: { line_items: [{ item: { id: IDS.SIG_A }, quantity: 2 }] } });
  await ucp('ucp.owned_update_by_other_buyer', 'update_checkout', { meta: { ...UCP_META, 'idempotency-key': idem(153) }, id: ownedId, checkout: { line_items: [{ item: { id: IDS.SIG_A }, quantity: 2 }] } }, AS.A_OTHER_BUYER);
  await ucp('ucp.owned_complete_by_owner', 'complete_checkout', { meta: { ...UCP_META, 'idempotency-key': idem(154) }, id: ownedId, checkout: { payment: { instruments: [] } } });
  await ucp('ucp.owned_complete_by_other_buyer', 'complete_checkout', { meta: { ...UCP_META, 'idempotency-key': idem(155) }, id: ownedId, checkout: { payment: { instruments: [] } } }, AS.A_OTHER_BUYER);
  await mcp('mcp.owned_get_by_owner', 'get_checkout_session', { session_id: ownedId });
  await mcp('mcp.owned_get_by_other_buyer', 'get_checkout_session', { session_id: ownedId }, AS.A_OTHER_BUYER);
  await mcp('mcp.owned_update_by_other_buyer', 'update_checkout_session', { ...nativeCreate(IDS.SELLER_A, [[IDS.SIG_A, 2]], { n: 156 }), session_id: ownedId }, AS.A_OTHER_BUYER);
  await mcp('mcp.owned_complete_by_other_buyer', 'complete_checkout_session', { idempotency_key: idem(157), session_id: ownedId, payment_authorization: { type: 'none' } }, AS.A_OTHER_BUYER);
  await mcp('mcp.owned_cancel_by_owner', 'cancel_checkout_session', { idempotency_key: idem(158), session_id: ownedId });
  await mcp('mcp.owned_cancel_by_other_buyer', 'cancel_checkout_session', { idempotency_key: idem(159), session_id: ownedId }, AS.A_OTHER_BUYER);
  await mcp('mcp.owned_payment_link_by_other_buyer', 'create_payment_link', { idempotency_key: idem(160), session_id: ownedId, customer_email: 'buyer@example.test' }, AS.A_OTHER_BUYER);
  await mcp('mcp.owned_get_order_by_owner', 'get_order', { order_id: ownedId });
  await mcp('mcp.owned_get_order_by_other_buyer', 'get_order', { order_id: ownedId }, AS.A_OTHER_BUYER);
  // Ids nobody minted: a forged one, a legacy one, one carrying members the door never writes.
  await ucp('ucp.get_forged', 'get_checkout', { meta: UCP_META, id: support.FORGED_ESC_ID });
  await ucp('ucp.get_legacy', 'get_checkout', { meta: UCP_META, id: support.LEGACY_ESC_ID });
  await ucp('ucp.get_hand_built_fallback_id', 'get_checkout', { meta: UCP_META, id: support.escId({ v: 1, i: [[IDS.SIG_A, 1]], m: 'US' }) });
  await ucp('ucp.get_hand_built_tracking_id', 'get_checkout', { meta: UCP_META, id: support.escId({ v: 2, i: [[IDS.SIG_A, 3]], c: 'cart_store-a_9999', h: support.HOST.A, m: 'US', t: { utm_source: 'elsewhere', pvt_click_id: 'clk_forged' } }) });
  await ucp('ucp.get_hand_built_bad_tracking_id', 'get_checkout', { meta: UCP_META, id: support.escId({ v: 2, i: [[IDS.SIG_A, 3]], c: 'cart_store-a_9999', h: support.HOST.A, m: 'US', t: { note: 'https://elsewhere.example/' } }) });
  await ucp('ucp.get_hand_built_v3_id', 'get_checkout', { meta: UCP_META, id: support.escId({ v: 3, i: [[IDS.SIG_A, 3]], c: 'cart_store-a_9999', h: support.HOST.A, m: 'US', b: 'A'.repeat(43) }) });
  // No verified buyer at all.
  await ucp('ucp.owned_get_no_buyer', 'get_checkout', { meta: UCP_META, id: ownedId }, { 'X-Agent-API-Key': KEY_A });

  // ---- one buyer, two partners; one partner, two sessions; a key under the published minimum ----
  const scoped = await ucp('ucp.scope_first', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A_SECOND, 2]], 'US', 171));
  await ucp('ucp.scope_same_buyer_other_partner_same_cart', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A_SECOND, 2]], 'US', 171), AS.A_BUYER_VIA_B);
  await ucp('ucp.scope_other_session_same_cart', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A_SECOND, 2]], 'US', 171), AS.A_OTHER_SESSION);
  await ucp('ucp.scope_same_everything', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A_SECOND, 2]], 'US', 171));
  // Another cart under a key the buyer used through partner A in the first session: a key of its own (177), so that
  // neither the other partner nor the other session has used it before.
  await ucp('ucp.scope_second', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A_SECOND, 3]], 'US', 177));
  await ucp('ucp.scope_same_buyer_other_partner_other_cart', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A, 1]], 'US', 177), AS.A_BUYER_VIA_B);
  await ucp('ucp.scope_other_session_other_cart', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A, 1]], 'US', 177), AS.A_OTHER_SESSION);
  await ucp('ucp.scope_get_first_by_other_partner', 'get_checkout', { meta: UCP_META, id: idOf(scoped) }, AS.A_BUYER_VIA_B);
  await mcp('mcp.scope_first', 'create_checkout_session', nativeCreate(IDS.SELLER_A, [[IDS.SIG_A, 2]], { market: 'US', n: 172 }));
  await mcp('mcp.scope_same_buyer_other_partner_same_cart', 'create_checkout_session', nativeCreate(IDS.SELLER_A, [[IDS.SIG_A, 2]], { market: 'US', n: 172 }), AS.A_BUYER_VIA_B);
  await mcp('mcp.scope_other_session_other_cart', 'create_checkout_session', nativeCreate(IDS.SELLER_A, [[IDS.SIG_A, 3]], { market: 'US', n: 172 }), AS.A_OTHER_SESSION);
  const shortKey = (args, key) => ({ ...args, meta: { ...args.meta, 'idempotency-key': key } });
  await ucp('ucp.key_7_characters', 'create_checkout', shortKey(ucpCreateKeyed([[IDS.SIG_A, 1]], 'US', 173), 'idem-07'));
  await ucp('ucp.key_8_characters', 'create_checkout', shortKey(ucpCreateKeyed([[IDS.SIG_A, 1]], 'US', 173), 'idem-008'));
  await mcp('mcp.key_7_characters', 'create_checkout_session', { ...nativeCreate(IDS.SELLER_A, [[IDS.SIG_A, 1]], { market: 'US', n: 174 }), idempotency_key: 'idem-07' });
  await mcp('mcp.key_7_characters_kernel', 'create_checkout_session', { ...nativeCreate(IDS.SELLER_CONNECTED, [[IDS.SOURCE_CONNECTED, 1, IDS.VARIANT_CONNECTED]], { n: 175 }), idempotency_key: 'idem-07' });
  // No market named, with a second product (the first no-market cart is `ucp.cart_no_market`).
  await ucp('ucp.cart_no_market_second', 'create_checkout', ucpCreateKeyed([[IDS.SIG_A_SECOND, 1]], undefined, 176));
  return out;
}

module.exports = {
  ...support,
  AS,
  ASSERTION_SECRET,
  ATTRIBUTION_FLAG,
  BIND_ENFORCE,
  BIND_MINT,
  CURRENCY_FLAG,
  CURRENCY_OFF,
  FORWARDING_FLAG,
  HANDOFF_PATH,
  HANDOFF_RECORD_FLAG,
  ID_BINDING_FLAG,
  IDEMPOTENCY_FLAG,
  KEY_A,
  KEY_B,
  NATIVE_DOOR_FLAG,
  PARTNER_A,
  PARTNER_B,
  PER_CALL_FLAGS,
  REFERRAL_FIXTURE,
  REFERRAL_FLAG,
  REFERRAL_PATH,
  UCP_META,
  bootHardeningDoor,
  runHardeningRequests,
  setFlags,
  ucpCreateKeyed,
};
