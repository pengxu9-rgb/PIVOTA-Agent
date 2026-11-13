'use strict';

// THE SCOPE OF A RETRIED STOREFRONT CREATE (AGENT_CHECKOUT_STORE_CART_IDEMPOTENCY_ENABLED): door, PARTNER, buyer,
// SESSION, key. Through the real doors (tests/_support/storeCartHardeningDoor.cjs says what is real and stubbed).
//
// A buyer's `user_ref` does not name the partner. One person using two partners' agents is one `user_ref`: with an
// api key, when the partners share an identity provider; with OAuth, always (the subject is the person's, whichever
// client they authorised). Without the partner in the scope the second partner was handed the first partner's
// checkout, with the first partner's referral on its link. Pinned here:
//   - partner A then partner B, same buyer, same session, same key, same cart: two checkouts, each with its own
//     referral, each partner reading only its own hand-off;
//   - the same for two OAUTH CLIENTS of one person (a real bearer token per client, verified by the door);
//   - the same partner and buyer in another session: a new checkout, as the kernel answers, not a conflict;
//   - everything the same: the first checkout again;
//   - a call bound to no partner is never deduplicated;
//   - which keys are accepted is the shared intake rule's alone (printable ASCII, at least 8 characters): a key it
//     refuses is refused on this path and on the kernel path, with this flag on or off, with one answer.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const nock = require('nock');

const h = require('./_support/storeCartHardeningDoor.cjs');

const { IDS, AS } = h;
const ORIGINAL_ENV = { ...process.env };
const ISS = 'https://as.store-cart-scope.test';
const RESOURCE = 'https://agent.test.example/mcp';
const door = h.bootHardeningDoor({
  port: 4468,
  env: { MCP_OAUTH_ENABLED: '1', MCP_OAUTH_RESOURCE: RESOURCE, MCP_OAUTH_AUTHORIZATION_SERVERS: ISS },
});
let ledger = null;

test.before(async () => {
  await door.listen();
  ledger = await import(path.join(door.root, 'mcp-server/src/storefrontCartIdempotency.js'));
});
test.after(async () => {
  await door.close();
  process.env = { ...ORIGINAL_ENV };
});
test.beforeEach(() => { door.resetHardening(); ledger.resetStoreCartIdempotencyCountsForTest(); h.setFlags([]); });

// Every test uses keys of its own: the ledger's records outlive a test (they live six hours).
let keySeq = 7000;
const nextKey = () => (keySeq += 1);
const tools = (answer) => answer.store.filter((c) => c.kind === 'tool').map((c) => c.tool);
const errorOf = (answer) => (answer.value && answer.value.error) || null;
const decodeEsc = (id) => JSON.parse(Buffer.from(String(id).slice(4), 'base64url').toString('utf8'));
const clickOf = (url) => new URL(url).searchParams.get('pvt_click_id');
const ucp = (items, n, as, { market = 'US' } = {}) => door.call('/ucp/mcp', 'create_checkout', h.ucpCreateKeyed(items, market, n), { buyer: as });
const native = (items, n, as, { market = 'US', seller = IDS.SELLER_A } = {}) => door.call('/mcp', 'create_checkout_session', h.nativeCreate(seller, items, { market, n }), { buyer: as });
const ALL_ON = [h.IDEMPOTENCY_FLAG, h.NATIVE_DOOR_FLAG, h.REFERRAL_FLAG, h.FORWARDING_FLAG, h.HANDOFF_RECORD_FLAG, h.ATTRIBUTION_FLAG];

// ---- an OAuth caller: a bearer token the door verifies against a local key set ------------------------------------
let signingKey = null;
async function bearer(clientId, sub, session = 'mcp-sess-0001') {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  if (!signingKey) {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const pub = await exportJWK(publicKey);
    pub.kid = 'as-1';
    pub.alg = 'RS256';
    process.env.MCP_OAUTH_ISSUERS_JSON = JSON.stringify([{ iss: ISS, jwks: { keys: [pub] }, algs: ['RS256'] }]);
    require(path.join(door.root, 'src/commerceMcpOAuth.js')).__resetVerifierCache();
    signingKey = privateKey;
  }
  const token = await new SignJWT({ scope: 'pivota.checkout', token_type: 'access', client_id: clientId, email: 'buyer@example.test', email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: 'as-1' })
    .setIssuer(ISS).setAudience(RESOURCE).setSubject(sub).setIssuedAt().setExpirationTime('10m')
    .sign(signingKey);
  return { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': session, Accept: 'application/json, text/event-stream' };
}

test('the fixture: partner A and partner B can carry the SAME buyer and session', () => {
  assert.equal(AS.A['X-Test-User-Ref'], AS.A_BUYER_VIA_B['X-Test-User-Ref']);
  assert.equal(AS.A['X-Test-Acp-Session-Id'], AS.A_BUYER_VIA_B['X-Test-Acp-Session-Id']);
  assert.notEqual(AS.A['X-Agent-API-Key'], AS.A_BUYER_VIA_B['X-Agent-API-Key']);
});

test('PARTNER A THEN PARTNER B, same buyer, same key, same cart: two checkouts, each with its own referral; no cross-read', async () => {
  h.setFlags(ALL_ON);
  const n = nextKey();
  const a = await ucp([[IDS.SIG_A, 1]], n, AS.A);
  const b = await ucp([[IDS.SIG_A, 1]], n, AS.A_BUYER_VIA_B);
  assert.equal(a.isError, false, a.raw);
  assert.equal(b.isError, false, b.raw);
  // Two carts at the store, two referrals, two hand-off records: nothing of A's was handed to B.
  assert.deepEqual([tools(a), tools(b)], [['create_cart'], ['create_cart']]);
  assert.notEqual(a.value.id, b.value.id);
  assert.notEqual(decodeEsc(a.value.id).c, decodeEsc(b.value.id).c, 'two seller carts');
  assert.deepEqual([a.referral.length, b.referral.length], [1, 1]);
  assert.deepEqual([a.referral[0].assertion.payload.sub, b.referral[0].assertion.payload.sub], [h.PARTNER_A, h.PARTNER_B]);
  assert.ok(a.referral[0].assertion.ok && b.referral[0].assertion.ok);
  const [clickA, clickB] = [clickOf(a.value.continue_url), clickOf(b.value.continue_url)];
  assert.match(clickA, /^clk_/);
  assert.match(clickB, /^clk_/);
  assert.notEqual(clickA, clickB, 'each link carries its own partner\'s click');
  assert.deepEqual([a.handoff.length, b.handoff.length], [1, 1]);
  assert.deepEqual([a.handoff[0].assertion.payload.sub, b.handoff[0].assertion.payload.sub], [h.PARTNER_A, h.PARTNER_B]);
  assert.deepEqual([a.handoff[0].body.referral_click_id, b.handoff[0].body.referral_click_id], [clickA, clickB]);

  // Each partner's retry is its OWN checkout, with its own click, and mints nothing.
  const aAgain = await ucp([[IDS.SIG_A, 1]], n, AS.A);
  const bAgain = await ucp([[IDS.SIG_A, 1]], n, AS.A_BUYER_VIA_B);
  assert.deepEqual([aAgain.value.id, bAgain.value.id], [a.value.id, b.value.id]);
  assert.deepEqual([clickOf(aAgain.value.continue_url), clickOf(bAgain.value.continue_url)], [clickA, clickB]);
  assert.deepEqual([tools(aAgain), tools(bAgain)], [['get_cart'], ['get_cart']]);
  assert.deepEqual([aAgain.referral.length, bAgain.referral.length, aAgain.handoff.length, bAgain.handoff.length], [0, 0, 0, 0]);

  // Each partner's get_order reads ITS hand-off: B is never answered a linkage mismatch for the id its create got.
  const orderA = await door.call('/mcp', 'get_order', { order_id: a.value.id }, { buyer: AS.A });
  const orderB = await door.call('/mcp', 'get_order', { order_id: b.value.id }, { buyer: AS.A_BUYER_VIA_B });
  for (const [name, order] of [['A', orderA], ['B', orderB]]) {
    assert.equal(order.isError, false, `${name}: ${order.raw}`);
    assert.doesNotMatch(order.raw, /STATE_LINKAGE_MISMATCH/, name);
    assert.match(order.raw, /handed_off/, name);
  }
  assert.deepEqual(ledger.storeCartIdempotencyCounts(), { claimed: 2, replayed: 2 });
});

test('partner B with the same buyer and key but ANOTHER cart is answered its cart: never a conflict with partner A\'s', async () => {
  h.setFlags([h.IDEMPOTENCY_FLAG, h.NATIVE_DOOR_FLAG]);
  const n = nextKey();
  const a = await ucp([[IDS.SIG_A, 1]], n, AS.A);
  const b = await ucp([[IDS.SIG_A_SECOND, 2]], n, AS.A_BUYER_VIA_B);
  assert.equal(b.isError, false, b.raw);
  assert.notEqual(a.value.id, b.value.id);
  assert.deepEqual(tools(b), ['create_cart']);
  // The native door too.
  const k = nextKey();
  const na = await native([[IDS.SIG_A, 1]], k, AS.A);
  const nb = await native([[IDS.SIG_A, 1]], k, AS.A_BUYER_VIA_B);
  const nbOther = await native([[IDS.SIG_A, 4]], nextKey(), AS.A_BUYER_VIA_B);
  assert.equal(new Set([na.value.session_id, nb.value.session_id, nbOther.value.session_id]).size, 3);
  assert.deepEqual([tools(na), tools(nb)], [['create_cart'], ['create_cart']]);
  assert.equal(ledger.storeCartIdempotencyCounts().conflict, undefined);
});

test('TWO OAUTH CLIENTS OF ONE PERSON (one subject, so one user_ref), same key, same cart: two checkouts, each client replays its own', async () => {
  h.setFlags([h.IDEMPOTENCY_FLAG, h.NATIVE_DOOR_FLAG]);
  const n = nextKey();
  const clientA = await bearer('mcpc_client_a', 'person-0001');
  const clientB = await bearer('mcpc_client_b', 'person-0001');
  const a = await native([[IDS.SIG_A, 1]], n, clientA);
  assert.equal(a.isError, false, a.raw);
  assert.equal(a.value.status, 'completes_on_seller_storefront');
  const b = await native([[IDS.SIG_A, 1]], n, clientB);
  assert.equal(b.isError, false, b.raw);
  assert.notEqual(a.value.session_id, b.value.session_id);
  assert.deepEqual([tools(a), tools(b)], [['create_cart'], ['create_cart']]);
  // The same person through the same client again: that client's checkout.
  const aAgain = await native([[IDS.SIG_A, 1]], n, await bearer('mcpc_client_a', 'person-0001'));
  const bAgain = await native([[IDS.SIG_A, 1]], n, await bearer('mcpc_client_b', 'person-0001'));
  assert.deepEqual([aAgain.value.session_id, bAgain.value.session_id], [a.value.session_id, b.value.session_id]);
  assert.deepEqual([tools(aAgain), tools(bAgain)], [['get_cart'], ['get_cart']]);
  // Another cart under the key through client B: client B's own conflict, and client A's checkout is untouched.
  const bOther = await native([[IDS.SIG_A, 3]], n, clientB);
  assert.equal(errorOf(bOther).code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await native([[IDS.SIG_A, 1]], n, clientA)).value.session_id, a.value.session_id);
  assert.deepEqual(ledger.storeCartIdempotencyCounts(), { claimed: 2, replayed: 3, conflict: 1 });
});

test('the same partner, buyer and key in ANOTHER SESSION: a new checkout (as the kernel answers), not a conflict', async () => {
  h.setFlags([h.IDEMPOTENCY_FLAG, h.NATIVE_DOOR_FLAG]);
  const n = nextKey();
  const first = await ucp([[IDS.SIG_A, 1]], n, AS.A);
  const otherSessionOtherCart = await ucp([[IDS.SIG_A_SECOND, 1]], n, AS.A_OTHER_SESSION);
  assert.equal(otherSessionOtherCart.isError, false, otherSessionOtherCart.raw);
  assert.deepEqual(tools(otherSessionOtherCart), ['create_cart']);
  assert.notEqual(otherSessionOtherCart.value.id, first.value.id);
  // The same cart in a third session is a cart of its own too.
  const third = { ...AS.A, 'X-Test-Acp-Session-Id': 'sess-0010' };
  const otherSessionSameCart = await ucp([[IDS.SIG_A, 1]], n, third);
  assert.deepEqual(tools(otherSessionSameCart), ['create_cart']);
  assert.notEqual(otherSessionSameCart.value.id, first.value.id);
  // What the kernel path answers for the same shape (a connected merchant, the key reused in another session with
  // another cart): a checkout, not a conflict.
  const k = nextKey();
  const kernelCreate = (as, quantity) => native([[IDS.SOURCE_CONNECTED, quantity, IDS.VARIANT_CONNECTED]], k, as, { seller: IDS.SELLER_CONNECTED, market: undefined });
  const kernelFirst = await kernelCreate(AS.A, 1);
  const kernelOtherSession = await kernelCreate(AS.A_OTHER_SESSION, 2);
  assert.equal(kernelFirst.isError, false, kernelFirst.raw);
  assert.equal(kernelOtherSession.isError, false, kernelOtherSession.raw);
  assert.match(kernelOtherSession.value.session_id, /^q_/);
  // Each session replays its own.
  assert.equal((await ucp([[IDS.SIG_A_SECOND, 1]], n, AS.A_OTHER_SESSION)).value.id, otherSessionOtherCart.value.id);
  assert.equal((await ucp([[IDS.SIG_A, 1]], n, AS.A)).value.id, first.value.id);
  assert.equal(ledger.storeCartIdempotencyCounts().conflict, undefined);
});

test('the same partner, buyer, session, door, key and cart: the first checkout again, from one cart', async () => {
  h.setFlags([h.IDEMPOTENCY_FLAG]);
  const n = nextKey();
  const first = await ucp([[IDS.SIG_A, 2]], n, AS.A);
  const again = await ucp([[IDS.SIG_A, 2]], n, AS.A);
  assert.equal(again.raw, first.raw);
  assert.deepEqual([tools(first), tools(again)], [['create_cart'], ['get_cart']]);
});

test('NO PARTNER on the call: never deduplicated. Every create is a cart of its own, counted', async () => {
  h.setFlags([h.IDEMPOTENCY_FLAG]);
  // A caller the door admits that is bound to no partner: a key that introspects as the gateway's own service
  // identity (never asserted as a partner, src/attribution/issuingAgentAssertion.js). It has a verified buyer and
  // session, and no partner.
  const serviceKey = `ak_live_${'c3'.repeat(32)}`;
  nock('https://auth.store-cart-hardening.test').persist()
    .post('/agent/internal/auth/introspect', (body) => body && body.api_key === serviceKey)
    .reply(200, { valid: true, agent_id: 'agent_service_fallback', is_active: true, auth_source: 'api_keys' });
  const service = { ...h.BUYER, 'X-Agent-API-Key': serviceKey };
  const n = nextKey();
  const first = await ucp([[IDS.SIG_A, 1]], n, service);
  const again = await ucp([[IDS.SIG_A, 1]], n, service);
  const other = await ucp([[IDS.SIG_A, 5]], n, service);
  for (const answer of [first, again, other]) {
    assert.equal(answer.isError, false, answer.raw);
    assert.match(String(answer.value && answer.value.id), /^esc_/, answer.raw);
  }
  assert.deepEqual([tools(first), tools(again), tools(other)], [['create_cart'], ['create_cart'], ['create_cart']]);
  assert.equal(new Set([first.value.id, again.value.id, other.value.id]).size, 3);
  assert.deepEqual(ledger.storeCartIdempotencyCounts(), { 'fail_open:no_partner': 3 });
});

// What the shared intake rule answers through a door: the code a missing key gets, never retriable, the reason and
// the bound (nothing from the request). `detail` is the whole detail, so a second rule's wording cannot hide in it.
const KEY_REFUSALS = {
  short: { reason: 'idempotency_key_too_short', min_length: 8 },
  characters: { reason: 'idempotency_key_bad_characters', accepted_characters: 'printable ASCII, U+0020 to U+007E' },
};
function assertKeyRefused(answer, kind, label) {
  assert.equal(answer.isError, true, `${label}: ${answer.raw}`);
  const error = errorOf(answer);
  assert.equal(error.code, 'IDEMPOTENCY_CONFLICT', label);
  assert.equal(error.retriable, false, label);
  assert.deepEqual(error.detail, KEY_REFUSALS[kind], label);
  // Before the gate, the referral and the store.
  assert.deepEqual([answer.store.length, answer.gate.length, answer.referral.length], [0, 0, 0], label);
}
const withKey = (args, key) => ({ ...args, meta: { ...args.meta, 'idempotency-key': key } });
const ucpWithKey = (key, market = 'US') => door.call('/ucp/mcp', 'create_checkout', withKey(h.ucpCreateKeyed([[IDS.SIG_A, 1]], market, 1), key), { buyer: AS.A });
const nativeWithKey = (key, market = 'US') => door.call('/mcp', 'create_checkout_session', { ...h.nativeCreate(IDS.SELLER_A, [[IDS.SIG_A, 1]], { market, n: 1 }), idempotency_key: key }, { buyer: AS.A });

test('A 7-CHARACTER KEY is refused on the storefront path with the flag on, before the gate, the referral and the store; 8 is accepted', async () => {
  h.setFlags([h.IDEMPOTENCY_FLAG, h.NATIVE_DOOR_FLAG, h.REFERRAL_FLAG]);
  assertKeyRefused(await ucpWithKey('idem-07'), 'short', 'ucp');
  const nativeShort = await nativeWithKey('idem-07');
  assertKeyRefused(nativeShort, 'short', 'native');
  // The code a MISSING key gets on this path, not retriable.
  const missing = h.nativeCreate(IDS.SELLER_A, [[IDS.SIG_A, 1]], { market: 'US', n: 1 });
  delete missing.idempotency_key;
  const nativeMissing = await door.call('/mcp', 'create_checkout_session', missing, { buyer: AS.A });
  assert.equal(errorOf(nativeShort).code, errorOf(nativeMissing).code);
  // The refusal is the shared intake rule's: this path keeps no count of its own for it.
  assert.equal(ledger.storeCartIdempotencyCounts().key_too_short, undefined);
  assert.deepEqual(ledger.storeCartIdempotencyCounts(), {});

  const eight = await ucpWithKey('idem-008');
  assert.equal(eight.isError, false, eight.raw);
  assert.deepEqual(tools(eight), ['create_cart']);
});

test('the key rule is no path\'s and no flag\'s: a kernel checkout, and the flag off, refuse a 7-character key with the same answer', async () => {
  // THE RULE CHANGED, AND THIS TEST WITH IT (it used to pin that a kernel checkout, and the flag off, took a
  // 7-character key). The storefront path used to hold a minimum of its own, only while its flag was on. There is now ONE rule, the shared intake rule, and it is no path's and no flag's: a kernel
  // checkout, and the storefront path with the flag off, refuse a 7-character key with the same answer.
  h.setFlags([h.IDEMPOTENCY_FLAG, h.NATIVE_DOOR_FLAG]);
  const kernelCreate = (key) => door.call('/mcp', 'create_checkout_session', { ...h.nativeCreate(IDS.SELLER_CONNECTED, [[IDS.SOURCE_CONNECTED, 1, IDS.VARIANT_CONNECTED]], { n: 1 }), idempotency_key: key }, { buyer: AS.A });
  assertKeyRefused(await kernelCreate('idem-07'), 'short', 'kernel, flag on');
  const kernel = await kernelCreate('idem-008');
  assert.equal(kernel.isError, false, kernel.raw);
  assert.match(kernel.value.session_id, /^q_/);
  h.setFlags([h.NATIVE_DOOR_FLAG]);
  assertKeyRefused(await nativeWithKey('idem-07'), 'short', 'storefront, flag off, native');
  assertKeyRefused(await ucpWithKey('idem-07'), 'short', 'storefront, flag off, ucp');
  assertKeyRefused(await kernelCreate('idem-07'), 'short', 'kernel, flag off');
  const off = await nativeWithKey('idem-008');
  assert.equal(off.isError, false, off.raw);
  assert.deepEqual(tools(off), ['create_cart']);
  assert.deepEqual(ledger.storeCartIdempotencyCounts(), {});
});

test('A KEY OUTSIDE PRINTABLE ASCII is refused by name on both doors, flag on and flag off, for every market, before the gate, the referral and the store', async () => {
  // Each key is long enough, so none is refused as short: a letter outside ASCII, DEL, an invisible format
  // character. The rule is decided on the key alone, so the market cannot change it; a market is named (or left
  // out) only to show that.
  const keys = ['clé-door-0001', 'idem\u007fdoor-01', 'idem​door-01'];
  for (const flags of [[h.IDEMPOTENCY_FLAG, h.NATIVE_DOOR_FLAG, h.REFERRAL_FLAG], [h.NATIVE_DOOR_FLAG]]) {
    h.setFlags(flags);
    for (const market of ['US', 'SG', 'GB', 'DE']) {
      for (const key of keys) {
        const label = JSON.stringify([flags.length, market, key]);
        assertKeyRefused(await ucpWithKey(key, market), 'characters', `ucp ${label}`);
        assertKeyRefused(await nativeWithKey(key, market), 'characters', `native ${label}`);
      }
    }
    // No market named at all, on the door that accepts that.
    const absent = h.ucpCreateKeyed([[IDS.SIG_A, 1]], undefined, 1);
    assertKeyRefused(await door.call('/ucp/mcp', 'create_checkout', withKey(absent, keys[0]), { buyer: AS.A }), 'characters', 'ucp, no market');
  }
  assert.deepEqual(ledger.storeCartIdempotencyCounts(), {});
});
