// A store that answered a market's cart in another currency is remembered for a short while
// (AGENT_CHECKOUT_STORE_CART_CURRENCY_MISMATCH_MEMO_ENABLED): the memo itself, and the storefront lane with it.
// The real-door behaviour is in tests/store_cart_currency_mismatch_memo_door.node.test.cjs.
//
// What is pinned here:
//   - the switch, value by value; the two bounds, their defaults, and that an invalid value is the default;
//   - the key is the seller AND the market: another market of the same seller reads nothing, even one that shares
//     the first market's currency;
//   - an entry expires on the memo's own clock (injected: no test here waits), and a hit does not renew it;
//   - the number of entries is bounded, oldest out first, expired out before any live one;
//   - in the lane: a retry of a refused create is refused with the SAME refusal and nothing is asked of the store
//     or the referral; with the switch off nothing is remembered and nothing changes; a cart that has a catalog
//     price is still asked at the store; markets with no currency never reach the memo; the ledger's replay is
//     still judged again;
//   - WHERE THE MEMO IS READ: by the seller door, at the one point where it would contact the store. A cart that
//     door answers without the store (several variants and none chosen, a row with no currency, no seller variant
//     id, the same variant twice, a sole variant the catalog does not confirm) is answered exactly as with the
//     switch off, entry or no entry, and the memo is not read for it. The referral is asked for after that point.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  STORE_CART_CURRENCY_MISMATCH_MEMO_FLAG as MEMO_FLAG,
  STORE_CART_CURRENCY_MISMATCH_MEMO_TTL_ENV as TTL_ENV,
  STORE_CART_CURRENCY_MISMATCH_MEMO_MAX_ENV as MAX_ENV,
  DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS, DEFAULT_MAX_ENTRIES, MIN_MAX_ENTRIES, MAX_MAX_ENTRIES,
  currencyMismatchMemoEnabled, currencyMismatchMemoTtlMs, currencyMismatchMemoMaxEntries, currencyMismatchMemoKey,
  createCurrencyMismatchMemo, storeCartCurrencyMismatchMemo,
} from '../src/storeCartCurrencyMismatchMemo.js';
import { MERCHANT_PRICING_FLAG, CART_REFERRAL_FLAG } from '../src/ucpMerchantDoorPricing.js';
import { UCP_ESCALATION_FLAG, CURRENCY_FOLLOWS_MARKET_FLAG, ID_BINDING_SECRET_ENV, tryEscalateUcpCheckout } from '../src/ucpCheckoutEscalation.js';
import { STORE_CART_IDEMPOTENCY_FLAG, storeCartIdempotencyCounts, resetStoreCartIdempotencyCountsForTest } from '../src/storefrontCartIdempotency.js';
import { InMemoryKvStore } from '../../safety-kernel/src/stores.js';

const require = createRequire(import.meta.url);
const { resolveServingCurrency } = require('../../src/services/buyerMarket.js');
const { noteWithheldCurrencies } = require('../../src/services/pdpWithheldCurrencies.js');

const ON = { [MEMO_FLAG]: '1' };
const HOST = 'store-a.example';
const OTHER_HOST = 'store-b.example';

function clockAt(start = 1_000_000) {
  const state = { t: start };
  const clock = () => state.t;
  clock.advance = (ms) => { state.t += ms; };
  clock.set = (t) => { state.t = t; };
  return clock;
}

// ---- the memo ------------------------------------------------------------------------------------------------------

describe('the switch and the bounds', () => {
  test('OFF by default; ON for exactly four spellings, any case', () => {
    assert.equal(MEMO_FLAG, 'AGENT_CHECKOUT_STORE_CART_CURRENCY_MISMATCH_MEMO_ENABLED');
    for (const v of ['1', 'true', 'on', 'YES', ' On ']) assert.equal(currencyMismatchMemoEnabled({ [MEMO_FLAG]: v }), true, v);
    for (const v of ['', '0', 'off', 'no', 'enabled', '2', undefined, null]) assert.equal(currencyMismatchMemoEnabled({ [MEMO_FLAG]: v }), false, String(v));
    assert.equal(currencyMismatchMemoEnabled({}), false);
    assert.equal(currencyMismatchMemoEnabled(undefined), false);
  });

  test('the defaults: ten minutes, a thousand entries', () => {
    assert.equal(TTL_ENV, 'AGENT_CHECKOUT_STORE_CART_CURRENCY_MISMATCH_MEMO_TTL_MS');
    assert.equal(MAX_ENV, 'AGENT_CHECKOUT_STORE_CART_CURRENCY_MISMATCH_MEMO_MAX_ENTRIES');
    assert.deepEqual([DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS], [600000, 1000, 3600000]);
    assert.deepEqual([DEFAULT_MAX_ENTRIES, MIN_MAX_ENTRIES, MAX_MAX_ENTRIES], [1000, 1, 20000]);
    assert.equal(currencyMismatchMemoTtlMs({}), DEFAULT_TTL_MS);
    assert.equal(currencyMismatchMemoMaxEntries({}), DEFAULT_MAX_ENTRIES);
  });

  test('a valid value is used; the ends of each range are valid', () => {
    for (const v of ['1000', '60000', ' 90000 ', '3600000', 2000]) assert.equal(currencyMismatchMemoTtlMs({ [TTL_ENV]: v }), Number(String(v).trim()), String(v));
    for (const v of ['1', '2', '500', '20000', 7]) assert.equal(currencyMismatchMemoMaxEntries({ [MAX_ENV]: v }), Number(v), String(v));
  });

  test('AN INVALID VALUE IS THE DEFAULT, never "no bound" and never zero', () => {
    const junk = ['', ' ', '0', '-1', '+5000', '1.5', '1e4', '5000ms', '10m', 'NaN', 'Infinity', 'forever', '0x10', '999', '3600001', '99999999999', null, undefined, true, {}, []];
    for (const v of junk) assert.equal(currencyMismatchMemoTtlMs({ [TTL_ENV]: v }), DEFAULT_TTL_MS, `ttl ${JSON.stringify(v)}`);
    const junkMax = ['', '0', '-3', '1.5', '2e3', 'many', 'Infinity', '20001', '99999999999', null, undefined, false, {}];
    for (const v of junkMax) assert.equal(currencyMismatchMemoMaxEntries({ [MAX_ENV]: v }), DEFAULT_MAX_ENTRIES, `max ${JSON.stringify(v)}`);
  });
});

describe('the key is the seller AND the market', () => {
  test('one key per (host, market); the host is case-folded; neither member alone is a key', () => {
    assert.equal(currencyMismatchMemoKey(HOST, 'GB'), JSON.stringify([HOST, 'GB']));
    assert.equal(currencyMismatchMemoKey(' Store-A.Example ', 'GB'), currencyMismatchMemoKey(HOST, 'GB'));
    assert.notEqual(currencyMismatchMemoKey(HOST, 'GB'), currencyMismatchMemoKey(HOST, 'US'));
    assert.notEqual(currencyMismatchMemoKey(HOST, 'GB'), currencyMismatchMemoKey(OTHER_HOST, 'GB'));
    for (const [host, market] of [[HOST, null], [HOST, undefined], [HOST, ''], [HOST, 'gb'], [HOST, 'GBR'], [HOST, 'G'], [HOST, 44], [null, 'GB'], ['', 'GB'], ['  ', 'GB'], [undefined, 'GB'], [{}, 'GB']]) {
      assert.equal(currencyMismatchMemoKey(host, market), null, JSON.stringify([host, market]));
    }
  });

  test('a GB mismatch is not read for US, SG, FR or any other market of the same seller, nor for another seller', () => {
    const memo = createCurrencyMismatchMemo({ clock: clockAt() });
    assert.equal(memo.remember({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env: ON }), true);
    assert.equal(memo.recall({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', env: ON }), 'USD');
    for (const [market, currency] of [['US', 'USD'], ['SG', 'SGD'], ['FR', 'EUR'], ['JP', 'JPY']]) {
      assert.equal(memo.recall({ sellerHost: HOST, market, marketCurrency: currency, env: ON }), null, market);
    }
    assert.equal(memo.recall({ sellerHost: OTHER_HOST, market: 'GB', marketCurrency: 'GBP', env: ON }), null);
    assert.equal(memo.size(), 1);
  });

  test('TWO MARKETS THAT SHARE A CURRENCY are two keys: an FR mismatch is not read for HR or FI (all three are priced in EUR)', () => {
    assert.deepEqual(['FR', 'HR', 'FI'].map((m) => resolveServingCurrency(m)), ['EUR', 'EUR', 'EUR']);
    const memo = createCurrencyMismatchMemo({ clock: clockAt() });
    memo.remember({ sellerHost: HOST, market: 'FR', marketCurrency: 'EUR', storeCurrency: 'USD', env: ON });
    assert.equal(memo.recall({ sellerHost: HOST, market: 'FR', marketCurrency: 'EUR', env: ON }), 'USD');
    assert.equal(memo.recall({ sellerHost: HOST, market: 'HR', marketCurrency: 'EUR', env: ON }), null);
    assert.equal(memo.recall({ sellerHost: HOST, market: 'FI', marketCurrency: 'EUR', env: ON }), null);
  });

  test('nothing is remembered for a pair with no market, a malformed market, no seller, a malformed currency, or no mismatch', () => {
    const memo = createCurrencyMismatchMemo({ clock: clockAt() });
    const base = { sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env: ON };
    for (const over of [{ market: null }, { market: undefined }, { market: 'gb' }, { market: 'GBR' }, { sellerHost: null }, { sellerHost: '' },
      { storeCurrency: null }, { storeCurrency: 'usd' }, { storeCurrency: 'US' }, { marketCurrency: null }, { marketCurrency: 'gbp' }, { storeCurrency: 'GBP' }]) {
      assert.equal(memo.remember({ ...base, ...over }), false, JSON.stringify(over));
    }
    assert.equal(memo.size(), 0);
    assert.deepEqual(memo.counts(), {});
  });

  test('an entry is used only against the market currency it was recorded for, and never when it IS the market currency', () => {
    const memo = createCurrencyMismatchMemo({ clock: clockAt() });
    memo.remember({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env: ON });
    // The market's currency, resolved again for this request, is not the one recorded: nothing is known, and the entry goes.
    assert.equal(memo.recall({ sellerHost: HOST, market: 'GB', marketCurrency: 'USD', env: ON }), null);
    assert.equal(memo.size(), 0);
    memo.remember({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env: ON });
    assert.equal(memo.recall({ sellerHost: HOST, market: 'GB', marketCurrency: 'EUR', env: ON }), null);
    assert.equal(memo.recall({ sellerHost: HOST, market: 'GB', marketCurrency: null, env: ON }), null);
  });
});

describe('the switch off', () => {
  test('nothing is remembered and nothing is recalled; an entry written while on is not read while off', () => {
    const memo = createCurrencyMismatchMemo({ clock: clockAt() });
    for (const env of [{}, { [MEMO_FLAG]: '' }, { [MEMO_FLAG]: '0' }, { [MEMO_FLAG]: 'enabled' }, undefined, null]) {
      const envOrDefault = env === undefined ? {} : env;
      assert.equal(memo.remember({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env: envOrDefault }), false);
    }
    assert.equal(memo.size(), 0);
    memo.remember({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env: ON });
    assert.equal(memo.recall({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', env: {} }), null);
    assert.equal(memo.recall({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', env: { [MEMO_FLAG]: 'off' } }), null);
    assert.equal(memo.recall({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', env: ON }), 'USD');
  });
});

describe('an entry expires, on the memo\'s own clock', () => {
  test('fresh until the TTL, gone at it; the default TTL', () => {
    const clock = clockAt();
    const memo = createCurrencyMismatchMemo({ clock });
    memo.remember({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env: ON });
    clock.advance(DEFAULT_TTL_MS - 1);
    assert.equal(memo.recall({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', env: ON }), 'USD');
    clock.advance(1);
    assert.equal(memo.recall({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', env: ON }), null);
    assert.equal(memo.size(), 0, 'an expired entry is dropped when read');
    assert.deepEqual(memo.counts(), { remembered: 1, expired: 1 });
  });

  test('A HIT DOES NOT RENEW: however often it is read, the entry is gone one TTL after the store answered', () => {
    const clock = clockAt();
    const memo = createCurrencyMismatchMemo({ clock });
    const env = { ...ON, [TTL_ENV]: '5000' };
    memo.remember({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env });
    for (let i = 0; i < 49; i += 1) {
      clock.advance(100);
      assert.equal(memo.recall({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', env }), 'USD', `read ${i}`);
    }
    clock.advance(100);
    assert.equal(memo.recall({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', env }), null);
  });

  test('the TTL is read per call: shortening it expires what is held; an invalid one is the default', () => {
    const clock = clockAt();
    const memo = createCurrencyMismatchMemo({ clock });
    memo.remember({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env: ON });
    clock.advance(30000);
    assert.equal(memo.recall({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', env: { ...ON, [TTL_ENV]: 'never' } }), 'USD', 'invalid = ten minutes');
    assert.equal(memo.recall({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', env: { ...ON, [TTL_ENV]: '0' } }), 'USD', 'zero is invalid, not "expire now" and not "keep for ever"');
    assert.equal(memo.recall({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', env: { ...ON, [TTL_ENV]: '30000' } }), null);
  });

  test('a new answer from the store restarts the entry\'s time and replaces its currency', () => {
    const clock = clockAt();
    const memo = createCurrencyMismatchMemo({ clock });
    memo.remember({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env: ON });
    clock.advance(DEFAULT_TTL_MS - 10);
    memo.remember({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', storeCurrency: 'EUR', env: ON });
    clock.advance(DEFAULT_TTL_MS - 10);
    assert.equal(memo.recall({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', env: ON }), 'EUR');
    assert.equal(memo.size(), 1);
  });

  test('a clock that goes backwards, or is not a number, reads as "nothing remembered"', () => {
    const clock = clockAt(50000);
    const memo = createCurrencyMismatchMemo({ clock });
    memo.remember({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env: ON });
    clock.set(49999);
    assert.equal(memo.recall({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', env: ON }), null);
    const broken = createCurrencyMismatchMemo({ clock: () => NaN });
    assert.equal(broken.remember({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env: ON }), false);
    const throwing = createCurrencyMismatchMemo({ clock: () => { throw new Error('clock down'); } });
    assert.equal(throwing.remember({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env: ON }), false);
    assert.equal(throwing.recall({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', env: ON }), null);
  });

  test('a test clock can be put on a memo and taken off again', () => {
    const memo = createCurrencyMismatchMemo({ clock: () => 10 });
    memo.remember({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env: ON });
    memo.useClockForTest(() => 10 + DEFAULT_TTL_MS);
    assert.equal(memo.recall({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', env: ON }), null);
    memo.remember({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env: ON });
    memo.useClockForTest();
    assert.equal(memo.recall({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', env: ON }), null, 'back on its own clock: written "in the future", not fresh');
    memo.resetForTest();
    assert.deepEqual([memo.size(), memo.counts()], [0, {}]);
  });
});

describe('the number of entries is bounded', () => {
  const hostN = (n) => `store-${n}.example`;

  test('never more than the maximum; the oldest goes first', () => {
    const clock = clockAt();
    const memo = createCurrencyMismatchMemo({ clock });
    const env = { ...ON, [MAX_ENV]: '3' };
    for (let n = 1; n <= 10; n += 1) {
      clock.advance(1);
      memo.remember({ sellerHost: hostN(n), market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env });
      assert.ok(memo.size() <= 3, `after ${n}`);
    }
    assert.equal(memo.size(), 3);
    assert.deepEqual([7, 8, 9, 10].map((n) => memo.recall({ sellerHost: hostN(n), market: 'GB', marketCurrency: 'GBP', env })), [null, 'USD', 'USD', 'USD']);
    assert.deepEqual(memo.counts(), { remembered: 10, evicted: 7 });
  });

  test('the default bound holds with no value set, and with an invalid one', () => {
    for (const env of [ON, { ...ON, [MAX_ENV]: '0' }, { ...ON, [MAX_ENV]: 'unbounded' }]) {
      const memo = createCurrencyMismatchMemo({ clock: clockAt() });
      for (let n = 0; n < DEFAULT_MAX_ENTRIES + 25; n += 1) memo.remember({ sellerHost: hostN(n), market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env });
      assert.equal(memo.size(), DEFAULT_MAX_ENTRIES);
    }
  });

  test('one seller in many markets is many entries, and they count against the same bound', () => {
    const memo = createCurrencyMismatchMemo({ clock: clockAt() });
    const env = { ...ON, [MAX_ENV]: '2' };
    for (const [market, currency] of [['GB', 'GBP'], ['SG', 'SGD'], ['FR', 'EUR']]) memo.remember({ sellerHost: HOST, market, marketCurrency: currency, storeCurrency: 'USD', env });
    assert.equal(memo.size(), 2);
    assert.deepEqual(['GB', 'SG', 'FR'].map((m) => memo.recall({ sellerHost: HOST, market: m, marketCurrency: resolveServingCurrency(m), env })), [null, 'USD', 'USD']);
  });

  test('expired entries make room before any live one is dropped', () => {
    const clock = clockAt();
    const memo = createCurrencyMismatchMemo({ clock });
    const env = { ...ON, [MAX_ENV]: '3', [TTL_ENV]: '1000' };
    memo.remember({ sellerHost: hostN(1), market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env });
    memo.remember({ sellerHost: hostN(2), market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env });
    clock.advance(1000);
    memo.remember({ sellerHost: hostN(3), market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env });
    memo.remember({ sellerHost: hostN(4), market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env });
    assert.equal(memo.size(), 2, 'the two expired ones went; nothing live was dropped');
    assert.deepEqual(memo.counts(), { remembered: 4 });
    assert.deepEqual([3, 4].map((n) => memo.recall({ sellerHost: hostN(n), market: 'GB', marketCurrency: 'GBP', env })), ['USD', 'USD']);
  });

  test('lowering the maximum shrinks the memo at the next write; re-remembering a held pair drops nothing', () => {
    const memo = createCurrencyMismatchMemo({ clock: clockAt() });
    for (let n = 1; n <= 5; n += 1) memo.remember({ sellerHost: hostN(n), market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env: ON });
    memo.remember({ sellerHost: hostN(1), market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env: { ...ON, [MAX_ENV]: '5' } });
    assert.equal(memo.size(), 5, 'the same pair again, at the bound: nothing evicted');
    assert.equal(memo.counts().evicted, undefined);
    memo.remember({ sellerHost: hostN(6), market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env: { ...ON, [MAX_ENV]: '2' } });
    assert.equal(memo.size(), 2);
  });
});

test('the process has one memo, and it starts empty', () => {
  assert.equal(typeof storeCartCurrencyMismatchMemo.recall, 'function');
  assert.equal(storeCartCurrencyMismatchMemo.size(), 0);
});

// ---- the lane ------------------------------------------------------------------------------------------------------

describe('the lane', () => {
  const GID = (n) => `gid://shopify/ProductVariant/${n}`;
  const SECRET = 'unit-test-secret-0123456789';
  const BASE = { [UCP_ESCALATION_FLAG]: '1', [MERCHANT_PRICING_FLAG]: '1', [CURRENCY_FOLLOWS_MARKET_FLAG]: '1', [CART_REFERRAL_FLAG]: '1' };
  const MEMO_ON = { ...BASE, [MEMO_FLAG]: '1' };
  const NOW = Date.UTC(2026, 0, 15, 10, 0, 0);
  const VARIANT = { gbp: '44000000000001', usd: '44000000000002', sgd: '44000000000003', eur: '44000000000004', gbp_priced: '44000000000005' };
  // One seller, five products. `withheld`: the product read withheld the row's money in that currency (the row is
  // unpriced, and labelled with it); `priced`: the row states a catalog price in that currency.
  const CATALOG = Object.freeze({
    sig_gbp: { variant: VARIANT.gbp, withheld: 'GBP' },
    sig_usd: { variant: VARIANT.usd, withheld: 'USD' },
    sig_sgd: { variant: VARIANT.sgd, withheld: 'SGD' },
    sig_eur: { variant: VARIANT.eur, withheld: 'EUR' },
    sig_gbp_priced: { variant: VARIANT.gbp_priced, priced: 'GBP' },
    // Carts the seller door answers WITHOUT the store (all of this seller, all unpriced):
    //   several real variants, and the request chooses none;
    sig_multi: { withheld: 'GBP', variants: [{ variant_id: 'multi-small', source_variant_id: '44000000000011', title: 'Small' }, { variant_id: 'multi-large', source_variant_id: '44000000000012', title: 'Large' }] },
    //   no price, no currency, and no note of a currency the read withheld;
    sig_unlabelled: { variant: '44000000000013' },
    //   one variant, and nothing that names the store's own id for it;
    sig_novariant: { withheld: 'GBP', variants: [{ variant_id: 'sig_novariant' }] },
    //   two products whose rows name the same store variant;
    sig_twin_a: { variant: '44000000000014', withheld: 'GBP' },
    sig_twin_b: { variant: '44000000000014', withheld: 'GBP' },
    //   a sole variant known only by its own id, which the catalog is then asked to confirm.
    sig_derived: { withheld: 'GBP', variants: [{ variant_id: '44000000000015', title: 'Default Title' }] },
  });
  const linkOf = (pid) => `https://${HOST}/products/${pid.replace(/_/g, '-')}`;
  const executor = {
    async execute(op, params) {
      const pid = params.payload.product.product_id;
      const entry = CATALOG[pid];
      const product = {
        product_id: pid, title: `Item ${pid}`, external_redirect_url: linkOf(pid),
        price: entry.priced ? 25 : null, currency: entry.priced || null,
        variants: entry.variants ? structuredClone(entry.variants) : [{ variant_id: pid, source_variant_id: entry.variant }],
      };
      if (entry.withheld) noteWithheldCurrencies(product, [entry.withheld]);
      return { product };
    },
  };
  /** A storefront that answers each market's cart in the currency `answers` names for it. */
  function fakeDoor(answers, events = []) {
    const calls = [];
    let seq = 0;
    const carts = new Map();
    const cart = (id) => {
      const { gid, quantity, currency } = carts.get(id);
      return { ok: true, status: 200, response: { result: { content: [{ type: 'text', text: JSON.stringify({
        id, currency, continue_url: `https://${HOST}/cart/c/${id}?key=k`,
        line_items: [{ id: 'l0', item: { id: gid, title: 'Store item', price: 2750 }, quantity, totals: [{ type: 'subtotal', amount: 2750 * quantity }, { type: 'total', amount: 2750 * quantity }] }],
        totals: [{ type: 'subtotal', amount: 2750 * quantity }, { type: 'total', amount: 2750 * quantity }],
      }) }] } } };
    };
    return {
      calls,
      answers,
      async endpointFor(host) { calls.push(['discover', host]); events.push('discover'); return `https://${HOST}/api/ucp/mcp`; },
      async createCart(_ep, args) {
        seq += 1;
        const id = `cart_${seq}`;
        const market = args.context && args.context.address_country;
        carts.set(id, { gid: args.lineItems[0].item.id, quantity: args.lineItems[0].quantity, currency: answers[market] });
        calls.push(['create_cart', market]);
        events.push('create_cart');
        return cart(id);
      },
      async getCart(_ep, id) { calls.push(['get_cart', id]); return cart(id); },
    };
  }
  function minter(events = []) {
    const calls = [];
    return {
      calls,
      async mint(fields) {
        calls.push(structuredClone(fields));
        events.push('mint_referral');
        const click = `clk_${String(calls.length).padStart(24, '0')}`;
        return { kind: 'minted', clickId: click, pairs: [['utm_source', 'pivota'], ['pvt_click_id', click]], attributed: false };
      },
    };
  }
  const logOf = () => { const lines = []; return { lines, info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) }; };
  const allow = async () => ({ offer: true });
  const refusalOf = (promise) => promise.then((out) => assert.fail(`not refused: ${JSON.stringify(out)}`), (err) => ({ code: err.code, message: err.message, detail: structuredClone(err.detail), marketAssumed: err.marketAssumed === true }));
  function rig({ answers = { GB: 'USD', US: 'USD', SG: 'SGD', FR: 'USD', HR: 'EUR' }, env = MEMO_ON, gate = allow } = {}) {
    const clock = clockAt();
    // The memo, with every read and write of it noted (`touched`): what is pinned below is not only what a create
    // answers but whether the memo was consulted for it at all.
    const held = createCurrencyMismatchMemo({ clock });
    const touched = [];
    const memo = {
      ...held,
      recall(args) { const out = held.recall(args); touched.push(['recall', args.market, out]); events.push('recall'); return out; },
      remember(args) { const out = held.remember(args); touched.push(['remember', args.market, out]); return out; },
    };
    // One timeline of everything a create asks of anyone: the memo, the store, the referral.
    const events = [];
    const door = fakeDoor(answers, events);
    const referrals = minter(events);
    const log = logOf();
    // `pid`: one product id, or a list of them (one line each).
    const create = (pid, market, over = {}) => tryEscalateUcpCheckout({
      op: { id: 'create_checkout_session' }, ctx: { user_ref: 'buyer-0001', acp_session_id: 'sess-0001' },
      params: { idempotency_key: over.key || 'idem-memo-0001', quote: { items: (Array.isArray(pid) ? pid : [pid]).map((id) => ({ product_id: id, quantity: over.quantity || 1 })) } },
      executor, ucpArgs: market === undefined ? {} : { checkout: { context: { address_country: market } } },
      env: over.env || env, now: NOW, shouldOfferPurchase: over.gate || gate, merchantDoor: door, referralMinter: referrals, log,
      currencyMismatchMemo: memo,
      ...(over.store ? { idempotencyStore: over.store, idempotencyPartner: () => ({ kind: 'agent', sub: 'agent_partner_a' }) } : {}),
    });
    const storeTools = () => door.calls.filter((c) => c[0] !== 'discover').map((c) => c[0]);
    return { clock, memo, door, referrals, log, create, storeTools, touched, events };
  }

  test('the fixture: the source prices US, SG, GB, FR and HR, and prices neither DE nor ZZ', () => {
    assert.deepEqual(['US', 'SG', 'GB', 'FR', 'HR', 'DE', 'ZZ'].map((m) => resolveServingCurrency(m) || null), ['USD', 'SGD', 'GBP', 'EUR', 'EUR', null, null]);
  });

  test('A RETRY OF A REFUSED CREATE IS REFUSED WITHOUT THE STORE: the same refusal, no discovery, no cart, no referral', async () => {
    const r = rig();
    const first = await refusalOf(r.create('sig_gbp', 'GB'));
    assert.equal(first.code, 'NO_MERCHANT_OFFER');
    assert.equal(first.detail.reason, 'seller_not_priced_in_market_currency');
    assert.deepEqual(first.detail.acp_detail, {
      reason: 'seller_not_priced_in_market_currency', market: 'GB', market_currency: 'GBP', seller_currencies: ['USD'],
      storefront_items: ['sig_gbp'], seller_hosts: [HOST], storefront_urls: { sig_gbp: linkOf('sig_gbp') },
    });
    assert.match(first.detail.acp_message, /storefront \(store-a\.example\) answered in USD, and a price for GB must be in GBP/);
    assert.deepEqual(r.door.calls, [['discover', HOST], ['create_cart', 'GB']]);
    assert.equal(r.referrals.calls.length, 1, 'the one referral the first attempt leaves');
    assert.deepEqual(r.memo.counts(), { remembered: 1 });
    assert.equal(r.memo.size(), 1);

    for (let attempt = 2; attempt <= 6; attempt += 1) {
      r.clock.advance(1000);
      const retry = await refusalOf(r.create('sig_gbp', 'GB'));
      assert.deepEqual(retry, first, `attempt ${attempt}: the same code, message and detail`);
    }
    assert.deepEqual(r.door.calls, [['discover', HOST], ['create_cart', 'GB']], 'the store was asked once, by the first attempt');
    assert.equal(r.referrals.calls.length, 1, 'no further referral');
    assert.deepEqual(r.memo.counts(), { remembered: 1, refused_without_store: 5 });
    // The log: the first attempt's two lines, then per retry the refusal's own line and one line saying the store was not asked.
    const lines = r.log.lines.filter((l) => l.event === 'ucp_merchant_door_pricing').map((l) => [l.outcome, l.reason]);
    assert.deepEqual(lines.slice(0, 2), [['fallback', 'store_currency_not_market_currency'], ['refused', 'seller_not_priced_in_market_currency']]);
    assert.deepEqual(lines.slice(2, 4), [['refused', 'seller_not_priced_in_market_currency'], ['store_not_asked', 'store_currency_not_market_currency_remembered']]);
    assert.deepEqual(r.log.lines.find((l) => l.outcome === 'store_not_asked'), {
      event: 'ucp_merchant_door_pricing', outcome: 'store_not_asked', reason: 'store_currency_not_market_currency_remembered',
      market: 'GB', expected_currency: 'GBP', store_currency: 'USD', seller_host: HOST,
    });
  });

  test('SWITCH OFF: nothing is remembered; every retry builds a cart at the store and mints a referral, as before', async () => {
    for (const env of [BASE, { ...BASE, [MEMO_FLAG]: '' }, { ...BASE, [MEMO_FLAG]: 'enabled' }, { ...BASE, [TTL_ENV]: '5000', [MAX_ENV]: '5' }]) {
      const r = rig({ env });
      const first = await refusalOf(r.create('sig_gbp', 'GB'));
      const retry = await refusalOf(r.create('sig_gbp', 'GB'));
      assert.deepEqual(retry, first);
      assert.deepEqual(r.storeTools(), ['create_cart', 'create_cart']);
      assert.equal(r.referrals.calls.length, 2);
      assert.deepEqual([r.memo.size(), r.memo.counts()], [0, {}]);
      assert.equal(r.log.lines.some((l) => l.outcome === 'store_not_asked'), false);
    }
  });

  test('an entry written while on is not used once the switch is off, and is used again when it is back on', async () => {
    const r = rig();
    await refusalOf(r.create('sig_gbp', 'GB'));
    await refusalOf(r.create('sig_gbp', 'GB', { env: BASE }));
    assert.deepEqual(r.storeTools(), ['create_cart', 'create_cart']);
    await refusalOf(r.create('sig_gbp', 'GB'));
    assert.deepEqual(r.storeTools(), ['create_cart', 'create_cart']);
  });

  test('THE MARKETS: a GB mismatch refuses only GB. US, SG and an absent market are priced by the store; DE and ZZ are refused by name before anything', async () => {
    const r = rig();
    const gb = await refusalOf(r.create('sig_gbp', 'GB'));
    assert.equal(gb.detail.acp_detail.market, 'GB');
    assert.equal(r.memo.size(), 1);

    // US: the same seller answers a US cart in USD. Built, priced by the store, tracked.
    const us = await r.create('sig_usd', 'US');
    assert.equal(us.currency, 'USD');
    assert.deepEqual(us.totals.map((t) => t.amount), [2750, 2750]);
    // SG: answered in SGD.
    const sg = await r.create('sig_sgd', 'SG');
    assert.equal(sg.currency, 'SGD');
    // No market named: answered as US and labelled as assumed; the GB entry is not read for it.
    const none = await r.create('sig_usd', undefined);
    assert.equal(none.currency, 'USD');
    assert.ok(JSON.stringify(none).includes('market_assumed'));
    assert.deepEqual(r.door.calls.filter((c) => c[0] === 'create_cart').map((c) => c[1]), ['GB', 'US', 'SG', 'US']);

    // DE (a market the source does not price) and ZZ (unknown): refused by name, before the gate, the memo or any seller.
    for (const market of ['DE', 'ZZ']) {
      const before = r.door.calls.length;
      const refused = await refusalOf(r.create('sig_eur', market));
      assert.equal(refused.detail.reason, 'market_not_priced', market);
      assert.equal(refused.detail.acp_detail.market, market);
      assert.equal(r.door.calls.length, before, `${market}: no seller call`);
    }
    // A value that is no market at all.
    assert.equal((await refusalOf(r.create('sig_usd', 'USA'))).detail.reason, 'ucp_market_invalid');
    // GB is still refused from what is remembered, and nothing above renewed, removed or added an entry.
    assert.deepEqual(await refusalOf(r.create('sig_gbp', 'GB')), gb);
    assert.equal(r.memo.size(), 1);
    assert.deepEqual(r.memo.counts(), { remembered: 1, refused_without_store: 1 });
    assert.equal(r.referrals.calls.length, 3, 'GB once, US and SG once each; the assumed market asks for none');
    assert.deepEqual(r.referrals.calls.map((c) => c.market), ['GB', 'US', 'SG']);
  });

  test('NEVER ON THE SELLER ALONE: FR is refused (its store answers FR in USD) while HR, the same currency and the same seller, is still priced by the store', async () => {
    const r = rig();
    const fr = await refusalOf(r.create('sig_eur', 'FR'));
    assert.deepEqual([fr.detail.acp_detail.market, fr.detail.acp_detail.market_currency, fr.detail.acp_detail.seller_currencies], ['FR', 'EUR', ['USD']]);
    const hr = await r.create('sig_eur', 'HR');
    assert.equal(hr.currency, 'EUR');
    assert.deepEqual(hr.totals.map((t) => t.amount), [2750, 2750]);
    assert.deepEqual(r.door.calls.filter((c) => c[0] === 'create_cart').map((c) => c[1]), ['FR', 'HR']);
    // And the other way round: the FR retry is refused without the store; HR again is asked again.
    assert.deepEqual(await refusalOf(r.create('sig_eur', 'FR')), fr);
    await r.create('sig_eur', 'HR', { key: 'idem-memo-0002' });
    assert.deepEqual(r.door.calls.filter((c) => c[0] === 'create_cart').map((c) => c[1]), ['FR', 'HR', 'HR']);
  });

  test('a US request is refused from a US entry, and the refusal is shaped by THIS request: an assumed market says so, a named one does not', async () => {
    // The store answers a US cart in GBP.
    const r = rig({ answers: { US: 'GBP' } });
    const assumedFirst = await refusalOf(r.create('sig_usd', undefined));
    assert.equal(assumedFirst.detail.acp_detail.market, 'US');
    assert.equal(assumedFirst.marketAssumed, true, 'the refusal is marked as decided for an assumed market');
    assert.match(assumedFirst.detail.acp_message, /No market was named, so this was decided for a US buyer/);
    assert.equal(r.referrals.calls.length, 0, 'an assumed market asks for no referral');
    assert.deepEqual(await refusalOf(r.create('sig_usd', undefined)), assumedFirst);
    // The same pair with the market NAMED: refused from the same entry, with the refusal a named request gets
    // from the store itself (a rig of its own, nothing remembered).
    const named = await refusalOf(r.create('sig_usd', 'US'));
    const control = rig({ answers: { US: 'GBP' } });
    assert.deepEqual(named, await refusalOf(control.create('sig_usd', 'US')));
    assert.equal(named.marketAssumed, false);
    assert.doesNotMatch(named.detail.acp_message, /No market was named/);
    assert.deepEqual(r.storeTools(), ['create_cart'], 'one cart in all');
  });

  test('IT EXPIRES: one TTL after the store answered, the store is asked again; a store that now answers in the market\'s currency is served', async () => {
    const r = rig({ env: { ...MEMO_ON, [TTL_ENV]: '60000' } });
    const first = await refusalOf(r.create('sig_gbp', 'GB'));
    r.clock.advance(59999);
    assert.deepEqual(await refusalOf(r.create('sig_gbp', 'GB')), first);
    assert.deepEqual(r.storeTools(), ['create_cart']);
    // Still answering in USD at the TTL: asked again, refused again, remembered again.
    r.clock.advance(1);
    assert.deepEqual(await refusalOf(r.create('sig_gbp', 'GB')), first);
    assert.deepEqual(r.storeTools(), ['create_cart', 'create_cart']);
    assert.deepEqual(r.memo.counts(), { remembered: 2, refused_without_store: 1, expired: 1 });
    // The store fixes its currency. Until the entry is a TTL old the refusal stands; then the store is asked and served.
    r.door.answers.GB = 'GBP';
    r.clock.advance(59999);
    assert.deepEqual(await refusalOf(r.create('sig_gbp', 'GB')), first);
    r.clock.advance(1);
    const served = await r.create('sig_gbp', 'GB');
    assert.equal(served.currency, 'GBP');
    assert.deepEqual(served.totals.map((t) => t.amount), [2750, 2750]);
    assert.equal(r.memo.size(), 0);
    // And it stays served: a success writes nothing.
    assert.equal((await r.create('sig_gbp', 'GB', { key: 'idem-memo-0003' })).currency, 'GBP');
    assert.equal(r.memo.size(), 0);
  });

  test('retries do not keep an entry alive: with a retry every second, the store is asked again at the TTL', async () => {
    const r = rig({ env: { ...MEMO_ON, [TTL_ENV]: '10000' } });
    await refusalOf(r.create('sig_gbp', 'GB'));
    for (let i = 0; i < 9; i += 1) { r.clock.advance(1000); await refusalOf(r.create('sig_gbp', 'GB')); }
    assert.deepEqual(r.storeTools(), ['create_cart']);
    r.clock.advance(1000);
    await refusalOf(r.create('sig_gbp', 'GB'));
    assert.deepEqual(r.storeTools(), ['create_cart', 'create_cart']);
  });

  test('A CART WITH A CATALOG PRICE IS NOT SHORT-CUT: with a GB entry held, a priced GB row is still asked at the store and answered from the catalog; that answer writes no entry', async () => {
    const r = rig();
    // Nothing remembered: the store answers USD, the catalog's GBP price is given. No refusal, so nothing is remembered.
    const before = await r.create('sig_gbp_priced', 'GB');
    assert.equal(before.currency, 'GBP');
    assert.deepEqual(before.totals.map((t) => t.amount), [2500, 2500]);
    assert.equal(r.memo.size(), 0, 'an answered create remembers nothing');
    // A refused cart of the same seller and market writes the entry.
    await refusalOf(r.create('sig_gbp', 'GB'));
    assert.equal(r.memo.size(), 1);
    // The priced row again: the same answer as before the entry, and the store was asked for it.
    const after = await r.create('sig_gbp_priced', 'GB');
    assert.deepEqual(after, before);
    assert.deepEqual(r.storeTools(), ['create_cart', 'create_cart', 'create_cart']);
    assert.deepEqual(r.memo.counts(), { remembered: 1 }, 'not counted as refused from the memo');
  });

  test('another cart of the same seller and market that would be refused the same way IS refused from the entry, naming its own items', async () => {
    const r = rig();
    await refusalOf(r.create('sig_gbp', 'GB'));
    const two = await refusalOf(r.create('sig_gbp', 'GB', { quantity: 3, key: 'idem-memo-0004' }));
    assert.deepEqual(two.detail.acp_detail.storefront_items, ['sig_gbp']);
    assert.deepEqual(r.storeTools(), ['create_cart']);
    // What the store itself would have been refused with for that cart: the same.
    const control = rig({ env: BASE });
    assert.deepEqual(two, await refusalOf(control.create('sig_gbp', 'GB', { quantity: 3, key: 'idem-memo-0004' })));
  });

  test('a row in another currency than the market\'s is refused by the row rule as ever, with or without an entry, and writes none', async () => {
    const r = rig();
    const rowRule = await refusalOf(r.create('sig_usd', 'GB'));
    assert.match(rowRule.detail.acp_message, /is priced in USD/);
    assert.deepEqual([r.door.calls, r.memo.size()], [[], 0]);
    await refusalOf(r.create('sig_gbp', 'GB'));
    assert.deepEqual(await refusalOf(r.create('sig_usd', 'GB')), rowRule);
    assert.deepEqual(r.memo.counts(), { remembered: 1 });
  });

  test('the gate still comes first: a seller the gate declines is declined, entry or no entry', async () => {
    const r = rig();
    await refusalOf(r.create('sig_gbp', 'GB'));
    const declines = [];
    const out = await tryEscalateUcpCheckout({
      op: { id: 'create_checkout_session' }, ctx: { user_ref: 'buyer-0001' }, params: { idempotency_key: 'idem-memo-0005', quote: { items: [{ product_id: 'sig_gbp', quantity: 1 }] } },
      executor, ucpArgs: { checkout: { context: { address_country: 'GB' } } }, env: { ...MEMO_ON, MERCHANT_PURCHASABILITY_GATE_ENABLED: '1' }, now: NOW, shouldOfferPurchase: async () => ({ offer: false }), merchantDoor: r.door,
      currencyMismatchMemo: r.memo, declines,
    });
    assert.equal(out, null);
    assert.deepEqual(declines, ['merchant_not_purchasable']);
    assert.deepEqual(r.memo.counts(), { remembered: 1 });
    assert.deepEqual(r.storeTools(), ['create_cart']);
  });

  test('with seller pricing off the store is never asked, so nothing is read from an entry either', async () => {
    const r = rig();
    await refusalOf(r.create('sig_gbp', 'GB'));
    const off = { ...MEMO_ON, [MERCHANT_PRICING_FLAG]: '' };
    const control = rig({ env: off });
    assert.deepEqual(await refusalOf(r.create('sig_gbp', 'GB', { env: off })), await refusalOf(control.create('sig_gbp', 'GB')));
    assert.deepEqual(r.memo.counts(), { remembered: 1 });
  });

  test('a memo whose clock fails never fails a create: the store is asked as with the switch off', async () => {
    const r = rig();
    const memo = createCurrencyMismatchMemo({ clock: () => { throw new Error('clock down'); } });
    const call = (pid, market) => tryEscalateUcpCheckout({
      op: { id: 'create_checkout_session' }, ctx: { user_ref: 'buyer-0001' }, params: { idempotency_key: 'idem-memo-0006', quote: { items: [{ product_id: pid, quantity: 1 }] } },
      executor, ucpArgs: { checkout: { context: { address_country: market } } }, env: MEMO_ON, now: NOW, shouldOfferPurchase: allow, merchantDoor: r.door,
      currencyMismatchMemo: memo,
    });
    assert.equal((await call('sig_usd', 'US')).currency, 'USD');
    const first = await refusalOf(call('sig_gbp', 'GB'));
    assert.deepEqual(await refusalOf(call('sig_gbp', 'GB')), first);
    assert.deepEqual(r.storeTools(), ['create_cart', 'create_cart', 'create_cart']);
    assert.equal(memo.size(), 0);
  });

  // ---- where the memo is read ------------------------------------------------------------------------------------

  // Carts the seller door answers without ever contacting the store, and the reason it logs for each.
  const NEVER_ASKED = Object.freeze([
    { name: 'a product with several variants and none chosen', cart: 'sig_multi', fallback: 'variant_unresolved' },
    { name: 'a row with no price, no currency and no withheld note', cart: 'sig_unlabelled', fallback: 'catalog_currency_unknown' },
    { name: 'a row with no seller variant id', cart: 'sig_novariant', fallback: 'variant_unresolved' },
    { name: 'two lines that name the same store variant', cart: ['sig_twin_a', 'sig_twin_b'], fallback: 'duplicate_variant' },
    { name: 'a sole variant the catalog cannot confirm', cart: 'sig_derived', fallback: 'catalog_variant_count_unavailable' },
  ]);
  const pricingLines = (log, from = 0) => log.lines.slice(from).filter((l) => l.event === 'ucp_merchant_door_pricing');

  for (const c of NEVER_ASKED) {
    test(`A CART THE STORE WOULD NEVER BE ASKED ABOUT KEEPS ITS OWN ANSWER (${c.name}): with a live entry for its seller and market, it is answered exactly as with the switch off, and the memo is not read`, async () => {
      // The switch off, nothing remembered: what this cart is answered with, and that the store is not asked for it.
      const off = rig({ env: BASE });
      const expected = await refusalOf(off.create(c.cart, 'GB'));
      assert.notEqual(expected.detail.reason, 'seller_not_priced_in_market_currency', 'the fixture: this cart is not refused by the currency rule');
      assert.deepEqual([off.door.calls, off.referrals.calls], [[], []], 'the fixture: the store is never asked about this cart');
      assert.deepEqual(pricingLines(off.log).filter((l) => l.outcome === 'fallback').map((l) => l.reason), [c.fallback]);

      // The switch on, and an entry for this seller and GB written by another cart's refusal.
      const r = rig();
      const mismatch = await refusalOf(r.create('sig_gbp', 'GB'));
      assert.equal(mismatch.detail.reason, 'seller_not_priced_in_market_currency');
      assert.equal(r.memo.recall({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', env: MEMO_ON }), 'USD', 'the entry is live');
      const before = { calls: r.door.calls.length, referrals: r.referrals.calls.length, touched: r.touched.length, lines: r.log.lines.length };

      for (const attempt of [1, 2, 3]) {
        const got = await refusalOf(r.create(c.cart, 'GB', { key: `idem-memo-never-${attempt}` }));
        assert.deepEqual(got, expected, `attempt ${attempt}: code, message and detail are the switch-off answer`);
      }
      assert.equal(r.touched.length, before.touched, 'the memo was neither read nor written for it');
      assert.equal(r.door.calls.length, before.calls, 'no discovery, no cart');
      assert.equal(r.referrals.calls.length, before.referrals, 'no referral');
      assert.deepEqual(r.memo.counts(), { remembered: 1 }, 'not counted as refused from the memo');
      // The log is the switch-off log, three times over: the door's own fallback line, and no `store_not_asked`.
      assert.deepEqual(pricingLines(r.log, before.lines), [...pricingLines(off.log), ...pricingLines(off.log), ...pricingLines(off.log)]);
      // And the entry is as it was: the cart that wrote it is still refused from it.
      assert.deepEqual(await refusalOf(r.create('sig_gbp', 'GB')), mismatch);
      assert.deepEqual(r.memo.counts(), { remembered: 1, refused_without_store: 1 });
    });
  }

  test('the same carts with the switch on and NOTHING remembered: the switch-off answer, and the memo is not read', async () => {
    for (const c of NEVER_ASKED) {
      const off = rig({ env: BASE });
      const on = rig();
      assert.deepEqual(await refusalOf(on.create(c.cart, 'GB')), await refusalOf(off.create(c.cart, 'GB')), c.name);
      assert.deepEqual([on.touched, on.door.calls, on.referrals.calls], [[], [], []], c.name);
    }
  });

  test('THE ORDER OF A CREATE: the memo is read once, before discovery; the referral is asked for after discovery and before the cart. A hit stops at the read: no discovery, NO REFERRAL, no cart', async () => {
    const r = rig();
    const first = await refusalOf(r.create('sig_gbp', 'GB'));
    assert.deepEqual(r.events, ['recall', 'discover', 'mint_referral', 'create_cart'], 'nothing remembered: read, then the store and its referral');
    assert.deepEqual(r.touched, [['recall', 'GB', null], ['remember', 'GB', true]]);
    r.events.length = 0;
    for (const key of ['idem-memo-0001', 'idem-memo-order-2', 'idem-memo-order-3']) {
      assert.deepEqual(await refusalOf(r.create('sig_gbp', 'GB', { key })), first);
    }
    assert.deepEqual(r.events, ['recall', 'recall', 'recall'], 'each hit is one read and nothing else');
    assert.equal(r.referrals.calls.length, 1, 'the first attempt\'s referral, and no other');
    assert.deepEqual(r.touched.slice(2), [['recall', 'GB', 'USD'], ['recall', 'GB', 'USD'], ['recall', 'GB', 'USD']], 'A HIT WRITES NOTHING: the entry is read, never written again');
  });

  test('a hit asks for no referral even when the referral is the only thing left to ask: a minter that would answer is never called, and one that throws is never reached', async () => {
    const r = rig();
    const first = await refusalOf(r.create('sig_gbp', 'GB'));
    const minted = r.referrals.calls.length;
    r.referrals.mint = async () => { throw new Error('the referral must not be asked for on a hit'); };
    assert.deepEqual(await refusalOf(r.create('sig_gbp', 'GB')), first);
    assert.equal(r.referrals.calls.length, minted);
    assert.deepEqual(r.storeTools(), ['create_cart']);
  });

  test('a market with no currency, an unknown market and a row in another currency never reach the read', async () => {
    const r = rig();
    await refusalOf(r.create('sig_gbp', 'GB'));
    const before = r.touched.length;
    assert.equal((await refusalOf(r.create('sig_eur', 'DE'))).detail.reason, 'market_not_priced');
    assert.equal((await refusalOf(r.create('sig_eur', 'ZZ'))).detail.reason, 'market_not_priced');
    assert.equal((await refusalOf(r.create('sig_usd', 'USA'))).detail.reason, 'ucp_market_invalid');
    assert.match((await refusalOf(r.create('sig_usd', 'GB'))).detail.acp_message, /is priced in USD/);
    assert.equal(r.touched.length, before, 'the memo was not read for any of them');
  });

  test('a re-read of a checkout is never answered from an entry: the cart is read from the store, and the memo is not read', async () => {
    const r = rig({ answers: { GB: 'GBP' } });
    const made = await r.create('sig_gbp', 'GB');
    assert.equal(made.currency, 'GBP');
    // An entry for the same seller and market, as another cart's refusal would have left it.
    r.memo.remember({ sellerHost: HOST, market: 'GB', marketCurrency: 'GBP', storeCurrency: 'USD', env: MEMO_ON });
    const before = r.touched.length;
    const again = await tryEscalateUcpCheckout({
      op: { id: 'get_checkout_session' }, ctx: { user_ref: 'buyer-0001', acp_session_id: 'sess-0001' }, params: { session_id: made.id },
      executor, ucpArgs: {}, env: MEMO_ON, now: NOW, shouldOfferPurchase: allow, merchantDoor: r.door, referralMinter: r.referrals, log: r.log,
      currencyMismatchMemo: r.memo,
    });
    assert.equal(again.id, made.id);
    assert.deepEqual(again.totals, made.totals);
    assert.deepEqual(r.storeTools(), ['create_cart', 'get_cart']);
    assert.equal(r.touched.length, before, 'no read of the memo on a re-read');
  });


  describe('with the retry ledger on', () => {
    const LEDGER = { ...MEMO_ON, [STORE_CART_IDEMPOTENCY_FLAG]: '1', [ID_BINDING_SECRET_ENV]: SECRET };
    beforeEach(() => resetStoreCartIdempotencyCountsForTest());

    test('a refusal from the entry is a refused create like any other: its claim is released and nothing is recorded', async () => {
      const r = rig({ env: LEDGER });
      const store = new InMemoryKvStore();
      const first = await refusalOf(r.create('sig_gbp', 'GB', { store }));
      assert.deepEqual(await refusalOf(r.create('sig_gbp', 'GB', { store })), first);
      assert.deepEqual(await refusalOf(r.create('sig_gbp', 'GB', { store })), first);
      assert.deepEqual(storeCartIdempotencyCounts(), { claimed: 3, released: 3 });
      assert.equal(store._m.size, 0);
      assert.deepEqual(r.storeTools(), ['create_cart']);
      assert.equal(r.referrals.calls.length, 1);
    });

    test('A REPLAY IS STILL JUDGED AGAIN, not answered from the entry or around it: a recorded US checkout is read back from the store; a recorded GB one whose store now answers USD is refused on the store\'s own answer', async () => {
      const r = rig({ env: LEDGER, answers: { GB: 'GBP', US: 'USD' } });
      const store = new InMemoryKvStore();
      const us = await r.create('sig_usd', 'US', { store, key: 'idem-memo-us-1' });
      const gb = await r.create('sig_gbp', 'GB', { store, key: 'idem-memo-gb-1' });
      assert.deepEqual([us.currency, gb.currency], ['USD', 'GBP']);
      // The store starts answering GB carts in USD: a NEW GB create is refused and remembered.
      r.door.answers.GB = 'USD';
      const fresh = await refusalOf(r.create('sig_gbp', 'GB', { store, key: 'idem-memo-gb-2' }));
      assert.equal(r.memo.size(), 1);
      // The US replay is unaffected: read back with get_cart, the same checkout.
      assert.deepEqual(await r.create('sig_usd', 'US', { store, key: 'idem-memo-us-1' }), us);
      // The recorded GB checkout is read back from the store (its recorded cart still answers GBP): judged, served.
      const replayed = await r.create('sig_gbp', 'GB', { store, key: 'idem-memo-gb-1' });
      assert.equal(replayed.id, gb.id);
      assert.deepEqual(r.storeTools(), ['create_cart', 'create_cart', 'create_cart', 'get_cart', 'get_cart']);
      // The fresh key again: refused from the entry, the same refusal, no store.
      assert.deepEqual(await refusalOf(r.create('sig_gbp', 'GB', { store, key: 'idem-memo-gb-2' })), fresh);
      assert.deepEqual(r.storeTools().length, 5);
      assert.equal(storeCartIdempotencyCounts().replayed, 2);
      assert.equal(storeCartIdempotencyCounts().replay_refused, undefined);
    });
  });
});
