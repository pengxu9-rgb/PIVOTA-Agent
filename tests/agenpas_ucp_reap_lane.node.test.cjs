'use strict';

// The UCP Reap lane and the AgenPas consent gate (R3-5; docs/agenpas.md, "Terms and privacy consent"). While the
// backend's gate withholds Reap's page (no `hosted_url`, `buyer_step = {kind, expires_at, consent_required: true}`)
// and the gateway's gate is on (AGENPAS_CONSENT_ENABLED + AGENPAS_RAILS with reap + links minted), get_checkout
// answers requires_escalation with continue_url = the buyer's AgenPas link (put in AFTER the money filter) and
// expires_at = the earlier of the step's deadline and the link's. Off: byte-identical answers and tools/list.
// Through the real surface, the real money filter and the real minter, with a stubbed Reap client. No network.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAgenpasLinkMinter } = require('../src/agenpas/link');
const { verifyLinkToken } = require('../src/agenpas/linkToken');

let modsPromise = null;
function mods() {
  if (!modsPromise) {
    modsPromise = (async () => ({
      surface: await import('../mcp-server/src/commerceToolSurface.js'),
      lane: await import('../mcp-server/src/ucpReapAgenticLane.js'),
    }))();
  }
  return modsPromise;
}

const SECRET = 'ucp-reap-consent-test-secret-0123456789';
const RP = 'rp_283fba3ce85c4e59bb331e54';
const SNAP = Object.freeze({ purchaseId: RP, productId: 'sig_reap_a', productKey: 'prod::m_fixture::shopify::1001', quantity: 1, currency: 'USD', unitMinor: 4250 });
const SESSION = Object.freeze({ user_ref: 'usr_buyerFixture0001', acp_session_id: 'sess_1', agent_id: 'agent_fixture_1' });
const META = { 'ucp-agent': { profile: 'https://agent.example/.well-known/ucp-agent' }, 'idempotency-key': 'idem-reap-consent-0001' };
const PAGE = 'https://pay.prava.space/checkout/chk_fixture';
const LANE_ON = { REAP_AGENTIC_LANE_ENABLED: '1' };
const AGENPAS = { AGENPAS_ENABLED: '1', AGENPAS_LINK_SECRET: SECRET, AGENPAS_PUBLIC_BASE_URL: 'https://agenpas.example' };
const GATE_ON = { ...LANE_ON, ...AGENPAS, AGENPAS_CONSENT_ENABLED: '1', AGENPAS_RAILS: 'a2a,reap' };

function inMinutes(n) { return new Date(Date.now() + n * 60_000).toISOString(); }

function view(state, extra = {}) {
  return {
    id: RP, state, merchant_domain: 'merchant.example', product_key: SNAP.productKey, product_name: 'Sample Lip Gloss', quantity: 1,
    totals: { currency: 'USD', our_price_minor: 4250, quoted_total_minor: state === 'awaiting_approval' ? 4600 : null },
    poll_after_seconds: 30, checkout_dispatch_state: state === 'awaiting_approval' ? 'dispatched' : 'not_dispatched',
    ...extra,
  };
}
function gatedView(state, deadline = inMinutes(10), extra = {}) {
  const kind = state === 'needs_enrollment' ? 'card_binding' : 'approval';
  return view(state, { buyer_step: { kind, expires_at: deadline, consent_required: true }, ...(state === 'awaiting_approval' ? { approval_deadline: deadline } : {}), ...extra });
}

async function build(v, { withMinter = true } = {}) {
  const m = await mods();
  const client = {
    hasCallerCredentials: () => true,
    startPurchase: async () => { throw new Error('no create in this suite'); },
    getPurchase: async () => ({ kind: 'accepted', purchase: typeof v === 'function' ? v() : v }),
  };
  const native = m.surface.createCommerceToolSurface({ async execute() { throw new Error('no kernel call'); } }, {
    cache: false,
    reapAgentic: { client },
    ...(withMinter ? { orchestratedPurchase: { agenpasLink: createAgenpasLinkMinter() } } : {}),
  });
  return { ucp: m.surface.ucpDialectSurface(native), id: m.lane.encodeReapCheckoutId(SNAP) };
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

// An `incomplete` answer's expires_at is the door's own wall-clock TTL (now + a constant): two calls a millisecond apart
// differ there and nowhere else, so comparisons drop it.
const stable = (out) => JSON.stringify(out && out.status === 'incomplete' ? { ...out, expires_at: '<ttl>' } : out);
const tokenExp = (url) => JSON.parse(Buffer.from(new URLSearchParams(new URL(url).hash.slice(1)).get('t').split('.')[1], 'base64url')).exp;

test('gated + gate on: requires_escalation, continue_url = the buyer\'s AgenPas link for the rp_ id, expires_at = the earlier deadline', async () => {
  for (const state of ['needs_enrollment', 'awaiting_approval']) {
    const deadline = inMinutes(10);
    const { ucp, id } = await build(gatedView(state, deadline));
    const out = await withEnv(GATE_ON, () => ucp.callTool('get_checkout', { meta: META, id }, SESSION));
    assert.equal(out.status, 'requires_escalation', state);
    const u = new URL(out.continue_url);
    assert.equal(u.origin, 'https://agenpas.example');
    assert.equal(u.pathname, `/agenpas/p/${RP}`);
    const verdict = verifyLinkToken(new URLSearchParams(u.hash.slice(1)).get('t'), { purchaseId: RP, aud: 'https://agenpas.example', secret: SECRET });
    assert.equal(verdict.ok, true, 'the fragment survived the money filter intact');
    assert.equal(verdict.claims.agentId, SESSION.agent_id);
    assert.equal(verdict.claims.userRef, SESSION.user_ref);
    assert.equal(out.expires_at, new Date(Math.min(Date.parse(deadline), tokenExp(out.continue_url) * 1000)).toISOString());
    // continue_url sits where the envelope always puts it, right after status.
    const keys = Object.keys(out);
    assert.equal(keys[keys.indexOf('status') + 1], 'continue_url');
    const msg = out.messages.find((x) => x.code === `reap.${state}`);
    assert.match(msg.content, /AgenPas/);
    assert.equal(msg.path, '$.continue_url');
    assert.equal(out.messages.some((x) => x.code === 'reap.hosted_page_not_ready'), false);
    if (state === 'awaiting_approval') assert.equal(out.messages.find((x) => x.code === 'reap.approval_deadline').content, out.expires_at);
  }
});

test('the link outlives a short step: expires_at is the step\'s own deadline', async () => {
  const deadline = inMinutes(4);
  const { ucp, id } = await build(gatedView('awaiting_approval', deadline));
  const out = await withEnv(GATE_ON, () => ucp.callTool('get_checkout', { meta: META, id }, SESSION));
  assert.equal(out.expires_at, new Date(Date.parse(deadline)).toISOString());
});

test('a link shorter than the step (60 s), expires_at is the link\'s own expiry, not the step\'s', async () => {
  const deadline = inMinutes(10);
  const { ucp, id } = await build(gatedView('needs_enrollment', deadline));
  const out = await withEnv({ ...GATE_ON, AGENPAS_LINK_TTL_SECONDS: '60' }, () => ucp.callTool('get_checkout', { meta: META, id }, SESSION));
  assert.equal(out.status, 'requires_escalation');
  assert.equal(out.expires_at, new Date(tokenExp(out.continue_url) * 1000).toISOString());
  assert.ok(Date.parse(out.expires_at) < Date.parse(deadline));
});

test('gate off (any of its parts): the gated view answers exactly as before (incomplete, page not ready, no link)', async () => {
  for (const env of [
    { ...GATE_ON, AGENPAS_CONSENT_ENABLED: undefined }, { ...GATE_ON, AGENPAS_RAILS: undefined }, { ...GATE_ON, AGENPAS_RAILS: 'a2a' },
    { ...GATE_ON, AGENPAS_ENABLED: undefined }, { ...GATE_ON, AGENPAS_LINK_SECRET: undefined },
  ]) {
    const v = gatedView('needs_enrollment');
    const { ucp, id } = await build(v);
    const bare = await build(v, { withMinter: false });
    const out = await withEnv(env, () => ucp.callTool('get_checkout', { meta: META, id }, SESSION));
    const base = await withEnv(env, () => bare.ucp.callTool('get_checkout', { meta: META, id }, SESSION));
    assert.equal(stable(out), stable(base), JSON.stringify(env));
    assert.equal(out.status, 'incomplete');
    assert.equal(Object.hasOwn(out, 'continue_url'), false);
    assert.ok(out.messages.some((x) => x.code === 'reap.hosted_page_not_ready'));
  }
});

test('gate on but nothing gated: a hosted Reap page (consent given) is answered exactly as before', async () => {
  const v = view('awaiting_approval', { hosted_url: PAGE, hosted_url_expires_at: inMinutes(15), approval_deadline: inMinutes(5) });
  const { ucp, id } = await build(v);
  const bare = await build(v, { withMinter: false });
  const on = await withEnv(GATE_ON, () => ucp.callTool('get_checkout', { meta: META, id }, SESSION));
  const off = await withEnv(LANE_ON, () => bare.ucp.callTool('get_checkout', { meta: META, id }, SESSION));
  assert.equal(on.continue_url, PAGE);
  assert.equal(JSON.stringify(on), JSON.stringify(off));
});

test('gate on: no swap for a passed deadline, another step\'s marker, no verified agent, a held or paused purchase', async () => {
  const cases = [
    ['passed deadline', gatedView('awaiting_approval', inMinutes(-1)), SESSION],
    ['wrong kind', view('needs_enrollment', { buyer_step: { kind: 'approval', expires_at: inMinutes(10), consent_required: true } }), SESSION],
    ['no marker', view('needs_enrollment'), SESSION],
    ['held', gatedView('awaiting_approval', inMinutes(10), { last_error_code: 'checkout_read_permanent:1:reap_status_404' }), SESSION],
    ['review', gatedView('awaiting_approval', inMinutes(10), { last_error_code: 'checkout_dispatch_unresolved' }), SESSION],
    ['paused', gatedView('needs_enrollment', inMinutes(10), { contact_reentry_required: true }), SESSION],
    ['no agent id', gatedView('needs_enrollment'), { user_ref: SESSION.user_ref, acp_session_id: SESSION.acp_session_id }],
  ];
  for (const [name, v, session] of cases) {
    const { ucp, id } = await build(v);
    const bare = await build(v, { withMinter: false });
    const out = await withEnv(GATE_ON, () => ucp.callTool('get_checkout', { meta: META, id }, session));
    const base = await withEnv(LANE_ON, () => bare.ucp.callTool('get_checkout', { meta: META, id }, session));
    assert.equal(out.status, 'incomplete', name);
    assert.equal(Object.hasOwn(out, 'continue_url'), false, name);
    assert.equal(stable(out), stable(base), name);
  }
});

test('mapReapPurchaseToCheckout: without agenpasConsent the gated view maps exactly as before; the URL is never put in by the lane', async () => {
  const m = await mods();
  const v = gatedView('needs_enrollment');
  const id = m.lane.encodeReapCheckoutId(SNAP);
  const now = Date.now();
  const before = m.lane.mapReapPurchaseToCheckout({ id, snapshot: SNAP, view: v, now, env: {} });
  const captured = { url: null };
  const swapped = m.lane.mapReapPurchaseToCheckout({ id, snapshot: SNAP, view: v, now, env: {},
    agenpasConsent: { link: () => ({ url: 'https://agenpas.example/agenpas/p/x#t=v1.a.b', expiresAt: Math.floor(now / 1000) + 1800 }), captured } });
  assert.equal(before.status, 'incomplete');
  assert.equal(swapped.status, 'requires_escalation');
  assert.equal(Object.hasOwn(swapped, 'continue_url'), false, 'the door adds it after the money filter');
  assert.equal(captured.url, 'https://agenpas.example/agenpas/p/x#t=v1.a.b');
  // A minter that cannot mint: the old answer.
  const failed = m.lane.mapReapPurchaseToCheckout({ id, snapshot: SNAP, view: v, now, env: {}, agenpasConsent: { link: () => null, captured: { url: null } } });
  assert.equal(stable(failed), stable(before));
});

test('tools/list: byte-identical with the gate off; create_checkout gains ONE sentence while it is on (and the lane creates)', async () => {
  const m = await mods();
  const { ucp } = await build(view('resolving'));
  const bare = await build(view('resolving'), { withMinter: false });
  const list = (s) => JSON.stringify(s.ucp.tools);
  for (const env of [LANE_ON, { ...GATE_ON, AGENPAS_CONSENT_ENABLED: undefined }, { ...GATE_ON, AGENPAS_RAILS: 'a2a' }, { ...GATE_ON, AGENPAS_ENABLED: '0' }]) {
    await withEnv(env, () => assert.equal(list({ ucp }), list(bare), JSON.stringify(env)));
  }
  await withEnv({ ...GATE_ON, REAP_AGENTIC_LANE_ENABLED: undefined }, () => assert.equal(list({ ucp }), list(bare), 'lane off'));
  await withEnv(GATE_ON, () => {
    const on = ucp.tools;
    const off = bare.ucp.tools;
    assert.equal(on.length, off.length);
    for (let i = 0; i < on.length; i += 1) {
      if (on[i].name === 'create_checkout') assert.equal(on[i].description, `${off[i].description} ${m.surface.AGENPAS_UCP_REAP_CONSENT_SENTENCE}`);
      else assert.equal(JSON.stringify(on[i]), JSON.stringify(off[i]), on[i].name);
    }
  });
});

test('a hosted_url that is PRESENT but not one this door may hand out is never swapped for the AgenPas link', async () => {
  const v = gatedView('awaiting_approval', inMinutes(10), { hosted_url: 'https://elsewhere.example/checkout/1', hosted_url_expires_at: inMinutes(15) });
  const { ucp, id } = await build(v);
  const out = await withEnv(GATE_ON, () => ucp.callTool('get_checkout', { meta: META, id }, SESSION));
  assert.equal(out.status, 'incomplete');
  assert.equal(Object.hasOwn(out, 'continue_url'), false);
  assert.equal(JSON.stringify(out).includes('agenpas.example'), false);
});

test('each mapping starts with no captured link: a stale capture from an earlier mapping is cleared', async () => {
  const m = await mods();
  const captured = { url: 'https://agenpas.example/agenpas/p/stale#t=v1.a.b' };
  const out = m.lane.mapReapPurchaseToCheckout({ id: m.lane.encodeReapCheckoutId(SNAP), snapshot: SNAP, view: view('quoting'), now: Date.now(), env: {},
    agenpasConsent: { link: () => { throw new Error('not asked'); }, captured } });
  assert.equal(out.status, 'incomplete');
  assert.equal(captured.url, null);
});

test('the door puts the captured link ONLY on a requires_escalation answer without a continue_url of its own', async () => {
  const m = await mods();
  const url = 'https://agenpas.example/agenpas/p/rp#t=v1.a.b';
  const base = { ucp: {}, id: 'reap_x', status: 'requires_escalation', currency: 'USD', messages: [] };
  assert.deepEqual(Object.keys(m.surface.withConsentContinueUrl(base, url)), ['ucp', 'id', 'status', 'continue_url', 'currency', 'messages']);
  for (const [name, checkout] of [
    ['incomplete (degraded)', { ...base, status: 'incomplete' }], ['complete_in_progress', { ...base, status: 'complete_in_progress' }],
    ['its own continue_url', { ...base, continue_url: 'https://pay.prava.space/x' }],
  ]) {
    assert.equal(m.surface.withConsentContinueUrl(checkout, url), checkout, name);
  }
  assert.equal(m.surface.withConsentContinueUrl(base, null), base);
  assert.equal(m.surface.withConsentContinueUrl(base, ''), base);
});
