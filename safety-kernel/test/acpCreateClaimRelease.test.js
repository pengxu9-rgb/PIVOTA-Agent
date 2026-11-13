// A FAILED ACP CREATE DOES NOT KEEP THE CALLER'S KEY.
//
// The ACP create writes a claim on (buyer, Idempotency-Key) before it calls the pricer. These tests drive the door
// over real HTTP (helpers/acpCreateDoor.js) and say, for every way a create can end after that claim is written,
// what the same key does next:
//   - a create that failed with nothing behind it gives the key back: the retry is a first create;
//   - a create whose outcome nobody can know keeps the key for its lease, answers "ask again with the same key"
//     meanwhile, and prices nothing more; after the lease the key is a first create;
//   - two creates under one key never produce two sessions, whatever the order their steps run in;
//   - a release or a finish only ever touches the claim of the attempt that makes it.
// Every interleaving is driven by gates and store hooks. Nothing waits on a real clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootAcpCreateDoor, cart, gate, T0, UNIT_MINOR, PRICER_CURRENCY, PRICER_MERCHANT_CURRENCY, MARKET_NOT_PRICED,
} from './helpers/acpCreateDoor.js';

const PORT = 5467;
const LEASE_MS = 2 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const STORES = ['memory', 'postgres'];
// The markets of a priced answer: three the pricer prices, one it refuses by name, and no destination at all.
const PRICED_MARKETS = ['US', 'SG', 'GB', null];
const currencyOf = (market) => (market === null ? PRICER_MERCHANT_CURRENCY : PRICER_CURRENCY[market]);

const UNAVAILABLE = { type: 'error', code: 'MERCHANT_UNAVAILABLE', message: 'The merchant is temporarily unreachable. Please try again shortly.' };
const OUTCOME_UNKNOWN = {
  type: 'error', code: 'CHECKOUT_OUTCOME_UNKNOWN',
  message: 'The checkout request may have been accepted. Its outcome is unknown. Keep the same request and reference when checking again; do not start another purchase.',
};
const INTERNAL = { type: 'error', code: 'INTERNAL_ERROR', message: 'The request could not be completed.' };

async function withDoor(options, fn) {
  const door = await bootAcpCreateDoor({ port: PORT, ...options });
  try { await fn(door); } finally { await door.close(); }
}
const assertOutcomeUnknown = (resp, label) => {
  assert.equal(resp.status, 409, `${label}: ${resp.text}`);
  assert.deepEqual(resp.body, OUTCOME_UNKNOWN, label);
};
/** A created (201) or replayed (200) session, priced in `market`'s currency for `quantity`. */
function assertSession(resp, status, market, quantity, label) {
  assert.equal(resp.status, status, `${label}: ${resp.text}`);
  assert.equal(resp.body.object, 'checkout_session', label);
  assert.equal(resp.body.currency, currencyOf(market), `${label}: the answer's currency is the request market's`);
  assert.equal(resp.body.totals.total, UNIT_MINOR * quantity, label);
  return resp.body.id;
}
const kernelQuotes = (door) => door.kernelStores.get('quotes')?._m.size ?? 0;
/** Wait until `request` is inside the pricer's gate. One that is answered without reaching it fails here, at once. */
const inPricer = (g, request) => Promise.race([
  g.entered,
  request.then((resp) => { throw new Error(`answered without reaching the pricer: ${resp.status} ${resp.text}`); }),
]);

// ---- 1. the reproduced defect -----------------------------------------------------------------------------------

for (const storeKind of STORES) {
  for (const market of PRICED_MARKETS) {
    test(`[${storeKind}] market ${market}: the pricer fails retriably (503); the same key then creates ONE session and replays it`, async () => {
      await withDoor({ storeKind }, async (door) => {
        const key = 'idem-retry-0001';
        door.pricer.script(() => { throw door.answered(503); });
        const failed = await door.create(cart(1, market), { key });
        assert.equal(failed.status, 503, failed.text);
        assert.deepEqual(failed.body, UNAVAILABLE, 'the failure itself is answered as it always was');
        assert.deepEqual(await door.store.claims(), [], 'the failed create holds no claim');
        assert.deepEqual(await door.store.sessions(), []);

        const created = await door.create(cart(1, market), { key });
        const id = assertSession(created, 201, market, 1, 'the retry is a first create');
        assert.equal(door.pricer.calls.length, 2);
        assert.equal(door.pricer.quotes.length, 1, 'exactly one quote was priced');
        assert.equal(kernelQuotes(door), 1, 'exactly one quote was recorded');
        assert.equal((await door.store.sessions()).length, 1);

        const again = await door.create(cart(1, market), { key });
        assert.equal(assertSession(again, 200, market, 1, 'the replay'), id, 'the replay is the same session');
        assert.equal(door.pricer.calls.length, 2, 'a replay prices nothing');
        assert.equal(kernelQuotes(door), 1);
        assert.equal((await door.store.sessions()).length, 1);
        const read = await door.read(id);
        assert.equal(assertSession(read, 200, market, 1, 'the read'), id);
      });
    });
  }

  test(`[${storeKind}] market DE: refused by the pricer by name, never priced; the key is a first create afterwards`, async () => {
    await withDoor({ storeKind }, async (door) => {
      const key = 'idem-unpriced-01';
      const refused = await door.create(cart(1, 'DE'), { key });
      assert.equal(refused.status, 503, refused.text);
      assert.deepEqual(refused.body, UNAVAILABLE);
      assert.equal(refused.body.currency, undefined, 'a refusal states no currency');
      assert.equal(door.pricer.calls.length, 1);
      assert.equal(door.pricer.calls[0].quote.shipping_address.country, 'DE', 'the pricer was asked for the market the request named');
      assert.equal(door.pricer.quotes.length, 0, 'no quote for a market the pricer has no currency for');
      assert.equal(PRICER_CURRENCY.DE, undefined);
      assert.deepEqual(await door.store.claims(), []);
      // The pricer's refusal carries its name; the same market under the same key is refused the same way again.
      const sameAgain = await door.create(cart(1, 'DE'), { key });
      assert.equal(sameAgain.status, 503, sameAgain.text);
      assert.equal(door.pricer.calls.length, 2, 'a first create each time: the pricer is asked again');
      // The buyer ships somewhere priced instead: the same key is a first create, in that market's currency.
      const created = await door.create(cart(1, 'US'), { key });
      assertSession(created, 201, 'US', 1, 'the same key, a priced market');
      assert.equal(door.pricer.quotes.length, 1);
      assert.equal(MARKET_NOT_PRICED, 'market_not_priced');
    });
  });
}

// ---- 2. every failure whose outcome is known gives the key back -----------------------------------------------

const KNOWN_FAILURES = [
  ['the pricer answers 503', (door) => () => { throw door.answered(503); }, 503, 'MERCHANT_UNAVAILABLE'],
  ['the pricer answers 500', (door) => () => { throw door.answered(500); }, 503, 'MERCHANT_UNAVAILABLE'],
  ['the pricer answers 504', (door) => () => { throw door.answered(504); }, 503, 'MERCHANT_UNAVAILABLE'],
  ['the pricer answers 429', (door) => () => { throw door.answered(429); }, 503, 'MERCHANT_UNAVAILABLE'],
  ['the pricer refuses the cart (422)', (door) => () => { throw door.answered(422, 'MERCHANT_UNAVAILABLE', 'placeholder_refusal'); }, 503, 'MERCHANT_UNAVAILABLE'],
  ['the pricer says out of stock', (door) => () => { throw door.answered(409, 'OUT_OF_STOCK', 'OUT_OF_STOCK'); }, 409, 'OUT_OF_STOCK'],
  ['the pricer says the price changed', (door) => () => { throw door.answered(409, 'PRICE_CHANGED', 'PRICE_CHANGED'); }, 409, 'PRICE_CHANGED'],
  ['the pricer says the quote expired', (door) => () => { throw door.answered(409, 'QUOTE_EXPIRED', 'QUOTE_EXPIRED'); }, 409, 'QUOTE_EXPIRED'],
  ['the pricer says the product is not found', (door) => () => { throw door.answered(404, 'NO_MERCHANT_OFFER', 'PRODUCT_NOT_FOUND'); }, 404, 'NO_MERCHANT_OFFER'],
  ['the backend refuses the partner assertion', (door) => () => { throw door.answered(409, 'PARTNER_ASSERTION_REJECTED', 'PARTNER_ASSERTION_REJECTED'); }, 409, 'PARTNER_ASSERTION_REJECTED'],
  ['the pricer answers a quote with no totals', () => () => ({ quote_id: 'uq_bad', currency: 'USD', merchant_of_record: 'merch_A' }), 503, 'MERCHANT_UNAVAILABLE'],
  ['the pricer answers an amount its currency cannot be charged in', () => () => ({ quote_id: 'uq_bad', currency: 'BHD', merchant_of_record: 'merch_A', locked_totals: { total: 1805 }, line_items: [] }), 503, 'MERCHANT_UNAVAILABLE'],
  ['a refusal raised in this process after the claim', (door) => () => { throw door.refusal('QUOTE_REQUIRED', { reason: 'placeholder_validation' }); }, 400, 'QUOTE_REQUIRED'],
];

for (const storeKind of STORES) {
  for (const [name, step, status, code] of KNOWN_FAILURES) {
    test(`[${storeKind}] known failure, ${name}: answered ${status} ${code}; the key is usable at once`, async () => {
      await withDoor({ storeKind }, async (door) => {
        const key = 'idem-known-0001';
        door.pricer.script(step(door));
        const failed = await door.create(cart(2, 'SG'), { key });
        assert.equal(failed.status, status, failed.text);
        assert.equal(failed.body.code, code);
        assert.deepEqual(Object.keys(failed.body).sort(), ['code', 'message', 'type'], 'nothing but the code and its message');
        assert.deepEqual(await door.store.claims(), [], 'no claim is left');
        assert.deepEqual(await door.store.sessions(), []);
        assert.equal(kernelQuotes(door), 0, 'no quote was recorded');

        const created = await door.create(cart(2, 'SG'), { key });
        const id = assertSession(created, 201, 'SG', 2, 'the retry');
        const again = await door.create(cart(2, 'SG'), { key });
        assert.equal(assertSession(again, 200, 'SG', 2, 'the replay'), id);
        assert.equal(door.pricer.quotes.length, 1, 'one quote in all');
        assert.equal(kernelQuotes(door), 1);
        assert.equal((await door.store.sessions()).length, 1);
      });
    });
  }
}

// ---- 3. a failure whose outcome nobody can know keeps the key for its lease -----------------------------------

const boom = () => { const err = new Error('placeholder store failure'); err.code = 'ECONNRESET'; return err; };
const isClaim = (key) => String(key).startsWith('["acpcreate"');
// [name, arrange(door) -> what the pricer does, the first answer's status and body, session rows the failed attempt left]
const UNKNOWN_OUTCOMES = [
  ['the pricer does not answer in time', (door) => () => { throw door.timedOut(); }, 503, UNAVAILABLE, 0],
  ['the pricer does not answer in time (an error that carries the timeout mark alone)', (door) => () => { throw door.refusal('MERCHANT_UNAVAILABLE', { upstream_timeout: true }); }, 503, UNAVAILABLE, 0],
  ['the connection to the pricer is lost', (door) => () => { throw door.connectionLost(); }, 503, UNAVAILABLE, 0],
  ['the pricer call fails with something that is not a refusal', () => () => { throw boom(); }, 500, INTERNAL, 0],
  ['the quote is priced and recording it fails', (door) => { door.quoteStore.before.set = async () => { door.quoteStore.before.set = null; throw boom(); }; return 'price'; }, 500, INTERNAL, 0],
  ['the quote is recorded and writing the session fails before it lands', (door) => {
    door.store.before.set = async (key) => { if (!isClaim(key)) { door.store.before.set = null; throw boom(); } };
    return 'price';
  }, 500, INTERNAL, 0],
  ['the quote is recorded and writing the session fails after it landed', (door) => {
    door.store.after.set = async (key) => { if (!isClaim(key)) { door.store.after.set = null; throw boom(); } };
    return 'price';
  }, 500, INTERNAL, 1],
  ['the session is written and finishing the claim fails before it lands', (door) => {
    door.store.before.compareAndSet = async () => { door.store.before.compareAndSet = null; throw boom(); };
    return 'price';
  }, 500, INTERNAL, 1],
];

for (const storeKind of STORES) {
  for (const [name, arrange, status, body, orphanRows] of UNKNOWN_OUTCOMES) {
    test(`[${storeKind}] unknown outcome, ${name}: the key is held for the lease, then is a first create; never two sessions`, async () => {
      await withDoor({ storeKind }, async (door) => {
        const key = 'idem-unknown-001';
        door.pricer.script(arrange(door));
        const failed = await door.create(cart(1, 'GB'), { key });
        assert.equal(failed.status, status, failed.text);
        assert.deepEqual(failed.body, body, 'the failure itself is answered as it always was');
        const claims = await door.store.claims();
        assert.equal(claims.length, 1, 'the claim is kept');
        assert.equal(claims[0].value.status, 'pending');
        assert.equal((await door.store.sessions()).length, orphanRows);
        const pricedBefore = door.pricer.calls.length;

        // The same request, and another cart, under the same key: outcome unknown, and the pricer is not asked.
        assertOutcomeUnknown(await door.create(cart(1, 'GB'), { key }), 'the same request, at once');
        assertOutcomeUnknown(await door.create(cart(3, 'US'), { key }), 'another cart under the key');
        door.clock.advance(LEASE_MS - 1);
        assertOutcomeUnknown(await door.create(cart(1, 'GB'), { key }), 'one millisecond before the lease ends');
        assert.equal(door.pricer.calls.length, pricedBefore, 'nothing more was asked of the pricer while the claim was held');

        // (The two stores differ on the instant of expiry itself, so the next look is one millisecond past it.)
        door.clock.advance(2);
        const created = await door.create(cart(1, 'GB'), { key });
        const id = assertSession(created, 201, 'GB', 1, 'after the lease');
        const again = await door.create(cart(1, 'GB'), { key });
        assert.equal(assertSession(again, 200, 'GB', 1, 'the replay'), id, 'one session is ever handed out for the key');
        const rows = await door.store.sessions();
        assert.equal(rows.length, 1 + orphanRows);
        // A row the failed attempt left is one nobody was ever given the id of, and the key does not lead to it.
        const claim = (await door.store.claims())[0].value;
        assert.deepEqual(claim, { acp_session_id: id, status: 'done' });
      });
    });
  }

  test(`[${storeKind}] unknown outcome, the session is written and finishing the claim fails after it landed: the retry replays that session`, async () => {
    await withDoor({ storeKind }, async (door) => {
      const key = 'idem-unknown-002';
      door.store.after.compareAndSet = async () => { door.store.after.compareAndSet = null; throw boom(); };
      const failed = await door.create(cart(1, 'US'), { key });
      assert.equal(failed.status, 500, failed.text);
      assert.deepEqual(failed.body, INTERNAL);
      const again = await door.create(cart(1, 'US'), { key });
      const id = assertSession(again, 200, 'US', 1, 'the retry reads the session the first attempt wrote');
      assert.deepEqual((await door.store.sessions()).map((row) => row.key), [id]);
      assert.equal(door.pricer.calls.length, 1);
      assert.equal(kernelQuotes(door), 1);
    });
  });

  test(`[${storeKind}] a release that fails changes nothing the caller is told; the lease ends the claim`, async () => {
    await withDoor({ storeKind }, async (door) => {
      const key = 'idem-release-01';
      door.pricer.script(() => { throw door.answered(503); });
      door.store.before.compareAndDelete = async () => { door.store.before.compareAndDelete = null; throw boom(); };
      const failed = await door.create(cart(1, 'US'), { key });
      assert.equal(failed.status, 503, failed.text);
      assert.deepEqual(failed.body, UNAVAILABLE);
      assertOutcomeUnknown(await door.create(cart(1, 'US'), { key }), 'the claim could not be given back');
      door.clock.advance(LEASE_MS + 1);
      assertSession(await door.create(cart(1, 'US'), { key }), 201, 'US', 1, 'after the lease');
    });
  });
}

// ---- 4. two creates under one key: one session, whatever the interleaving --------------------------------------

for (const storeKind of STORES) {
  test(`[${storeKind}] a second create while the first is pricing prices nothing; the first succeeds and both read one session`, async () => {
    await withDoor({ storeKind }, async (door) => {
      const key = 'idem-race-0001';
      const g = gate();
      door.pricer.script(g);
      const first = door.create(cart(1, 'SG'), { key });
      await inPricer(g, first);
      for (const label of ['second', 'third', 'fourth']) {
        assertOutcomeUnknown(await door.create(cart(1, 'SG'), { key }), `${label} create while the first is in flight`);
      }
      assertOutcomeUnknown(await door.create(cart(5, 'US'), { key }), 'another cart while the first is in flight');
      assert.equal(door.pricer.calls.length, 1, 'only the first create reached the pricer');
      assert.deepEqual(await door.store.sessions(), []);
      g.open('price');
      const id = assertSession(await first, 201, 'SG', 1, 'the first create');
      assert.equal(assertSession(await door.create(cart(1, 'SG'), { key }), 200, 'SG', 1, 'the second, again'), id);
      // Another cart under a key that has a session: the session that exists, as before.
      assert.equal(assertSession(await door.create(cart(5, 'US'), { key }), 200, 'SG', 1, 'another cart, after'), id);
      assert.equal(door.pricer.quotes.length, 1);
      assert.equal(kernelQuotes(door), 1);
      assert.equal((await door.store.sessions()).length, 1);
    });
  });

  test(`[${storeKind}] the first create fails cleanly while a second waits: the second's next try creates the one session`, async () => {
    await withDoor({ storeKind }, async (door) => {
      const key = 'idem-race-0002';
      const g = gate();
      door.pricer.script(g);
      const first = door.create(cart(1, 'GB'), { key });
      await inPricer(g, first);
      assertOutcomeUnknown(await door.create(cart(1, 'GB'), { key }), 'while the first is in flight');
      g.open(() => { throw door.answered(503); });
      const failed = await first;
      assert.equal(failed.status, 503, failed.text);
      assert.deepEqual(failed.body, UNAVAILABLE);
      const id = assertSession(await door.create(cart(1, 'GB'), { key }), 201, 'GB', 1, 'after the first failed');
      assert.equal(assertSession(await door.create(cart(1, 'GB'), { key }), 200, 'GB', 1, 'the replay'), id);
      assert.equal(door.pricer.quotes.length, 1);
      assert.equal((await door.store.sessions()).length, 1);
    });
  });

  test(`[${storeKind}] the first create fails and releases between the second's lost claim and its read: the second creates`, async () => {
    await withDoor({ storeKind }, async (door) => {
      const key = 'idem-race-0003';
      const g = gate();
      door.pricer.script(g);
      const first = door.create(cart(1, 'US'), { key });
      await inPricer(g, first);
      // The second create has lost the claim and is about to read it: exactly then, the first fails and releases.
      door.store.before.get = async (storeKey) => {
        if (!isClaim(storeKey)) return;
        door.store.before.get = null;
        g.open(() => { throw door.answered(503); });
        assert.equal((await first).status, 503);
      };
      const second = await door.create(cart(1, 'US'), { key });
      const id = assertSession(second, 201, 'US', 1, 'the second create');
      assert.equal((await first).status, 503);
      assert.equal(door.pricer.calls.length, 2);
      assert.equal(door.pricer.quotes.length, 1);
      assert.deepEqual((await door.store.sessions()).map((row) => row.key), [id]);
    });
  });

  test(`[${storeKind}] the first create succeeds between the second's lost claim and its read: the second replays it`, async () => {
    await withDoor({ storeKind }, async (door) => {
      const key = 'idem-race-0004';
      const g = gate();
      door.pricer.script(g);
      const first = door.create(cart(1, 'US'), { key });
      await inPricer(g, first);
      door.store.before.get = async (storeKey) => {
        if (!isClaim(storeKey)) return;
        door.store.before.get = null;
        g.open('price');
        assert.equal((await first).status, 201);
      };
      const second = await door.create(cart(1, 'US'), { key });
      const id = assertSession(await first, 201, 'US', 1, 'the first create');
      assert.equal(assertSession(second, 200, 'US', 1, 'the second create'), id);
      assert.equal(door.pricer.calls.length, 1);
      assert.deepEqual((await door.store.sessions()).map((row) => row.key), [id]);
    });
  });

  test(`[${storeKind}] a second create between the first's session write and its finished claim prices nothing and is told to ask again`, async () => {
    await withDoor({ storeKind }, async (door) => {
      const key = 'idem-race-0005';
      let second;
      door.store.before.compareAndSet = async () => {
        door.store.before.compareAndSet = null;
        second = await door.create(cart(1, 'US'), { key });
      };
      const id = assertSession(await door.create(cart(1, 'US'), { key }), 201, 'US', 1, 'the first create');
      assertOutcomeUnknown(second, 'the second create, in the window');
      assert.equal(assertSession(await door.create(cart(1, 'US'), { key }), 200, 'US', 1, 'the second, again'), id);
      assert.equal(door.pricer.calls.length, 1);
    });
  });

  test(`[${storeKind}] a key that changes hands on every try is answered outcome unknown, and prices nothing`, async () => {
    await withDoor({ storeKind }, async (door) => {
      const key = 'idem-race-0006';
      const claimKey = door.store.claimKey('buyer_1', key);
      const foreign = () => door.store.inner.putIfAbsent(claimKey, { acp_session_id: 'another-attempt', status: 'pending' }, { ttlMs: LEASE_MS });
      await foreign();
      let reads = 0;
      // Each time this create reads the claim it has just lost, the claim is gone; each time it tries again, there is a new one.
      door.store.before.get = async (storeKey) => { if (isClaim(storeKey)) { reads += 1; await door.store.inner.delete(claimKey); } };
      door.store.after.get = async (storeKey) => { if (isClaim(storeKey)) await foreign(); };
      assertOutcomeUnknown(await door.create(cart(1, 'US'), { key }), 'the claim was never ours');
      assert.equal(reads, 3, 'a bounded number of tries');
      assert.equal(door.pricer.calls.length, 0);
      assert.deepEqual((await door.store.claims()).map((row) => row.value.acp_session_id), ['another-attempt']);
    });
  });

  // ---- 5. an attempt that outlives its lease touches nobody else's claim --------------------------------------

  test(`[${storeKind}] expired claim, new claim, then the first attempt FAILS: its late release does not delete the new claim`, async () => {
    await withDoor({ storeKind }, async (door) => {
      const key = 'idem-lease-0001';
      const g = gate();
      door.pricer.script(g);
      const first = door.create(cart(1, 'SG'), { key });
      await inPricer(g, first);
      door.clock.advance(LEASE_MS + 1);
      const id = assertSession(await door.create(cart(1, 'SG'), { key }), 201, 'SG', 1, 'a create after the first one\'s lease ended');
      const claimBefore = await door.store.claims();
      g.open(() => { throw door.answered(503); });
      const late = await first;
      assert.equal(late.status, 503, late.text);
      assert.ok(door.store.calls.some((call) => call.name === 'compareAndDelete'), 'the first attempt did try to release');
      assert.deepEqual(await door.store.claims(), claimBefore, 'the new claim is untouched');
      assert.equal(assertSession(await door.create(cart(1, 'SG'), { key }), 200, 'SG', 1, 'the replay'), id);
      assert.deepEqual((await door.store.sessions()).map((row) => row.key), [id]);
    });
  });

  test(`[${storeKind}] expired claim, a new attempt still pricing, the first attempt FAILS late: the new attempt's claim stays, and it creates the one session`, async () => {
    await withDoor({ storeKind }, async (door) => {
      const key = 'idem-lease-0005';
      const g1 = gate();
      const g2 = gate();
      door.pricer.script(g1, g2);
      const first = door.create(cart(1, 'SG'), { key });
      await inPricer(g1, first);
      door.clock.advance(LEASE_MS + 1);
      const second = door.create(cart(1, 'SG'), { key });
      await inPricer(g2, second);
      const claimBefore = await door.store.claims();
      assert.equal(claimBefore[0].value.status, 'pending');
      g1.open(() => { throw door.answered(503); });
      assert.equal((await first).status, 503);
      assert.deepEqual(await door.store.claims(), claimBefore, 'the pending claim of the new attempt is untouched');
      assertOutcomeUnknown(await door.create(cart(1, 'SG'), { key }), 'a third create while the second is in flight');
      assert.equal(door.pricer.calls.length, 2, 'the third create priced nothing');
      g2.open('price');
      const id = assertSession(await second, 201, 'SG', 1, 'the second attempt');
      assert.deepEqual((await door.store.sessions()).map((row) => row.key), [id]);
    });
  });

  test(`[${storeKind}] expired claim, new claim, then the first attempt SUCCEEDS: its session is never handed out`, async () => {
    await withDoor({ storeKind }, async (door) => {
      const key = 'idem-lease-0002';
      const g = gate();
      door.pricer.script(g);
      const first = door.create(cart(1, 'GB'), { key });
      await inPricer(g, first);
      door.clock.advance(LEASE_MS + 1);
      const id = assertSession(await door.create(cart(1, 'GB'), { key }), 201, 'GB', 1, 'a create after the first one\'s lease ended');
      g.open('price');
      assertOutcomeUnknown(await first, 'the first attempt, late');
      assert.deepEqual((await door.store.sessions()).map((row) => row.key), [id], 'the late attempt left no session');
      assert.deepEqual((await door.store.claims()).map((row) => row.value), [{ acp_session_id: id, status: 'done' }]);
      assert.equal(assertSession(await door.create(cart(1, 'GB'), { key }), 200, 'GB', 1, 'the replay'), id);
    });
  });

  test(`[${storeKind}] expired claim, a new attempt still pricing, the first attempt SUCCEEDS late: one session, the new attempt's`, async () => {
    await withDoor({ storeKind }, async (door) => {
      const key = 'idem-lease-0003';
      const g1 = gate();
      const g2 = gate();
      door.pricer.script(g1, g2);
      const first = door.create(cart(1, 'US'), { key });
      await inPricer(g1, first);
      door.clock.advance(LEASE_MS + 1);
      const second = door.create(cart(1, 'US'), { key });
      await inPricer(g2, second);
      g1.open('price');
      assertOutcomeUnknown(await first, 'the first attempt, late');
      assert.deepEqual(await door.store.sessions(), [], 'nothing is handed out yet');
      assertOutcomeUnknown(await door.create(cart(1, 'US'), { key }), 'a third create while the second is in flight');
      g2.open('price');
      const id = assertSession(await second, 201, 'US', 1, 'the second attempt');
      assert.deepEqual((await door.store.sessions()).map((row) => row.key), [id]);
      assert.equal(assertSession(await door.create(cart(1, 'US'), { key }), 200, 'US', 1, 'the replay'), id);
    });
  });

  test(`[${storeKind}] expired claim nobody took, then the first attempt succeeds late: no session, and the key is a first create`, async () => {
    await withDoor({ storeKind }, async (door) => {
      const key = 'idem-lease-0004';
      const g = gate();
      door.pricer.script(g);
      const first = door.create(cart(1, 'US'), { key });
      await inPricer(g, first);
      door.clock.advance(LEASE_MS + 1);
      g.open('price');
      assertOutcomeUnknown(await first, 'the first attempt, late');
      assert.deepEqual(await door.store.sessions(), []);
      const id = assertSession(await door.create(cart(1, 'US'), { key }), 201, 'US', 1, 'the retry');
      assert.deepEqual((await door.store.sessions()).map((row) => row.key), [id]);
    });
  });

  // ---- 6. what did not change ---------------------------------------------------------------------------------

  test(`[${storeKind}] the dedup window is still fifteen minutes from the claim, and outlasts the lease`, async () => {
    await withDoor({ storeKind }, async (door) => {
      const key = 'idem-window-001';
      const g = gate();
      door.pricer.script(g);
      const first = door.create(cart(1, 'US'), { key });
      await inPricer(g, first);
      door.clock.advance(30 * 1000); // the create took thirty seconds
      g.open('price');
      const id = assertSession(await first, 201, 'US', 1, 'the create');
      door.clock.advance(LEASE_MS); // well past the lease
      assert.equal(assertSession(await door.create(cart(1, 'US'), { key }), 200, 'US', 1, 'after the lease'), id);
      // One millisecond before fifteen minutes from the claim (not from the create's end). The quote itself lasted
      // ten minutes, so what the key leads to is that session's own answer, as before: its quote has expired.
      door.clock.advance(WINDOW_MS - LEASE_MS - 30 * 1000 - 1);
      assert.equal(door.clock.now(), T0 + WINDOW_MS - 1);
      const late = await door.create(cart(1, 'US'), { key });
      assert.equal(late.status, 409, late.text);
      assert.equal(late.body.code, 'QUOTE_EXPIRED', 'still the first session, not a new create');
      assert.equal(door.pricer.calls.length, 1);
      door.clock.advance(2);
      const fresh = assertSession(await door.create(cart(1, 'US'), { key }), 201, 'US', 1, 'after the window');
      assert.notEqual(fresh, id);
    });
  });

  test(`[${storeKind}] another cart under a key: a first create after a released claim, the existing session while one exists`, async () => {
    await withDoor({ storeKind }, async (door) => {
      const key = 'idem-other-0001';
      door.pricer.script(() => { throw door.answered(503); });
      assert.equal((await door.create(cart(1, 'US'), { key })).status, 503);
      const id = assertSession(await door.create(cart(4, 'SG'), { key }), 201, 'SG', 4, 'another cart after the failure');
      assert.equal(assertSession(await door.create(cart(1, 'US'), { key }), 200, 'SG', 4, 'the first cart again'), id);
      // The same key for another buyer is another key.
      assertSession(await door.create(cart(1, 'GB'), { key, buyer: 'buyer_2' }), 201, 'GB', 1, 'another buyer');
    });
  });

  test(`[${storeKind}] what intake refuses is refused before any claim, and the key is untouched`, async () => {
    await withDoor({ storeKind }, async (door) => {
      const twoLines = { ...cart(1, 'US'), items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }, { product_id: 'p1', variant_id: 'v1', quantity: 2 }] };
      const refusals = [
        ['a key of seven characters', cart(1, 'US'), 'idem-07', 409, 'IDEMPOTENCY_CONFLICT'],
        ['a key with a character that is not printable ASCII', cart(1, 'US'), 'idem-café-01', 409, 'IDEMPOTENCY_CONFLICT'],
        ['a quantity of 1000', cart(1000, 'US'), 'idem-intake-01', 400, 'QUOTE_REQUIRED'],
        ['two lines for one product and variant', twoLines, 'idem-intake-01', 400, 'QUOTE_REQUIRED'],
        ['an address with no country', { ...cart(1, 'US'), fulfillment_address: { name: 'Example Buyer', address_line1: '1 Example Street', city: 'Springfield', postal_code: '00000' } }, 'idem-intake-01', 400, 'QUOTE_REQUIRED'],
      ];
      for (const [label, body, key, status, code] of refusals) {
        const refused = await door.create(body, { key });
        assert.equal(refused.status, status, `${label}: ${refused.text}`);
        assert.equal(refused.body.code, code, label);
      }
      assert.deepEqual(door.store.calls, [], 'the store was never asked for anything');
      assert.equal(door.pricer.calls.length, 0);
      assertSession(await door.create(cart(999, 'US'), { key: 'idem-intake-01' }), 201, 'US', 999, 'the same key, a cart within the bounds');
    });
  });
}

// ---- 7. stores and records of the kind that existed before ---------------------------------------------------------

test('a store with no conditional write keeps the claim as it always was: written once, never released', async () => {
  await withDoor({ conditionalStore: false }, async (door) => {
    const key = 'idem-plain-0001';
    door.pricer.script(() => { throw door.answered(503); });
    const failed = await door.create(cart(1, 'US'), { key });
    assert.equal(failed.status, 503, failed.text);
    const claims = await door.store.claims();
    assert.equal(claims.length, 1);
    assert.deepEqual(Object.keys(claims[0].value), ['acp_session_id'], 'the record has the shape it always had');
    const again = await door.create(cart(1, 'US'), { key });
    assert.equal(again.status, 404, again.text);
    assert.equal(again.body.code, 'QUOTE_NOT_FOUND');
    door.clock.advance(WINDOW_MS - 1);
    assert.equal((await door.create(cart(1, 'US'), { key })).status, 404, 'held for the whole window');
    door.clock.advance(2);
    const id = assertSession(await door.create(cart(1, 'US'), { key }), 201, 'US', 1, 'after the window');
    assert.equal(assertSession(await door.create(cart(1, 'US'), { key }), 200, 'US', 1, 'the replay'), id);
    assert.deepEqual([...new Set(door.store.calls.map((call) => call.name))].sort(), ['get', 'putIfAbsent', 'set']);
  });
});

for (const storeKind of STORES) {
  test(`[${storeKind}] a claim written before this change (no status) is read as it always was`, async () => {
    await withDoor({ storeKind }, async (door) => {
      // One with no session behind it, as a failed create used to leave.
      const orphanKey = 'idem-before-001';
      await door.store.inner.putIfAbsent(door.store.claimKey('buyer_1', orphanKey), { acp_session_id: 'never-written' }, { ttlMs: WINDOW_MS });
      const orphan = await door.create(cart(1, 'US'), { key: orphanKey });
      assert.equal(orphan.status, 404, orphan.text);
      assert.equal(orphan.body.code, 'QUOTE_NOT_FOUND');
      assert.equal(door.pricer.calls.length, 0);
      // One with its session: replayed.
      const liveKey = 'idem-before-002';
      const id = assertSession(await door.create(cart(1, 'SG'), { key: liveKey }), 201, 'SG', 1, 'a create');
      await door.store.inner.set(door.store.claimKey('buyer_1', liveKey), { acp_session_id: id }, { ttlMs: WINDOW_MS });
      assert.equal(assertSession(await door.create(cart(1, 'SG'), { key: liveKey }), 200, 'SG', 1, 'the replay'), id);
    });
  });
}
