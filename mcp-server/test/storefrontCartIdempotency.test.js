// A RETRIED STOREFRONT CREATE RETURNS THE SAME CHECKOUT (AGENT_CHECKOUT_STORE_CART_IDEMPOTENCY_ENABLED): the ledger
// itself and the lane. The doors end to end: tests/store_cart_idempotency_door.node.test.cjs.
//
// Pinned here: the switch; what "the same request" is (the market included); THE SCOPE (door, partner, buyer,
// session, key), that a call with no partner or no session is never deduplicated, and that which keys are accepted
// is the shared intake rule's alone (this path holds no rule of its own, on a first build or on a replay);
// what is stored and that only the same scope can open it; one build under concurrency, the loser reading the winner's checkout; the terminal
// refusal for another request under the key; the retriable answer while the first is still building; fail open,
// counted, when there is no store or the store fails; a build that hands out nothing leaves no record.

import { test, describe, beforeEach } from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

import {
  STORE_CART_IDEMPOTENCY_FLAG, CLAIM_LEASE_MS, KEY_REUSED_REASON, IN_FLIGHT_REASON, STORE_CART_IDEMPOTENCY_NAMESPACE,
  partnerPrincipalOf,
  storeCartIdempotencyEnabled, storeCartIdempotencyCounts, resetStoreCartIdempotencyCountsForTest,
  canonicalRequest, requestFingerprint, recordKey, sealCheckoutId, openCheckoutId, runIdempotentCart, storedFingerprint,
} from '../src/storefrontCartIdempotency.js';
import { MERCHANT_PRICING_FLAG } from '../src/ucpMerchantDoorPricing.js';
import { UCP_ESCALATION_FLAG, ESCALATION_TTL_MS, ID_BINDING_SECRET_ENV, tryEscalateUcpCheckout, storeCartIdempotencyKey } from '../src/ucpCheckoutEscalation.js';
import { InMemoryKvStore } from '../../safety-kernel/src/stores.js';
import { createCommerceMount } from '../../safety-kernel/src/mount.js';
import { PivotaCommerceError } from '../../safety-kernel/src/errors.js';
import {
  IDEMPOTENCY_KEY_MIN_LENGTH, IDEMPOTENCY_KEY_TOO_SHORT_REASON, IDEMPOTENCY_KEY_BAD_CHARACTERS_REASON,
  assertIdempotencyKeyAcceptable, surfaceableIntakeRefusal,
} from '../../safety-kernel/src/protocol/buyerIntake.js';
import * as ledgerModule from '../src/storefrontCartIdempotency.js';

// What the shared intake rule answers for a key it refuses: the code a missing key gets, a reason of its own, never
// retriable, and a detail that states the bound and nothing from the request.
const refusedAs = (reason) => (err) => {
  assert.ok(err instanceof PivotaCommerceError, String(err));
  assert.equal(err.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(err.retriable, false);
  assert.equal(err.detail.reason, reason);
  // What a door surfaces for it.
  assert.deepEqual(surfaceableIntakeRefusal(err).detail, reason === IDEMPOTENCY_KEY_TOO_SHORT_REASON
    ? { reason: 'idempotency_key_too_short', min_length: 8 }
    : { reason: 'idempotency_key_bad_characters', accepted_characters: 'printable ASCII, U+0020 to U+007E' });
  return true;
};
const TOO_SHORT = refusedAs(IDEMPOTENCY_KEY_TOO_SHORT_REASON);
const BAD_CHARACTERS = refusedAs(IDEMPOTENCY_KEY_BAD_CHARACTERS_REASON);

const PARTNER_A = partnerPrincipalOf({ kind: 'agent', sub: 'agent_partner_a' });
const PARTNER_B = partnerPrincipalOf({ kind: 'agent', sub: 'agent_partner_b' });
const SECRET = 'unit-test-secret-0123456789';
const SERVER_KEY = storeCartIdempotencyKey({ [ID_BINDING_SECRET_ENV]: SECRET });
const SCOPE = Object.freeze({ door: 'ucp', partner: PARTNER_A, userRef: 'buyer-0001', sessionId: 'sess-0001', rawKey: 'idem-key-0001', serverKey: SERVER_KEY });
// Every scope that differs from SCOPE in exactly one member.
const OTHER_SCOPES = Object.freeze({
  'another buyer': { ...SCOPE, userRef: 'buyer-0002' },
  'another key': { ...SCOPE, rawKey: 'idem-key-0002' },
  'another door': { ...SCOPE, door: 'mcp' },
  'another partner': { ...SCOPE, partner: PARTNER_B },
  'another session': { ...SCOPE, sessionId: 'sess-0002' },
  'another server secret': { ...SCOPE, serverKey: storeCartIdempotencyKey({ [ID_BINDING_SECRET_ENV]: 'another-secret-0123456789' }) },
});
const FP = requestFingerprint(canonicalRequest({ items: [{ product_id: 'p1', quantity: 1 }], market: 'US' }));
const ID = 'esc_eyJ2IjoyfQ';
const TTL = 6 * 60 * 60 * 1000;

beforeEach(() => resetStoreCartIdempotencyCountsForTest());

function harness({ store = new InMemoryKvStore(), buildMs = 0, id = ID } = {}) {
  const calls = { build: 0, replay: [] };
  const run = (over = {}) => runIdempotentCart({
    store, scope: SCOPE, fingerprint: FP, ttlMs: TTL, now: () => 1000,
    build: async () => {
      calls.build += 1;
      if (buildMs) await new Promise((r) => setTimeout(r, buildMs));
      return { answer: { id, built: calls.build }, id };
    },
    replay: async (storedId, createdAt) => { calls.replay.push([storedId, createdAt]); return { id: storedId, replayed: true }; },
    pollMs: 5,
    ...over,
  });
  return { store, calls, run };
}

describe('the switch and the constants', () => {
  test('values', () => {
    assert.equal(STORE_CART_IDEMPOTENCY_FLAG, 'AGENT_CHECKOUT_STORE_CART_IDEMPOTENCY_ENABLED');
    for (const v of ['1', 'true', 'on', 'YES']) assert.equal(storeCartIdempotencyEnabled({ [STORE_CART_IDEMPOTENCY_FLAG]: v }), true);
    for (const v of ['', '0', 'off', 'enabled', undefined]) assert.equal(storeCartIdempotencyEnabled({ [STORE_CART_IDEMPOTENCY_FLAG]: v }), false);
  });
  test('a record lives as long as the checkout id says it does; a claim outlives the slowest create', () => {
    assert.equal(ESCALATION_TTL_MS, TTL);
    assert.ok(CLAIM_LEASE_MS >= 3000 + 1000 + 5000 + 2000 + 5000);
  });
  test('the store is the kernel\'s own backing, in a namespace of its own', async () => {
    const mount = createCommerceMount({ upstream: async () => ({}), secret: 'x'.repeat(32), strict: false });
    const store = mount.stateStore(STORE_CART_IDEMPOTENCY_NAMESPACE);
    assert.equal(typeof store.putIfAbsent, 'function');
    assert.equal(store.durable, false, 'in-process only where the kernel itself is');
    const queries = [];
    const durable = createCommerceMount({ upstream: async () => ({}), secret: 'x'.repeat(32), strict: false, db: { query: async (text, params) => { queries.push(params); return { rows: [] }; } } });
    const shared = durable.stateStore(STORE_CART_IDEMPOTENCY_NAMESPACE);
    assert.equal(shared.durable, true);
    await shared.get('k');
    assert.ok(queries[0].includes(STORE_CART_IDEMPOTENCY_NAMESPACE));
  });
});

describe('the same request', () => {
  const base = { items: [{ product_id: 'p1', quantity: 2, variant_id: 'v1' }, { product_id: 'p2', quantity: 1 }], market: 'US', marketAssumed: false, discountCodes: [['SAVE10'], null], sellerNamed: 'seller-a', expectedSeller: undefined };
  const fp = (over) => requestFingerprint(canonicalRequest({ ...base, ...over }));
  test('line order does not matter; everything else does', () => {
    assert.equal(fp({ items: [...base.items].reverse() }), fp({}));
    const different = {
      'a quantity': { items: [{ product_id: 'p1', quantity: 3, variant_id: 'v1' }, base.items[1]] },
      'a variant': { items: [{ product_id: 'p1', quantity: 2, variant_id: 'v2' }, base.items[1]] },
      'no variant': { items: [{ product_id: 'p1', quantity: 2 }, base.items[1]] },
      'a product': { items: [base.items[0], { product_id: 'p3', quantity: 1 }] },
      'one line fewer': { items: [base.items[0]] },
      'the market': { market: 'GB' },
      'an assumed market': { marketAssumed: true },
      'no market': { market: null },
      'a discount code': { discountCodes: [['SAVE20'], null] },
      'no discount code': { discountCodes: [null, null] },
      'the seller named': { sellerNamed: 'seller-b' },
      'an expected seller': { expectedSeller: 'shop-a.example.com' },
    };
    for (const [name, over] of Object.entries(different)) assert.notEqual(fp(over), fp({}), name);
  });
  test('a GB cart and a US cart are never the same request', () => {
    assert.notEqual(fp({ market: 'GB' }), fp({ market: 'US' }));
    assert.equal(canonicalRequest({ ...base, market: 'GB' }).market, 'GB');
  });
  test('nothing of the buyer is in it', () => {
    assert.deepEqual(Object.keys(canonicalRequest(base)), ['v', 'lines', 'market', 'market_assumed', 'discount_codes', 'seller_named', 'expected_seller']);
  });
});

describe('what is stored', () => {
  test('the key names neither the buyer nor the key; the id is sealed to the same door, partner, buyer, session and key', async () => {
    const h = harness();
    await h.run();
    const key = recordKey(SCOPE);
    assert.match(key, /^sci1_[0-9a-f]{64}$/);
    const record = await h.store.get(key);
    assert.deepEqual(Object.keys(record).sort(), ['created_at', 'fp', 'sealed', 'status']);
    assert.equal(record.status, 'done');
    const stored = JSON.stringify([key, record]);
    // The request digest is stored KEYED: not the plain digest, and not computable from the request and scope alone.
    assert.equal(record.fp, storedFingerprint(SCOPE, FP));
    assert.notEqual(record.fp, FP);
    assert.match(record.fp, /^[0-9a-f]{64}$/);
    assert.equal(record.fp, crypto.createHmac('sha256', SERVER_KEY).update(`fp|${FP}|${JSON.stringify([SCOPE.door, SCOPE.partner, SCOPE.userRef, SCOPE.sessionId, SCOPE.rawKey])}`, 'utf8').digest('hex'));
    assert.equal(stored.includes(FP), false, 'the plain request digest is nowhere in the row');
    for (const [name, other] of Object.entries(OTHER_SCOPES)) assert.notEqual(storedFingerprint(other, FP), record.fp, name);
    assert.throws(() => storedFingerprint({ ...SCOPE, serverKey: null }, FP), /no server key/);
    for (const secret of [SCOPE.userRef, SCOPE.rawKey, SCOPE.sessionId, 'agent_partner_a', ID]) assert.equal(stored.includes(secret), false, secret);
    assert.equal(openCheckoutId(record.sealed, SCOPE), ID);
    for (const [name, other] of Object.entries(OTHER_SCOPES)) {
      assert.equal(openCheckoutId(record.sealed, other), null, name);
      assert.notEqual(recordKey(other), key, name);
    }
    assert.equal(openCheckoutId('not.a.record', SCOPE), null);
    assert.notEqual(sealCheckoutId(ID, SCOPE), sealCheckoutId(ID, SCOPE), 'a fresh nonce per record');
  });
  test('UNDER A SERVER SECRET: neither the record key nor the seal can be computed from the scope alone', async () => {
    const h = harness();
    await h.run();
    const [[storedKey, entry]] = [...h.store._m.entries()];
    const record = entry.value ?? entry;
    assert.equal(storedKey, recordKey(SCOPE));
    // What a reader of the table who knows (door, partner, buyer, session, key) could compute with no secret:
    // every plain digest of the scope, in the spellings this module has used.
    const members = [SCOPE.door, SCOPE.partner, SCOPE.userRef, SCOPE.sessionId, SCOPE.rawKey];
    const guesses = [JSON.stringify(members), JSON.stringify([SCOPE.door, SCOPE.userRef, SCOPE.rawKey])];
    for (const guess of guesses) {
      for (const purpose of ['key', 'seal']) {
        const digest = crypto.createHash('sha256').update(`${purpose}|${guess}`, 'utf8').digest();
        assert.notEqual(storedKey, `sci1_${digest.toString('hex')}`);
        // The seal does not open under a key made of the scope alone.
        const [iv, body, tag] = String(record.sealed).split('.').map((part) => Buffer.from(part, 'base64url'));
        assert.throws(() => {
          const d = crypto.createDecipheriv('aes-256-gcm', digest, iv);
          d.setAuthTag(tag);
          Buffer.concat([d.update(body), d.final()]);
        });
      }
    }
    // The keys are exactly the HMACs under the derived server key, with a purpose each.
    const hmac = (purpose) => crypto.createHmac('sha256', SERVER_KEY).update(`${purpose}|${JSON.stringify(members)}`, 'utf8').digest();
    assert.equal(storedKey, `sci1_${hmac('key').toString('hex')}`);
    const [iv, body, tag] = String(record.sealed).split('.').map((part) => Buffer.from(part, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', hmac('seal'), iv);
    d.setAuthTag(tag);
    assert.equal(Buffer.concat([d.update(body), d.final()]).toString('utf8'), ID);
  });
  test('the server key: derived from the kernel\'s secret with a label of its own; null without a usable secret', () => {
    assert.equal(ID_BINDING_SECRET_ENV, 'CONFIRMATION_SECRET');
    assert.ok(Buffer.isBuffer(SERVER_KEY) && SERVER_KEY.length === 32);
    assert.deepEqual(SERVER_KEY, crypto.createHmac('sha256', SECRET).update('storefront-cart-idempotency/v1', 'utf8').digest());
    // Not the id binding's key, and not the raw secret.
    assert.notDeepEqual(SERVER_KEY, crypto.createHmac('sha256', SECRET).update('storefront-cart-id-binding/v1', 'utf8').digest());
    assert.notDeepEqual(SERVER_KEY, crypto.createHash('sha256').update(SECRET).digest());
    for (const env of [{}, { CONFIRMATION_SECRET: '' }, { CONFIRMATION_SECRET: 'short' }, { CONFIRMATION_SECRET: 'x'.repeat(15) }, { CONFIRMATION_SECRET: 7 }, null]) {
      assert.equal(storeCartIdempotencyKey(env), null, JSON.stringify(env));
    }
    assert.ok(storeCartIdempotencyKey({ CONFIRMATION_SECRET: 'x'.repeat(16) }));
  });
  test('NO KEY, NO RECORD: without a server key every create builds, counted, and nothing is written; the key functions refuse', async () => {
    for (const serverKey of [null, undefined, Buffer.alloc(0), Buffer.alloc(16, 1), 'a-string-not-a-key', SECRET]) {
      resetStoreCartIdempotencyCountsForTest();
      const h = harness();
      const scope = { ...SCOPE, serverKey };
      assert.deepEqual(await h.run({ scope }), { id: ID, built: 1 });
      assert.deepEqual(await h.run({ scope }), { id: ID, built: 2 });
      assert.deepEqual(h.calls.replay, []);
      assert.equal(h.store._m.size, 0);
      assert.deepEqual(storeCartIdempotencyCounts(), { 'fail_open:no_secret': 2 });
      assert.throws(() => recordKey(scope), /no server key/);
      assert.throws(() => sealCheckoutId(ID, scope), /no server key/);
      assert.equal(openCheckoutId('a.b.c', scope), null);
    }
  });
  test('a finished record expires with the checkout id; a claim with its lease', async () => {
    const ttls = [];
    const store = new InMemoryKvStore();
    const spy = { ...store, get: (k) => store.get(k), compareAndDelete: (...a) => store.compareAndDelete(...a),
      putIfAbsent: (k, v, o) => { ttls.push(['claim', o.ttlMs]); return store.putIfAbsent(k, v, o); },
      compareAndSet: (k, f, m, v, o) => { ttls.push(['done', o.ttlMs]); return store.compareAndSet(k, f, m, v, o); } };
    await harness({ store: spy }).run();
    assert.deepEqual(ttls, [['claim', CLAIM_LEASE_MS], ['done', TTL]]);
  });
});

describe('retries', () => {
  test('the same request again: built once, then read back with the id and the time of the first', async () => {
    const h = harness();
    const first = await h.run();
    const second = await h.run();
    const third = await h.run();
    assert.deepEqual(first, { id: ID, built: 1 });
    assert.deepEqual([second, third], [{ id: ID, replayed: true }, { id: ID, replayed: true }]);
    assert.equal(h.calls.build, 1);
    assert.deepEqual(h.calls.replay, [[ID, 1000], [ID, 1000]]);
    assert.deepEqual(storeCartIdempotencyCounts(), { claimed: 1, replayed: 2 });
  });

  test('another request under the key: refused, terminally, with the kernel ledger\'s code; nothing is built', async () => {
    const h = harness();
    await h.run();
    await assert.rejects(h.run({ fingerprint: 'f'.repeat(64) }), (err) => {
      assert.ok(err instanceof PivotaCommerceError);
      assert.equal(err.code, 'IDEMPOTENCY_CONFLICT');
      assert.equal(err.retriable, false);
      assert.equal(err.detail.reason, KEY_REUSED_REASON);
      return true;
    });
    assert.equal(h.calls.build, 1);
    assert.deepEqual(h.calls.replay, []);
    assert.equal(storeCartIdempotencyCounts().conflict, 1);
  });

  test('another buyer, another key or another door under the same words is a build of its own', async () => {
    const h = harness();
    await h.run();
    for (const name of ['another buyer', 'another key', 'another door']) await h.run({ scope: OTHER_SCOPES[name] });
    assert.equal(h.calls.build, 4);
    assert.deepEqual(h.calls.replay, []);
  });

  test('ANOTHER PARTNER with the same buyer and key is a build of its own, even for another request: never a replay, never a conflict', async () => {
    const h = harness();
    await h.run();
    assert.deepEqual(await h.run({ scope: OTHER_SCOPES['another partner'] }), { id: ID, built: 2 });
    // Another request under the key, for the other partner: its own record, not a conflict with the first partner's.
    const otherFp = requestFingerprint(canonicalRequest({ items: [{ product_id: 'p1', quantity: 9 }], market: 'US' }));
    const b = partnerPrincipalOf({ kind: 'agent', sub: 'agent_partner_c' });
    assert.deepEqual(await h.run({ scope: { ...SCOPE, partner: b }, fingerprint: otherFp }), { id: ID, built: 3 });
    assert.deepEqual(h.calls.replay, []);
    assert.equal(storeCartIdempotencyCounts().conflict, undefined);
    // Each partner replays its own.
    await h.run();
    await h.run({ scope: OTHER_SCOPES['another partner'] });
    assert.equal(h.calls.build, 3);
    assert.equal(h.calls.replay.length, 2);
  });

  test('ANOTHER SESSION with the same partner, buyer and key is a build of its own (as the kernel ledger scopes a key), not a conflict', async () => {
    const h = harness();
    await h.run();
    const otherFp = requestFingerprint(canonicalRequest({ items: [{ product_id: 'p1', quantity: 9 }], market: 'US' }));
    assert.deepEqual(await h.run({ scope: OTHER_SCOPES['another session'], fingerprint: otherFp }), { id: ID, built: 2 });
    assert.deepEqual(await h.run({ scope: { ...SCOPE, sessionId: 'sess-0003' } }), { id: ID, built: 3 });
    assert.deepEqual(h.calls.replay, []);
    assert.equal(storeCartIdempotencyCounts().conflict, undefined);
  });

  test('the scope cannot be re-segmented: a member holding another member\'s text is another scope', () => {
    const a = recordKey({ ...SCOPE, userRef: 'u","s', sessionId: 'x' });
    const b = recordKey({ ...SCOPE, userRef: 'u', sessionId: 's","x' });
    assert.notEqual(a, b);
  });
});

describe('the partner', () => {
  test('an agent, and an OAuth client under its issuer, each as themselves; an agent id never reads as a client', () => {
    assert.equal(partnerPrincipalOf({ kind: 'agent', sub: 'agent_partner_a' }), '["agent","agent_partner_a"]');
    assert.equal(partnerPrincipalOf({ kind: 'oauth', iss: 'https://as.example', cid: 'client-a' }), '["oauth","https://as.example","client-a"]');
    assert.notEqual(partnerPrincipalOf({ kind: 'agent', sub: 'client-a' }), partnerPrincipalOf({ kind: 'oauth', iss: 'https://as.example', cid: 'client-a' }));
    assert.notEqual(partnerPrincipalOf({ kind: 'oauth', iss: 'https://as.example', cid: 'client-a' }), partnerPrincipalOf({ kind: 'oauth', iss: 'https://other.example', cid: 'client-a' }));
  });
  test('no partner: null, for every shape that names none', () => {
    for (const none of [null, undefined, '', 'agent_partner_a', {}, { kind: 'agent' }, { kind: 'agent', sub: ' ' }, { kind: 'oauth', cid: 'client-a' }, { kind: 'oauth', iss: 'https://as.example' }, { kind: 'service', sub: 'x' }]) {
      assert.equal(partnerPrincipalOf(none), null, JSON.stringify(none));
    }
  });
  test('NEVER ACROSS AN UNKNOWN PRINCIPAL: no partner, or no session, builds every time, counted, and writes nothing', async () => {
    for (const [stage, scope] of [['no_partner', { ...SCOPE, partner: null }], ['no_partner', { ...SCOPE, partner: '' }], ['no_partner', { ...SCOPE, partner: undefined }], ['no_session', { ...SCOPE, sessionId: null }], ['no_session', { ...SCOPE, sessionId: '' }]]) {
      resetStoreCartIdempotencyCountsForTest();
      const h = harness();
      assert.deepEqual(await h.run({ scope }), { id: ID, built: 1 });
      assert.deepEqual(await h.run({ scope }), { id: ID, built: 2 });
      assert.deepEqual(h.calls.replay, []);
      assert.deepEqual(storeCartIdempotencyCounts(), { [`fail_open:${stage}`]: 2 });
      assert.equal(h.store._m.size, 0, 'no record is written for an unknown principal');
    }
  });
});

describe('the key\'s minimum length', () => {
  test('the published minimum: 8', () => {
    // The shared intake rule's number. This module carries no minimum, no reason and no check of its own.
    assert.equal(IDEMPOTENCY_KEY_MIN_LENGTH, 8);
    assert.deepEqual(Object.keys(ledgerModule).filter((name) => /LENGTH|SHORT|LongEnough|KEY_TOO/i.test(name)), []);
  });
  test('7 characters: refused with the code a missing key gets and a reason of its own; 8: accepted', () => {
    assert.throws(() => assertIdempotencyKeyAcceptable('1234567'), TOO_SHORT);
    assert.throws(() => assertIdempotencyKeyAcceptable('a'), TOO_SHORT);
    assert.equal(assertIdempotencyKeyAcceptable('12345678'), undefined);
    // The rule is not this module's, and neither is a count of it.
    assert.deepEqual(storeCartIdempotencyCounts(), {});
  });
  test('a key outside printable ASCII is refused by name whatever its length; DEL is not printable; 8 printable characters with a space inside are accepted', () => {
    for (const key of ['cl\u00e9-0000001', '\u30ad\u30fc-0000001', 'idem\u007f0001', 'idem\u00000001', 'idem\u200b0001', '\u{1F511}\u{1F511}\u{1F511}\u{1F511}', 'idem-key\n']) {
      assert.throws(() => assertIdempotencyKeyAcceptable(key), BAD_CHARACTERS, JSON.stringify(key));
    }
    assert.equal(assertIdempotencyKeyAcceptable('idem 008'), undefined);
    assert.equal(assertIdempotencyKeyAcceptable('~!@#$%^&'), undefined);
    assert.deepEqual(storeCartIdempotencyCounts(), {});
  });

  test('a build that hands out no checkout (a decline) leaves no record: the retry builds again', async () => {
    const h = harness({ id: null });
    await h.run();
    await h.run();
    assert.equal(h.calls.build, 2);
    assert.equal(await h.store.get(recordKey(SCOPE)), undefined);
    assert.deepEqual(storeCartIdempotencyCounts(), { claimed: 2, released: 2 });
  });

  test('a build that throws releases its claim and rethrows: the retry builds again', async () => {
    const h = harness();
    const boom = new PivotaCommerceError('OUT_OF_STOCK', { reason: 'ucp_seller_out_of_stock' });
    await assert.rejects(h.run({ build: async () => { throw boom; } }), (err) => err === boom);
    assert.equal(await h.store.get(recordKey(SCOPE)), undefined);
    assert.deepEqual(await h.run(), { id: ID, built: 1 });
  });
});

describe('two creates at the same moment', () => {
  test('ONE builds; the other waits and reads the same checkout back', async () => {
    const h = harness({ buildMs: 60 });
    const answers = await Promise.all([h.run(), h.run(), h.run()]);
    assert.equal(h.calls.build, 1, 'the store is called by one create only');
    assert.deepEqual(answers.map((a) => a.id), [ID, ID, ID]);
    assert.equal(answers.filter((a) => a.replayed).length, 2);
    assert.deepEqual(storeCartIdempotencyCounts(), { claimed: 1, replayed_after_wait: 2 });
  });

  test('a different request arriving while the first builds is refused at once, not after the wait', async () => {
    const h = harness({ buildMs: 80 });
    const first = h.run();
    const started = Date.now();
    await assert.rejects(h.run({ fingerprint: 'e'.repeat(64) }), (err) => err.code === 'IDEMPOTENCY_CONFLICT' && err.detail.reason === KEY_REUSED_REASON);
    assert.ok(Date.now() - started < 60);
    await first;
    assert.equal(h.calls.build, 1);
  });

  test('the first still building when the wait ends: retriable, "retry the same request", never "start another"', async () => {
    const h = harness({ buildMs: 150 });
    const first = h.run();
    await assert.rejects(h.run({ waitMs: 30 }), (err) => {
      assert.equal(err.code, 'CHECKOUT_OUTCOME_UNKNOWN');
      assert.equal(err.retriable, true);
      assert.equal(err.detail.reason, IN_FLIGHT_REASON);
      return true;
    });
    assert.deepEqual(await first, { id: ID, built: 1 });
    assert.equal(h.calls.build, 1);
    // And the retry it asked for reads the checkout back.
    assert.deepEqual(await h.run(), { id: ID, replayed: true });
  });

  test('the winner fails: a waiting create takes the claim and builds', async () => {
    const h = harness();
    let n = 0;
    const build = async () => {
      n += 1;
      if (n === 1) { await new Promise((r) => setTimeout(r, 40)); throw new Error('first attempt failed'); }
      return { answer: { id: ID, built: n }, id: ID };
    };
    const [a, b] = await Promise.allSettled([h.run({ build }), h.run({ build })]);
    assert.equal(a.status, 'rejected');
    assert.deepEqual(b.value, { id: ID, built: 2 });
  });
});

describe('fail open, counted', () => {
  const broken = (failing) => {
    const store = new InMemoryKvStore();
    const wrap = (name) => (...a) => (failing.includes(name) ? Promise.reject(new Error('store down')) : store[name](...a));
    return { get: wrap('get'), putIfAbsent: wrap('putIfAbsent'), compareAndSet: wrap('compareAndSet'), compareAndDelete: wrap('compareAndDelete') };
  };
  test('no store wired: every create builds, as before the switch existed', async () => {
    const h = harness();
    assert.deepEqual(await h.run({ store: undefined }), { id: ID, built: 1 });
    assert.deepEqual(await h.run({ store: undefined }), { id: ID, built: 2 });
    assert.deepEqual(storeCartIdempotencyCounts(), { 'fail_open:no_store': 2 });
  });
  test('the claim cannot be written: the create builds', async () => {
    const h = harness({ store: broken(['putIfAbsent']) });
    assert.deepEqual(await h.run(), { id: ID, built: 1 });
    assert.deepEqual(await h.run(), { id: ID, built: 2 });
    assert.deepEqual(storeCartIdempotencyCounts(), { 'fail_open:claim': 2 });
  });
  test('the result cannot be written: the buyer still gets the checkout', async () => {
    const h = harness({ store: broken(['compareAndSet']) });
    assert.deepEqual(await h.run(), { id: ID, built: 1 });
    assert.deepEqual(storeCartIdempotencyCounts(), { claimed: 1, finalize_failed: 1 });
  });
  test('the record cannot be read: the create builds', async () => {
    const store = new InMemoryKvStore();
    await harness({ store }).run();
    resetStoreCartIdempotencyCountsForTest();
    const h = harness({ store: { ...broken(['get']), putIfAbsent: (...a) => store.putIfAbsent(...a) } });
    assert.deepEqual(await h.run(), { id: ID, built: 1 });
    assert.deepEqual(storeCartIdempotencyCounts(), { 'fail_open:read': 1 });
  });
  test('a record written before the request digest was keyed (a plain digest in `fp`) is never replayed: it reads as another request, refused', async () => {
    const store = new InMemoryKvStore();
    await store.putIfAbsent(recordKey(SCOPE), { fp: FP, status: 'done', sealed: sealCheckoutId(ID, SCOPE), created_at: 1 }, { ttlMs: TTL });
    const h = harness({ store });
    await assert.rejects(h.run(), (err) => err.code === 'IDEMPOTENCY_CONFLICT' && err.detail.reason === KEY_REUSED_REASON);
    assert.equal(h.calls.build, 0);
    assert.deepEqual(h.calls.replay, []);
  });
  test('a record this scope cannot open is not read back', async () => {
    const store = new InMemoryKvStore();
    await store.putIfAbsent(recordKey(SCOPE), { fp: storedFingerprint(SCOPE, FP), status: 'done', sealed: sealCheckoutId(ID, { ...SCOPE, userRef: 'someone-else' }), created_at: 1 }, { ttlMs: TTL });
    const h = harness({ store });
    assert.deepEqual(await h.run(), { id: ID, built: 1 });
    assert.deepEqual(h.calls.replay, []);
    assert.deepEqual(storeCartIdempotencyCounts(), { 'fail_open:unreadable_record': 1 });
  });
});

// ---- the lane ---------------------------------------------------------------------------------------------------

describe('the lane', () => {
  const ON = { [UCP_ESCALATION_FLAG]: '1', [MERCHANT_PRICING_FLAG]: '1', [STORE_CART_IDEMPOTENCY_FLAG]: '1', [ID_BINDING_SECRET_ENV]: SECRET };
  const GID = (n) => `gid://shopify/ProductVariant/${n}`;
  const SEED = Object.freeze({
    product_id: 'sig_idem_a', merchant_id: 'merch_obs_shop_a', title: 'Serum X', price: 25, currency: 'USD',
    external_redirect_url: 'https://shop-a.example.com/products/serum-x?variant=1',
    variants: [{ variant_id: 'sig_idem_a', source_variant_id: '44012345678901' }],
  });
  const executor = { async execute(op, params) { return op === 'get_product' ? { product: structuredClone(SEED) } : {}; } };
  function fakeDoor() {
    const calls = [];
    let seq = 0;
    const carts = new Map();
    const cart = (id, quantity) => ({ ok: true, status: 200, response: { result: { content: [{ type: 'text', text: JSON.stringify({
      id, currency: 'USD', continue_url: `https://shop-a.example.com/cart/c/${id}?key=secret-${id}`,
      line_items: [{ id: 'l0', item: { id: GID('44012345678901'), title: 'T', price: 2400 }, quantity, totals: [{ type: 'subtotal', amount: 2400 * quantity }, { type: 'total', amount: 2400 * quantity }] }],
      totals: [{ type: 'subtotal', amount: 2400 * quantity }, { type: 'total', amount: 2400 * quantity }],
    }) }] } } });
    return {
      calls,
      async endpointFor() { return 'https://shop-a.example.com/api/ucp/mcp'; },
      async createCart(_ep, args) { seq += 1; const id = `cart_${seq}`; carts.set(id, args.lineItems[0].quantity); calls.push(['create_cart', id, args.context]); await new Promise((r) => setTimeout(r, 20)); return cart(id, args.lineItems[0].quantity); },
      async getCart(_ep, id) { calls.push(['get_cart', id]); return cart(id, carts.get(id)); },
    };
  }
  const AGENT_A = { kind: 'agent', sub: 'agent_partner_a' };
  // A store that notes every call made to it.
  function watched(store) {
    store.touched = [];
    for (const method of ['get', 'has', 'set', 'putIfAbsent', 'compareAndSet', 'compareAndDelete', 'delete']) {
      if (typeof store[method] !== 'function') continue;
      const real = store[method].bind(store);
      store[method] = (...args) => { store.touched.push(method); return real(...args); };
    }
    return store;
  }
  // A finished record placed in the ledger directly, under any key at all, for the request `create` sends by
  // default: the checkout is one a create really handed out (built with the ledger off), recorded under the scope
  // the lane would use for `key`.
  async function seedRecord({ store, door, key, idempotencyDoor = 'ucp' }) {
    const made = await create({ env: { ...ON, [STORE_CART_IDEMPOTENCY_FLAG]: '' }, store, door, key: 'idem-seed-build-01', idempotencyDoor });
    await runIdempotentCart({
      store,
      scope: { door: idempotencyDoor, partner: partnerPrincipalOf(AGENT_A), userRef: 'buyer-0001', sessionId: 'sess-0001', rawKey: key.trim(), serverKey: SERVER_KEY },
      fingerprint: requestFingerprint(canonicalRequest({
        items: [{ product_id: SEED.product_id, quantity: 2 }], market: 'US', marketAssumed: false, discountCodes: [null, null],
      })),
      ttlMs: TTL, now: () => 5000,
      build: async () => ({ answer: made, id: made.id }),
      replay: async () => { throw new Error('seeding never replays'); },
    });
    return made;
  }
  const create = ({ env = ON, store, door, key = 'idem-lane-0001', quantity = 2, market = 'US', user = 'buyer-0001', session = 'sess-0001', partner = AGENT_A, email, now = 5000, idempotencyDoor }) => tryEscalateUcpCheckout({
    op: { id: 'create_checkout_session' }, ctx: { user_ref: user, ...(session ? { acp_session_id: session } : {}) },
    idempotencyPartner: typeof partner === 'function' ? partner : () => partner,
    params: { idempotency_key: key, quote: { items: [{ product_id: SEED.product_id, quantity }], ...(email ? { customer_email: email } : {}) } },
    executor, ucpArgs: market ? { checkout: { context: { address_country: market } } } : {}, env, now, merchantDoor: door, idempotencyStore: store, idempotencyDoor,
  });

  test('a retry is the same answer, member for member, from one cart; a later retry states the first expiry', async () => {
    const store = new InMemoryKvStore();
    const door = fakeDoor();
    const first = await create({ store, door, email: 'buyer@example.com' });
    const retry = await create({ store, door, email: 'buyer@example.com', now: 5000 + 60000 });
    assert.deepEqual(retry, first);
    assert.equal(retry.expires_at, new Date(5000 + ESCALATION_TTL_MS).toISOString());
    assert.deepEqual(door.calls.map((c) => c[0]), ['create_cart', 'get_cart']);
    assert.equal(retry.buyer.email, 'buyer@example.com');
  });

  test('the lane\'s record lives exactly as long as the id it hands out: six hours', async () => {
    const real = new InMemoryKvStore();
    const ttls = [];
    const store = { get: (k) => real.get(k), putIfAbsent: (k, v, o) => real.putIfAbsent(k, v, o), compareAndDelete: (...a) => real.compareAndDelete(...a),
      compareAndSet: (k, f, m, v, o) => { ttls.push(o.ttlMs); return real.compareAndSet(k, f, m, v, o); } };
    const out = await create({ store, door: fakeDoor(), now: 5000 });
    assert.deepEqual(ttls, [ESCALATION_TTL_MS]);
    assert.equal(Date.parse(out.expires_at) - 5000, ESCALATION_TTL_MS);
  });

  test('flag off: every create is a cart of its own, store or no store', async () => {
    const door = fakeDoor();
    const env = { ...ON, [STORE_CART_IDEMPOTENCY_FLAG]: '' };
    const a = await create({ env, store: new InMemoryKvStore(), door });
    const b = await create({ env, store: new InMemoryKvStore(), door });
    assert.notEqual(a.id, b.id);
    assert.deepEqual(door.calls.map((c) => c[0]), ['create_cart', 'create_cart']);
    assert.deepEqual(storeCartIdempotencyCounts(), {});
  });

  test('another quantity, or another market, under the key is refused and builds nothing', async () => {
    const store = new InMemoryKvStore();
    const door = fakeDoor();
    await create({ store, door });
    for (const over of [{ quantity: 3 }, { market: 'GB' }, { market: null }]) {
      await assert.rejects(create({ store, door, ...over }), (err) => err.code === 'IDEMPOTENCY_CONFLICT' && err.detail.reason === KEY_REUSED_REASON, JSON.stringify(over));
    }
    assert.deepEqual(door.calls.map((c) => c[0]), ['create_cart']);
  });

  test('a GB cart and a US cart under different keys are two carts, each read back as itself', async () => {
    const store = new InMemoryKvStore();
    const door = fakeDoor();
    const us = await create({ store, door, key: 'idem-lane-us', market: 'US' });
    const gb = await create({ store, door, key: 'idem-lane-gb', market: 'GB' });
    assert.notEqual(us.id, gb.id);
    assert.deepEqual(door.calls.filter((c) => c[0] === 'create_cart').map((c) => c[2].address_country), ['US', 'GB']);
    assert.equal((await create({ store, door, key: 'idem-lane-gb', market: 'GB' })).id, gb.id);
    assert.equal((await create({ store, door, key: 'idem-lane-us', market: 'US' })).id, us.id);
  });

  test('two at once: one create_cart, the same id twice', async () => {
    const store = new InMemoryKvStore();
    const door = fakeDoor();
    const [a, b] = await Promise.all([create({ store, door }), create({ store, door })]);
    assert.equal(a.id, b.id);
    assert.equal(door.calls.filter((c) => c[0] === 'create_cart').length, 1);
  });

  test('the two doors, and two buyers, do not share a key', async () => {
    const store = new InMemoryKvStore();
    const door = fakeDoor();
    const ucp = await create({ store, door });
    const mcp = await create({ store, door, idempotencyDoor: 'mcp' });
    const other = await create({ store, door, user: 'buyer-0002' });
    assert.equal(new Set([ucp.id, mcp.id, other.id]).size, 3);
    assert.equal(door.calls.filter((c) => c[0] === 'create_cart').length, 3);
  });

  test('PARTNER A THEN PARTNER B, same buyer, same session, same key, same cart: two checkouts, neither reads the other\'s', async () => {
    const store = new InMemoryKvStore();
    const door = fakeDoor();
    const a = await create({ store, door });
    const b = await create({ store, door, partner: { kind: 'agent', sub: 'agent_partner_b' } });
    const oauth = await create({ store, door, partner: { kind: 'oauth', iss: 'https://as.example', cid: 'client-a' } });
    const oauthOther = await create({ store, door, partner: { kind: 'oauth', iss: 'https://as.example', cid: 'client-b' } });
    assert.equal(new Set([a.id, b.id, oauth.id, oauthOther.id]).size, 4);
    assert.deepEqual(door.calls.map((c) => c[0]), ['create_cart', 'create_cart', 'create_cart', 'create_cart']);
    // Another cart under the key for partner B: B's own conflict, never A's business.
    await assert.rejects(create({ store, door, partner: { kind: 'agent', sub: 'agent_partner_b' }, quantity: 5 }), (err) => err.code === 'IDEMPOTENCY_CONFLICT');
    assert.equal((await create({ store, door })).id, a.id);
    assert.equal((await create({ store, door, partner: { kind: 'oauth', iss: 'https://as.example', cid: 'client-b' } })).id, oauthOther.id);
  });

  test('the same partner, buyer and key in ANOTHER SESSION: a new checkout, even for another cart; never a conflict', async () => {
    const store = new InMemoryKvStore();
    const door = fakeDoor();
    const first = await create({ store, door });
    const otherSession = await create({ store, door, session: 'sess-0002', quantity: 3 });
    const otherSessionSameCart = await create({ store, door, session: 'sess-0003' });
    assert.equal(new Set([first.id, otherSession.id, otherSessionSameCart.id]).size, 3);
    assert.equal(door.calls.filter((c) => c[0] === 'create_cart').length, 3);
    assert.equal((await create({ store, door, session: 'sess-0002', quantity: 3 })).id, otherSession.id, 'each session replays its own');
  });

  test('NO PARTNER on the call (none wired, none resolved, a reader that throws) or no session: not deduplicated, counted', async () => {
    const store = new InMemoryKvStore();
    const door = fakeDoor();
    for (const partner of [null, {}, { kind: 'agent', sub: '' }, () => { throw new Error('reader down'); }]) {
      await create({ store, door, partner });
      await create({ store, door, partner });
    }
    assert.equal(door.calls.filter((c) => c[0] === 'create_cart').length, 8);
    assert.deepEqual(storeCartIdempotencyCounts(), { 'fail_open:no_partner': 8 });
    resetStoreCartIdempotencyCountsForTest();
    await create({ store, door, session: null });
    await create({ store, door, session: null });
    assert.equal(door.calls.filter((c) => c[0] === 'create_cart').length, 10);
    assert.deepEqual(storeCartIdempotencyCounts(), { 'fail_open:no_session': 2 });
    assert.equal(store._m.size, 0);
  });

  test('THE SECRET UNSET, OR TOO SHORT, with the flag on: the create is answered, not deduplicated, counted; no record is written', async () => {
    for (const secret of [undefined, '', 'x'.repeat(15)]) {
      resetStoreCartIdempotencyCountsForTest();
      const store = new InMemoryKvStore();
      const door = fakeDoor();
      const env = { ...ON, [ID_BINDING_SECRET_ENV]: secret };
      const a = await create({ env, store, door });
      const b = await create({ env, store, door });
      assert.ok(a.id && b.id);
      assert.notEqual(a.id, b.id);
      assert.deepEqual(door.calls.map((c) => c[0]), ['create_cart', 'create_cart']);
      assert.equal(store._m.size, 0);
      assert.deepEqual(storeCartIdempotencyCounts(), { 'fail_open:no_secret': 2 });
    }
  });

  test('another secret is another key space: a record written under one is not found under another (a rotation builds anew)', async () => {
    const store = new InMemoryKvStore();
    const door = fakeDoor();
    const first = await create({ store, door });
    const rotated = await create({ env: { ...ON, [ID_BINDING_SECRET_ENV]: 'another-secret-0123456789' }, store, door });
    assert.notEqual(rotated.id, first.id);
    assert.equal((await create({ store, door })).id, first.id);
    assert.equal(door.calls.filter((c) => c[0] === 'create_cart').length, 2);
  });

  test('A RECORD MADE BEFORE THE CURRENCY RULE IS JUDGED AGAIN, NEVER SERVED: a GB cart of a USD seller, on either door\'s scope', async () => {
    const RULE = 'AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET';
    for (const idempotencyDoor of ['ucp', 'mcp']) {
      resetStoreCartIdempotencyCountsForTest();
      const store = new InMemoryKvStore();
      const door = fakeDoor();
      const before = await create({ store, door, market: 'GB', idempotencyDoor });
      assert.equal(before.currency, 'USD', 'before the rule: answered in the seller\'s currency');
      assert.equal(store._m.size, 1);
      // The rule on: the same create, the same key.
      const on = { ...ON, [RULE]: '1' };
      await assert.rejects(create({ env: on, store, door, market: 'GB', idempotencyDoor }),
        (err) => err.code === 'NO_MERCHANT_OFFER' && err.detail.reason === 'seller_not_priced_in_market_currency', idempotencyDoor);
      assert.deepEqual(door.calls.map((c) => c[0]), ['create_cart'], 'the recorded cart is not even read back from the seller');
      // The record was found (a replay was attempted) and what it holds was refused, not served.
      assert.deepEqual(storeCartIdempotencyCounts(), { claimed: 1, replayed: 1 });
      // A US cart of the same seller replays under the rule, member for member.
      const us = await create({ store, door, key: 'idem-lane-us-01', idempotencyDoor });
      assert.deepEqual(await create({ env: on, store, door, key: 'idem-lane-us-01', idempotencyDoor }), us);
      // A create the rule refuses records nothing: the same key builds once the rule is off again.
      await assert.rejects(create({ env: on, store, door, market: 'GB', key: 'idem-lane-gb-02', idempotencyDoor }), (err) => err.detail.reason === 'seller_not_priced_in_market_currency');
      assert.equal(store._m.size, 2, 'no record for the refused create');
      assert.ok((await create({ store, door, market: 'GB', key: 'idem-lane-gb-02', idempotencyDoor })).id);
    }
  });

  test('a 7-character key with the flag on: refused before the gate and the store; 8 characters: built; flag off: a short key is as before', async () => {
    const store = new InMemoryKvStore();
    const door = fakeDoor();
    const gate = [];
    const shouldOfferPurchase = async (args) => { gate.push(args); return true; };
    await assert.rejects(
      tryEscalateUcpCheckout({
        op: { id: 'create_checkout_session' }, ctx: { user_ref: 'buyer-0001', acp_session_id: 'sess-0001' }, idempotencyPartner: () => AGENT_A,
        params: { idempotency_key: 'idem-07', quote: { items: [{ product_id: SEED.product_id, quantity: 1 }] } },
        executor, ucpArgs: { checkout: { context: { address_country: 'US' } } }, env: ON, now: 5000, merchantDoor: door, idempotencyStore: store, shouldOfferPurchase,
      }),
      TOO_SHORT,
    );
    assert.deepEqual([door.calls.length, gate.length, store._m.size], [0, 0, 0]);
    // A short key is refused whoever calls: the rule is the key's, not the scope's.
    await assert.rejects(create({ store, door, key: 'idem-07', partner: null }), TOO_SHORT);
    await assert.rejects(create({ store, door, key: '  1234567  ' }), TOO_SHORT, 'surrounding blanks do not count');
    assert.equal(door.calls.length, 0);
    assert.ok((await create({ store, door, key: 'idem-008' })).id);
    // Flag off: THIS FUNCTION does not use the key at all, so it does not judge it (as before). The doors do, for
    // every mutating call, before they call this (tests/store_cart_idempotency_scope_door.node.test.cjs).
    const off = { ...ON, [STORE_CART_IDEMPOTENCY_FLAG]: '' };
    assert.ok((await create({ env: off, store, door, key: 'abc' })).id);
    assert.equal(door.calls.filter((c) => c[0] === 'create_cart').length, 2);
    assert.deepEqual(storeCartIdempotencyCounts(), { claimed: 1 }, 'no count of a refused key on this path');
  });

  test('a key outside printable ASCII, on either door\'s scope: refused by name before the gate, the store and the ledger; the key is judged as sent, not as trimmed', async () => {
    for (const env of [ON]) {
      for (const idempotencyDoor of ['ucp', 'mcp']) {
        const store = watched(new InMemoryKvStore());
        const door = fakeDoor();
        // Each long enough, so none is short: a letter outside ASCII, DEL, a control character, an invisible
        // format character, and a no-break space around a key that would be long enough once trimmed.
        for (const key of ['cl\u00e9-lane-0001', 'idem\u007flane-01', 'idem\u0001lane-01', 'idem\u200blane-01', '\u00a0idem-lane-01\u00a0']) {
          await assert.rejects(create({ env, store, door, key, idempotencyDoor }), BAD_CHARACTERS, JSON.stringify(key));
        }
        assert.deepEqual([door.calls.length, store.touched.length, store._m.size], [0, 0, 0]);
      }
    }
    assert.deepEqual(storeCartIdempotencyCounts(), {});
  });

  test('A REPLAY IS JUDGED BY THE SHARED KEY RULE TOO: a record that exists under a key the rule refuses is never looked up, never served', async () => {
    for (const idempotencyDoor of ['ucp', 'mcp']) {
      resetStoreCartIdempotencyCountsForTest();
      const store = watched(new InMemoryKvStore());
      const door = fakeDoor();
      // THE CONTROL: a record seeded this way under an acceptable key IS a replay (so the seeding below is faithful).
      const seeded = await seedRecord({ store, door, key: 'idem-seeded-01', idempotencyDoor });
      const callsAfterSeed = door.calls.length;
      const replayed = await create({ store, door, key: 'idem-seeded-01', idempotencyDoor });
      assert.equal(replayed.id, seeded.id);
      assert.deepEqual(door.calls.slice(callsAfterSeed).map((c) => c[0]), ['get_cart']);
      assert.deepEqual(storeCartIdempotencyCounts(), { claimed: 1, replayed: 1 });
      // Records under keys the rule refuses (as a record made before the rule would be).
      for (const [key, refusal] of [['cl\u00e9-seeded-01', BAD_CHARACTERS], ['idem\u007fseeded-1', BAD_CHARACTERS], ['idem-07', TOO_SHORT]]) {
        await seedRecord({ store, door, key, idempotencyDoor });
        const before = [door.calls.length, store._m.size];
        store.touched.length = 0;
        resetStoreCartIdempotencyCountsForTest();
        await assert.rejects(create({ store, door, key, idempotencyDoor }), refusal, JSON.stringify(key));
        assert.deepEqual([door.calls.length, store._m.size], before, 'no cart is built or read back, no record written');
        assert.deepEqual(store.touched, [], 'the ledger is not asked at all');
        assert.deepEqual(storeCartIdempotencyCounts(), {});
      }
    }
  });

  test('no verified buyer or no key on the call: not deduplicated (and never thrown for)', async () => {
    const store = new InMemoryKvStore();
    const door = fakeDoor();
    await create({ store, door, user: '' });
    await create({ store, door, user: '' });
    await create({ store, door, key: '' });
    assert.equal(door.calls.filter((c) => c[0] === 'create_cart').length, 3);
  });

  test('the stored row holds no cart link, no cart id in clear, no email', async () => {
    const store = new InMemoryKvStore();
    const door = fakeDoor();
    const first = await create({ store, door, email: 'buyer@example.com' });
    const row = JSON.stringify([...store._m.entries()]);
    for (const secret of ['secret-cart_1', 'cart_1', 'buyer@example.com', 'buyer-0001', 'idem-lane-0001', 'sess-0001', 'agent_partner_a', first.id, 'shop-a.example.com']) assert.equal(row.includes(secret), false, secret);
  });
});
