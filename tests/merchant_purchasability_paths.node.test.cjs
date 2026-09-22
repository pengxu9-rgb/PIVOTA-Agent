'use strict';

// The merchant-purchasability gate on the TWO REMAINING purchase-offering paths — the ones
// docs/merchant-purchasability-gate.md §8 listed as "still offering a purchase, and NOT yet gated":
//
//   PATH 2  mcp-server/src/ucpCheckoutEscalation.js  — the `requires_escalation` checkout whose
//           `continue_url` is the observed merchant's own storefront.
//   PATH 3  src/offers/offersPriority.js             — the `merchant_checkout_url` stamped on every
//           served offer, one layer earlier than the warm handoff.
//
// SAME SWITCH, SAME CLIENT. Both go through `merchantPurchasabilityClient.shouldOfferPurchase` behind
// `MERCHANT_PURCHASABILITY_GATE_ENABLED` (default OFF). Nothing here defines a second rule.
//
// NO NETWORK. Every test drives the REAL client with a stubbed `fetchImpl` — the house pattern from
// tests/merchant_purchasability_gate.node.test.cjs. That is deliberate: a hand-written fake
// `shouldOfferPurchase` would pass while the switch, the `enforced` rule, the cache and the fail-open
// rule were all bypassed. Nothing here resolves DNS.
//
// Discovered by `scripts/run_node_test_suites.cjs` (glob over tests/**/*.node.test.cjs), which is what
// the `node-tests` job of .github/workflows/pr-full-jest.yml runs.

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GATE_FLAG_ENV,
  OPS_TOKEN_ENV,
  BASE_URL_ENV,
  MIN_GATE_BUDGET_MS,
  createMerchantPurchasabilityClient,
} = require('../src/services/merchantPurchasabilityClient');

const {
  GATE_BATCH_BUDGET_MS,
  GATE_CONCURRENCY,
  annotateOffersWithCommerceMetadata,
  annotateOffersWithCommerceMetadataGated,
  prioritizeOffersResolveResponseGated,
  readOfferMerchantDomain,
  resolveOfferPurchasabilityDecisions,
  offersGateBuyerMarket,
  isInternalOffer,
  pickDefaultOfferId,
} = require('../src/offers/offersPriority');

// ---- fixtures ----------------------------------------------------------------------------------------

const BASE = 'https://backend.example';
const TOKEN = 'admin-jwt-fixture';
// The incident merchant: readable by machines, PayPal-only at the till, USD 8.00 against our indexed 14.95.
const MERCHANT = 'flowerbeauty.com';
const MERCHANT_URL = `https://www.${MERCHANT}/products/flower-lip-gloss`;
const MARKET = 'US';

function gateEnv(extra = {}) {
  return { [GATE_FLAG_ENV]: '1', [BASE_URL_ENV]: BASE, [OPS_TOKEN_ENV]: TOKEN, ...extra };
}
function offEnv(extra = {}) {
  return { [BASE_URL_ENV]: BASE, [OPS_TOKEN_ENV]: TOKEN, ...extra };
}

const PURCHASE = { tier: 'purchase', enforced: true, sweep_enabled: true };
const BROWSE_ONLY = { tier: 'browse_only', enforced: true, sweep_enabled: true };
const NOT_ENFORCED = { tier: 'browse_only', enforced: false, sweep_enabled: true };

/**
 * A backend that answers per-domain, recording every request and every concurrent overlap.
 * `delayMs` + `clock` make the latency bounds measurable without any wall-clock sleeping.
 */
function fakeBackend(bodyFor, { status = 200, ok = true, throws = null, delayMs = 0, clock = null, malformed = false } = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (delayMs > 0) {
        if (clock) clock.advance(delayMs);
        await Promise.resolve();
        await Promise.resolve();
      }
      if (throws) throw throws;
      const domain = new URL(url).searchParams.get('domain');
      return {
        ok,
        status,
        json: async () => (malformed ? 'not-an-object' : (typeof bodyFor === 'function' ? bodyFor(domain) : bodyFor)),
      };
    } finally {
      inFlight -= 1;
    }
  };
  return { fetchImpl, calls, get maxInFlight() { return maxInFlight; } };
}

/** A monotonic fake clock: nothing in this file waits on real time. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** Collects structured log lines emitted by the client. */
function fakeLogger() {
  const lines = [];
  const sink = (level) => (detail) => lines.push({ level, ...detail });
  return { lines, warn: sink('warn'), info: sink('info'), error: sink('error') };
}

/**
 * A REAL isolated client (own env, own transport, own cache — never the process singleton) exposed as the
 * `shouldOfferPurchase` function both seams accept.
 */
function realGate({ env, backend, logger, now }) {
  const client = createMerchantPurchasabilityClient({
    env,
    fetchImpl: backend.fetchImpl,
    logger,
    ...(now ? { now } : {}),
  });
  // COUNTED. "The backend was not read" is weaker than "the gate was not consulted": with the switch off
  // the client answers `disabled` WITHOUT fetching, so a seam that ignores the switch is invisible in the
  // fetch count. `calls` is what kills that mutant.
  const gate = (args) => { gate.calls += 1; return client.shouldOfferPurchase(args); };
  gate.calls = 0;
  return gate;
}

/** Every value that ever appeared in a URL or a log line, flattened for the buyer-data grep. */
function wireAndLogValues(backend, logger) {
  const out = [];
  for (const call of backend.calls) out.push(String(call.url));
  for (const line of logger.lines) out.push(JSON.stringify(line));
  return out.join('\n');
}

// =========================================================================================================
// PATH 2 — the UCP checkout ESCALATION door (mcp-server/src/ucpCheckoutEscalation.js)
// =========================================================================================================

const ESCALATION_FLAG = 'AGENT_CHECKOUT_UCP_ESCALATION_ENABLED';

let escalationModule = null;
async function escalation() {
  if (!escalationModule) escalationModule = await import('../mcp-server/src/ucpCheckoutEscalation.js');
  return escalationModule;
}

/** One observed seed row whose purchase route is a redirect to the merchant's own storefront. */
function seedRow(productId) {
  return {
    product_id: productId,
    title: 'Flower Beauty Lip Gloss',
    price: 14.95,
    currency: 'USD',
    external_redirect_url: MERCHANT_URL,
  };
}

function fakeExecutor() {
  return {
    execute: async (opId, params) => ({ product: seedRow(params.payload.product.product_id) }),
  };
}

/** The raw UCP wire body. `checkout.context.address_country` is this repo's "buyer market, ISO-2". */
function ucpCreateArgs({ market = MARKET } = {}) {
  return {
    meta: { version: '2026-04-08' },
    checkout: {
      line_items: [{ item: { id: 'p1' }, quantity: 1 }],
      ...(market ? { context: { address_country: market } } : {}),
    },
  };
}

async function runEscalation({ env, ucpArgs, shouldOfferPurchase, timeoutMs, clock }) {
  const { tryEscalateUcpCheckout } = await escalation();
  return tryEscalateUcpCheckout({
    op: { id: 'create_checkout_session', capability: 'checkout' },
    params: { quote: { items: [{ product_id: 'p1', quantity: 1 }] } },
    ctx: {},
    executor: fakeExecutor(),
    ucpArgs,
    env,
    now: 1_700_000_000_000,
    ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
    ...(clock ? { clock } : {}),
    ...(shouldOfferPurchase ? { shouldOfferPurchase } : {}),
  });
}

test('path2/escalation: SWITCH OFF is byte-identical, and the gate is never consulted', async () => {
  const backend = fakeBackend(BROWSE_ONLY);
  const logger = fakeLogger();
  const env = { ...offEnv(), [ESCALATION_FLAG]: '1' };

  const gate = realGate({ env, backend, logger });
  const out = await runEscalation({ env, ucpArgs: ucpCreateArgs(), shouldOfferPurchase: gate });

  assert.equal(out.status, 'requires_escalation');
  assert.equal(out.continue_url, MERCHANT_URL);
  assert.equal(backend.calls.length, 0, 'switch off: nothing may be asked of the backend');
  assert.equal(gate.calls, 0, 'switch off: the gate must not be consulted at all on this path');

  // THE SNAPSHOT: the whole response, pinned — not just the URL.
  const baseline = await runEscalation({ env, ucpArgs: ucpCreateArgs() });
  assert.deepEqual(out, baseline);
});

test('path2/escalation: ON + enforced + browse_only withholds the storefront continue_url', async () => {
  const backend = fakeBackend(BROWSE_ONLY);
  const logger = fakeLogger();
  const env = { ...gateEnv(), [ESCALATION_FLAG]: '1' };

  const out = await runEscalation({
    env,
    ucpArgs: ucpCreateArgs(),
    shouldOfferPurchase: realGate({ env, backend, logger }),
  });

  // `null` = "not an escalation cart", which is exactly what this door already answers for a row that is
  // not eligible for a continue_url. No new shape, no new refusal vocabulary.
  assert.equal(out, null);
  assert.equal(backend.calls.length, 1);
  // The URL never appears anywhere — not on the wire, not in a log.
  assert.ok(!wireAndLogValues(backend, logger).includes('/products/'));
  assert.ok(logger.lines.some((l) => l.event === 'merchant_purchasability_browse_only'));
});

test('path2/escalation: ON + purchase is unchanged', async () => {
  const backend = fakeBackend(PURCHASE);
  const env = { ...gateEnv(), [ESCALATION_FLAG]: '1' };
  const out = await runEscalation({
    env, ucpArgs: ucpCreateArgs(), shouldOfferPurchase: realGate({ env, backend, logger: fakeLogger() }),
  });
  assert.equal(out.continue_url, MERCHANT_URL);
  assert.deepEqual(out, await runEscalation({ env: { ...offEnv(), [ESCALATION_FLAG]: '1' }, ucpArgs: ucpCreateArgs() }));
});

test('path2/escalation: ON + enforced=false is unchanged (tier is browse_only for EVERY merchant then)', async () => {
  const backend = fakeBackend(NOT_ENFORCED);
  const env = { ...gateEnv(), [ESCALATION_FLAG]: '1' };
  const out = await runEscalation({
    env, ucpArgs: ucpCreateArgs(), shouldOfferPurchase: realGate({ env, backend, logger: fakeLogger() }),
  });
  assert.equal(out.continue_url, MERCHANT_URL);
});

for (const [name, opts] of [
  ['500', { status: 500, ok: false }],
  ['transport throw', { throws: new Error('ECONNREFUSED') }],
  ['malformed body', { malformed: true }],
]) {
  test(`path2/escalation: ON + backend ${name} FAILS OPEN — unchanged`, async () => {
    const backend = fakeBackend(BROWSE_ONLY, opts);
    const env = { ...gateEnv(), [ESCALATION_FLAG]: '1' };
    const out = await runEscalation({
      env, ucpArgs: ucpCreateArgs(), shouldOfferPurchase: realGate({ env, backend, logger: fakeLogger() }),
    });
    assert.equal(out.continue_url, MERCHANT_URL, 'a failure must never refuse a purchase');
  });
}

test('path2/escalation: a gate answer with no `offer` key is NOT a refusal (strict === false)', async () => {
  const env = { ...gateEnv(), [ESCALATION_FLAG]: '1' };
  const out = await runEscalation({
    env, ucpArgs: ucpCreateArgs(), shouldOfferPurchase: async () => ({ source: 'gate' }),
  });
  assert.equal(out.continue_url, MERCHANT_URL);
});

test('path2/escalation: NO MARKET => unchanged, and `unkeyable` is logged — never a default market', async () => {
  const backend = fakeBackend(BROWSE_ONLY);
  const logger = fakeLogger();
  const env = { ...gateEnv(), [ESCALATION_FLAG]: '1' };

  const out = await runEscalation({
    env,
    ucpArgs: ucpCreateArgs({ market: null }),
    shouldOfferPurchase: realGate({ env, backend, logger }),
  });

  assert.equal(out.continue_url, MERCHANT_URL, 'no market is a question the gate cannot ask');
  assert.equal(backend.calls.length, 0, 'a defaulted market would have produced a read');
  assert.ok(logger.lines.some((l) => l.event === 'merchant_purchasability_unkeyable' && l.level === 'warn'));
});

test('path2/escalation: the market is the REQUEST\'s `checkout.context.address_country`, never the buyer address', async () => {
  const { escalationBuyerMarket } = await escalation();
  assert.equal(escalationBuyerMarket(ucpCreateArgs({ market: 'sg' })), 'SG');
  assert.equal(escalationBuyerMarket(ucpCreateArgs({ market: null })), null);
  assert.equal(escalationBuyerMarket({ checkout: { context: { address_country: 'USA' } } }), null);
  // A buyer's shipping country is NOT read: no buyer data may key the ops query.
  assert.equal(
    escalationBuyerMarket({ checkout: {}, quote: { shipping_address: { country: 'US' } } }),
    null,
  );
});

test('path2/escalation: the ops query carries the HOST and the market, and no buyer data', async () => {
  const backend = fakeBackend(BROWSE_ONLY);
  const logger = fakeLogger();
  const env = { ...gateEnv(), [ESCALATION_FLAG]: '1' };
  await runEscalation({
    env,
    ucpArgs: {
      ...ucpCreateArgs(),
      checkout: { ...ucpCreateArgs().checkout, buyer: { email: 'shopper@example.test' } },
    },
    shouldOfferPurchase: realGate({ env, backend, logger }),
  });

  const url = new URL(backend.calls[0].url);
  assert.equal(url.searchParams.get('domain'), MERCHANT, 'the host, not the continue_url');
  assert.equal(url.searchParams.get('market'), MARKET);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['domain', 'market']);
  const seen = wireAndLogValues(backend, logger);
  for (const forbidden of ['shopper@example.test', TOKEN, 'Bearer', 'authorization']) {
    assert.ok(!seen.toLowerCase().includes(forbidden.toLowerCase()), `buyer/credential data leaked: ${forbidden}`);
  }
});

// =========================================================================================================
// PATH 3 — the per-offer commerce stamp (src/offers/offersPriority.js)
// =========================================================================================================

function offer(id, host, extra = {}) {
  return {
    offer_id: id,
    merchant_id: `merch_obs_${host.replace(/\W/g, '')}`,
    price: { amount: 14.95, currency: 'USD' },
    url: `https://${host}/products/${id}`,
    ...extra,
  };
}

test('path3/offers: SWITCH OFF is byte-identical, and the gate is never consulted', async () => {
  const backend = fakeBackend(BROWSE_ONLY);
  const env = offEnv();
  const offers = [offer('o1', MERCHANT), offer('o2', 'example-shop.test')];

  const gate = realGate({ env, backend, logger: fakeLogger() });
  const gated = await annotateOffersWithCommerceMetadataGated(offers, {
    env, market: MARKET, shouldOfferPurchase: gate,
  });

  assert.equal(backend.calls.length, 0, 'switch off: nothing may be asked of the backend');
  assert.equal(gate.calls, 0, 'switch off: the gate must not be consulted at all on this path');
  // THE SNAPSHOT: the whole annotated array, against the un-gated function.
  assert.deepEqual(gated, annotateOffersWithCommerceMetadata(offers));
  assert.equal(gated[0].merchant_checkout_url, `https://${MERCHANT}/products/o1`);
});

test('path3/offers: ON + enforced + browse_only leaves merchant_checkout_url UNSET and KEEPS the offer', async () => {
  const backend = fakeBackend((domain) => (domain === MERCHANT ? BROWSE_ONLY : PURCHASE));
  const logger = fakeLogger();
  const env = gateEnv();
  const offers = [offer('o1', MERCHANT), offer('o2', 'example-shop.test')];

  const gated = await annotateOffersWithCommerceMetadataGated(offers, {
    env, market: MARKET, shouldOfferPurchase: realGate({ env, backend, logger }),
  });

  assert.equal(gated.length, 2, 'the OFFER survives: browse/referral is what is left');
  assert.equal(gated[0].offer_id, 'o1');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(gated[0], 'merchant_checkout_url'),
    'the key must be ABSENT, not null and not empty',
  );
  // Nothing else about the shape moved.
  assert.equal(gated[0].commerce_mode, 'links_out');
  assert.equal(gated[0].checkout_handoff, 'redirect');
  assert.equal(gated[0].seller_of_record, 'merchant');
  // The purchasable peer is untouched.
  assert.equal(gated[1].merchant_checkout_url, 'https://example-shop.test/products/o2');
  // The declined URL never reaches the wire or a log.
  assert.ok(!wireAndLogValues(backend, logger).includes('/products/o1'));
});

test('path3/offers: ON + purchase / enforced=false / 500 / throw / malformed are ALL unchanged', async () => {
  const env = gateEnv();
  const offers = [offer('o1', MERCHANT)];
  const baseline = annotateOffersWithCommerceMetadata(offers);

  const cases = [
    ['purchase', fakeBackend(PURCHASE)],
    ['enforced=false', fakeBackend(NOT_ENFORCED)],
    ['500', fakeBackend(BROWSE_ONLY, { status: 500, ok: false })],
    ['throw', fakeBackend(BROWSE_ONLY, { throws: new Error('ECONNREFUSED') })],
    ['malformed', fakeBackend(BROWSE_ONLY, { malformed: true })],
  ];
  for (const [name, backend] of cases) {
    const gated = await annotateOffersWithCommerceMetadataGated(offers, {
      env, market: MARKET, shouldOfferPurchase: realGate({ env, backend, logger: fakeLogger() }),
    });
    assert.deepEqual(gated, baseline, `${name} must be byte-identical`);
  }
});

test('path3/offers: a gate answer with no `offer` key is NOT a refusal (strict === false)', async () => {
  const offers = [offer('o1', MERCHANT)];
  const gated = await annotateOffersWithCommerceMetadataGated(offers, {
    env: gateEnv(), market: MARKET, shouldOfferPurchase: async () => ({ source: 'gate' }),
  });
  assert.deepEqual(gated, annotateOffersWithCommerceMetadata(offers));
});

test('path3/offers: NO MARKET => unchanged, and `unkeyable` is logged — never a default market', async () => {
  const backend = fakeBackend(BROWSE_ONLY);
  const logger = fakeLogger();
  const env = gateEnv();
  const offers = [offer('o1', MERCHANT)];

  const gated = await annotateOffersWithCommerceMetadataGated(offers, {
    env, market: undefined, shouldOfferPurchase: realGate({ env, backend, logger }),
  });

  assert.deepEqual(gated, annotateOffersWithCommerceMetadata(offers));
  assert.equal(backend.calls.length, 0, 'a defaulted market would have produced a read');
  assert.ok(logger.lines.some((l) => l.event === 'merchant_purchasability_unkeyable' && l.level === 'warn'));
});

test('path3/offers: N offers for ONE merchant x market cost exactly ONE backend read', async () => {
  const backend = fakeBackend(BROWSE_ONLY);
  const env = gateEnv();
  const offers = Array.from({ length: 12 }, (_, i) => offer(`o${i}`, MERCHANT));

  const gated = await annotateOffersWithCommerceMetadataGated(offers, {
    env, market: MARKET, shouldOfferPurchase: realGate({ env, backend, logger: fakeLogger() }),
  });

  assert.equal(backend.calls.length, 1, 'dedupe by (domain, market)');
  assert.equal(gated.length, 12);
  assert.ok(gated.every((o) => !Object.prototype.hasOwnProperty.call(o, 'merchant_checkout_url')));
});

test('path3/offers: a page across M merchants is BOUNDED in concurrency and in total time', async () => {
  const clock = fakeClock();
  // Each read "takes" 400 ms on the fake clock. Unbounded, 24 merchants would be 24 x 400 = 9600 ms.
  const backend = fakeBackend(PURCHASE, { delayMs: 400, clock });
  const env = gateEnv();
  const offers = Array.from({ length: 24 }, (_, i) => offer(`o${i}`, `shop${i}.test`));

  const gate = realGate({ env, backend, logger: fakeLogger(), now: clock.now });
  const startedAt = clock.now();
  await annotateOffersWithCommerceMetadataGated(offers, {
    env, market: MARKET, now: clock.now, shouldOfferPurchase: gate,
  });
  const elapsed = clock.now() - startedAt;

  assert.ok(backend.maxInFlight <= GATE_CONCURRENCY, `max in flight ${backend.maxInFlight} > ${GATE_CONCURRENCY}`);
  assert.ok(
    elapsed <= GATE_BATCH_BUDGET_MS + 400,
    `the batch must be bounded by GATE_BATCH_BUDGET_MS (${GATE_BATCH_BUDGET_MS}), took ${elapsed}`,
  );
  assert.ok(backend.calls.length < 24, 'the budget floor must stop asking, not ask everyone anyway');
  // THE FLOOR IS THIS SEAM'S, not only the client's. Without it the loop still WALKS every merchant and
  // hands each one a negative budget for the client to reject — 24 calls instead of a bounded few.
  assert.ok(gate.calls <= GATE_CONCURRENCY * 2, `the batch must stop asking; gate consulted ${gate.calls} times`);
});

test('path3/offers: below the client budget floor the gate is skipped and nothing is asked', async () => {
  const backend = fakeBackend(BROWSE_ONLY);
  const env = gateEnv();
  const offers = [offer('o1', MERCHANT)];
  const gated = await annotateOffersWithCommerceMetadataGated(offers, {
    env, market: MARKET, budgetMs: MIN_GATE_BUDGET_MS - 1,
    shouldOfferPurchase: realGate({ env, backend, logger: fakeLogger() }),
  });
  assert.deepEqual(gated, annotateOffersWithCommerceMetadata(offers));
  assert.equal(backend.calls.length, 0);
});

test('path3/offers: the ops query carries the offer host and the market, and no buyer data', async () => {
  const backend = fakeBackend(BROWSE_ONLY);
  const logger = fakeLogger();
  const env = gateEnv();
  const offers = [offer('o1', MERCHANT, {
    url: `https://www.${MERCHANT}/products/o1?utm_source=pivota&sid=sess_abc`,
    buyer_email: 'shopper@example.test',
  })];

  await resolveOfferPurchasabilityDecisions(offers, {
    env, market: MARKET, shouldOfferPurchase: realGate({ env, backend, logger }),
  });

  const url = new URL(backend.calls[0].url);
  assert.equal(url.searchParams.get('domain'), MERCHANT);
  assert.equal(url.searchParams.get('market'), MARKET);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['domain', 'market']);
  const seen = wireAndLogValues(backend, logger);
  for (const forbidden of ['shopper@example.test', 'sess_abc', 'utm_source', TOKEN, 'Bearer']) {
    assert.ok(!seen.includes(forbidden), `buyer/credential data leaked: ${forbidden}`);
  }
});

test('path3/offers: the gate asks about the SAME host the stamp would have used', async () => {
  assert.equal(readOfferMerchantDomain(offer('o1', MERCHANT)), MERCHANT);
  assert.equal(readOfferMerchantDomain({ checkout_url: `https://www.${MERCHANT}/cart` }), MERCHANT);
  assert.equal(readOfferMerchantDomain({ affiliate_url: 'https://shop.test/x' }), 'shop.test');
  assert.equal(readOfferMerchantDomain({ offer_id: 'no-url' }), null);
});

test('path3/offers: prioritizeOffersResolveResponseGated gates both response shapes', async () => {
  const env = gateEnv();
  const build = () => fakeBackend((domain) => (domain === MERCHANT ? BROWSE_ONLY : PURCHASE));

  for (const wrap of [
    (offers) => ({ status: 'success', offers }),
    (offers) => ({ status: 'success', data: { offers } }),
  ]) {
    const backend = build();
    const upstream = wrap([offer('o1', MERCHANT), offer('o2', 'example-shop.test')]);
    const out = await prioritizeOffersResolveResponseGated(upstream, {
      env, market: MARKET, shouldOfferPurchase: realGate({ env, backend, logger: fakeLogger() }),
    });
    const served = Array.isArray(out.offers) ? out.offers : out.data.offers;
    assert.equal(served.length, 2);
    const declined = served.find((o) => o.offer_id === 'o1');
    assert.ok(!Object.prototype.hasOwnProperty.call(declined, 'merchant_checkout_url'));
    assert.equal(served.find((o) => o.offer_id === 'o2').merchant_checkout_url, 'https://example-shop.test/products/o2');
  }
});

test('path2/escalation: a gate that THROWS fails open — unchanged', async () => {
  const out = await runEscalation({
    env: { ...gateEnv(), [ESCALATION_FLAG]: '1' },
    ucpArgs: ucpCreateArgs(),
    shouldOfferPurchase: async () => { throw new Error('gate exploded'); },
  });
  assert.equal(out.continue_url, MERCHANT_URL, 'a gate bug must never refuse a checkout');
});

test('path3/offers: a gate that THROWS fails open — unchanged', async () => {
  const offers = [offer('o1', MERCHANT)];
  const gated = await annotateOffersWithCommerceMetadataGated(offers, {
    env: gateEnv(),
    market: MARKET,
    shouldOfferPurchase: async () => { throw new Error('gate exploded'); },
  });
  assert.deepEqual(gated, annotateOffersWithCommerceMetadata(offers));
});

// =========================================================================================================
// REVIEW ROUND 2 — the five findings against 57de7979, each with the defect it reproduces
// =========================================================================================================

const CART_URL = `https://${MERCHANT}/cart/1:1`;

/** Every string anywhere in a value, however deeply nested. */
function deepStrings(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (node && typeof node === 'object') for (const v of Object.values(node)) deepStrings(v, out);
  return out;
}

test('F1: a SECOND annotate pass over an ALREADY-STAMPED offer still withholds the URL (delete, not skip)', async () => {
  // THE DEFECT. `buildOffersFromGroupMembers` annotates first and BOTH downstream sites re-annotate
  // its output. A conditional spread can only ADD a key, so `...offer` re-emitted the URL the first,
  // ungated pass had written and the gate was a measured no-op on both serving lanes.
  const ungated = annotateOffersWithCommerceMetadata([offer('o1', MERCHANT, { url: CART_URL })]);
  assert.equal(ungated[0].merchant_checkout_url, CART_URL, 'pass 1 stamps it (this is the stamping pass)');

  const backend = fakeBackend(BROWSE_ONLY);
  const env = gateEnv();
  const gated = await annotateOffersWithCommerceMetadataGated(ungated, {
    env, market: MARKET, shouldOfferPurchase: realGate({ env, backend, logger: fakeLogger() }),
  });

  assert.ok(
    !Object.prototype.hasOwnProperty.call(gated[0], 'merchant_checkout_url'),
    'pass 2 must DELETE what pass 1 stamped, not merely decline to add it',
  );
  assert.equal(gated[0].offer_id, 'o1', 'the offer still survives');
});

test('F1: suppression is idempotent and order-independent across three passes', async () => {
  const env = gateEnv();
  const gate = async () => ({ offer: false, source: 'gate' });
  const p1 = annotateOffersWithCommerceMetadata([offer('o1', MERCHANT, { url: CART_URL })]);
  const p2 = await annotateOffersWithCommerceMetadataGated(p1, { env, market: MARKET, shouldOfferPurchase: gate });
  const p3 = await annotateOffersWithCommerceMetadataGated(p2, { env, market: MARKET, shouldOfferPurchase: gate });
  assert.deepEqual(p3, p2);
  assert.ok(!deepStrings(p3).includes(CART_URL));
});

test('F2: a declined offer carries the cart URL in NO field anywhere — and keeps its PDP link', async () => {
  // THE DEFECT. The same storefront cart URL is served under several spellings (`offerDedupeKey` in
  // src/server.js reads five). Withholding one key while three aliases still carry it withholds nothing.
  const declinedOffer = {
    offer_id: 'o1',
    merchant_id: 'merch_obs_flower',
    price: { amount: 14.95, currency: 'USD' },
    url: CART_URL,
    external_redirect_url: `https://www.${MERCHANT}/cart/1:1?ref=pivota`,
    checkout_url: CART_URL,
    action: { label: 'Buy', url: CART_URL },
    links: [`https://${MERCHANT}/checkouts/abc`, `https://${MERCHANT}/products/gloss`],
    merchant_checkout_session: { continue_url: CART_URL, id: 'sess_1' },
    source_url: `https://${MERCHANT}/products/gloss`,
  };

  const backend = fakeBackend(BROWSE_ONLY);
  const env = gateEnv();
  const [gated] = await annotateOffersWithCommerceMetadataGated([declinedOffer], {
    env, market: MARKET, shouldOfferPurchase: realGate({ env, backend, logger: fakeLogger() }),
  });

  // DEEP WALK: no field anywhere in the served offer may carry that merchant's checkout URL.
  for (const value of deepStrings(gated)) {
    assert.ok(
      !/\/(cart|checkouts?)\b/i.test(value) || !value.includes(MERCHANT),
      `a checkout URL survived suppression: ${value}`,
    );
  }
  // BROWSE / REFERRAL STAYS — that is what the offer is now.
  assert.equal(gated.source_url, `https://${MERCHANT}/products/gloss`);
  assert.ok(gated.links.includes(`https://${MERCHANT}/products/gloss`));
  assert.equal(gated.offer_id, 'o1');
  assert.equal(gated.price.amount, 14.95);
  // A PURCHASABLE merchant is untouched by any of this.
  const [kept] = await annotateOffersWithCommerceMetadataGated([declinedOffer], {
    env, market: MARKET, shouldOfferPurchase: realGate({ env, backend: fakeBackend(PURCHASE), logger: fakeLogger() }),
  });
  assert.equal(kept.merchant_checkout_url, CART_URL);
  assert.equal(kept.action.url, CART_URL);
});

test('F2: a declined REDIRECT offer whose only URL is a product page keeps that page', async () => {
  const pdp = `https://${MERCHANT}/products/gloss`;
  const [gated] = await annotateOffersWithCommerceMetadataGated(
    [{ offer_id: 'o1', external_redirect_url: pdp }],
    { env: gateEnv(), market: MARKET, shouldOfferPurchase: async () => ({ offer: false, source: 'gate' }) },
  );
  assert.ok(!Object.prototype.hasOwnProperty.call(gated, 'merchant_checkout_url'), 'no "check out here"');
  assert.equal(gated.external_redirect_url, pdp, 'the browse link is the fallback, not collateral');
});

test('F1: the DELETE is load-bearing even where the alias sweep cannot reach — a PDP-shaped stamp', async () => {
  // WHY THIS CASE EXISTS. The alias sweep removes CHECKOUT-shaped URLs; a product page is kept on
  // purpose. So when an earlier pass stamped `merchant_checkout_url` with a PDP URL (a redirect
  // offer), the sweep will NOT take it away — only the explicit delete does. Without that delete
  // the gate silently keeps saying "check out here" for a merchant it has declined.
  const pdp = `https://${MERCHANT}/products/gloss`;
  const stamped = annotateOffersWithCommerceMetadata([{ offer_id: 'o1', external_redirect_url: pdp }]);
  assert.equal(stamped[0].merchant_checkout_url, pdp, 'pass 1 stamps the PDP URL as the checkout url');

  const [gated] = await annotateOffersWithCommerceMetadataGated(stamped, {
    env: gateEnv(), market: MARKET, shouldOfferPurchase: async () => ({ offer: false, source: 'gate' }),
  });
  assert.ok(
    !Object.prototype.hasOwnProperty.call(gated, 'merchant_checkout_url'),
    'the stamp from the earlier pass must be DELETED, not merely not-re-added',
  );
  assert.equal(gated.external_redirect_url, pdp, 'and the browse link still survives');
});

test('F3: path 2 clamps the gate to what is LEFT of the door\'s own window, and skips below the floor', async () => {
  // THE DEFECT. The first cut passed no `budgetMs`, so a BLOCKING read on the checkout critical path
  // ran on the client's 1500 ms default inside a door that had already spent part of its timeoutMs.
  const seen = [];
  const spy = async (args) => { seen.push(args.budgetMs); return { offer: true, source: 'gate' }; };
  await runEscalation({
    env: { ...gateEnv(), [ESCALATION_FLAG]: '1' },
    ucpArgs: ucpCreateArgs(),
    shouldOfferPurchase: spy,
    timeoutMs: 1000,
  });
  assert.equal(seen.length, 1);
  assert.ok(Number.isFinite(seen[0]), 'a budget must be passed at all');
  assert.ok(seen[0] <= 800, `the door's own ceiling must cap it, got ${seen[0]}`);

  // Below the client's floor the REAL client skips without reading anything.
  const clock = fakeClock();
  const backend = fakeBackend(BROWSE_ONLY);
  const env = { ...gateEnv(), [ESCALATION_FLAG]: '1' };
  const out = await runEscalation({
    env,
    ucpArgs: ucpCreateArgs(),
    shouldOfferPurchase: realGate({ env, backend, logger: fakeLogger() }),
    timeoutMs: 200,
    clock: clock.now,
  });
  assert.equal(out.continue_url, MERCHANT_URL, 'below the floor: previous behaviour');
  assert.equal(backend.calls.length, 0, 'below the floor: nothing is read');
});

test('F4: the offers batch has a REAL deadline — one hanging read cannot stall the page', async () => {
  // THE DEFECT. A budget checked only BETWEEN reads bounds how many reads START, not how long the
  // batch TAKES: 12 merchants where one read hangs was measured at 5003 ms for a 1200 ms "budget".
  const slowHost = 'slow-shop.test';
  // BOUNDED, so a regression is a FAILING test and never a hanging one: a never-resolving read would
  // deadlock the runner (and the mutant sweep) instead of reporting the defect. 3 s is far past the
  // 400 ms deadline under test and far under any CI timeout.
  let releaseHang = null;
  const hang = new Promise((resolve) => {
    releaseHang = resolve;
    const t = setTimeout(resolve, 3000);
    if (typeof t.unref === 'function') t.unref();
  });
  const asked = [];
  const gate = async ({ domain }) => {
    asked.push(domain);
    // The slow merchant answers `browse_only` LATE: if a post-deadline result were applied, it
    // would be visible in the returned set.
    if (domain === slowHost) { await hang; return { offer: false, source: 'gate' }; }
    return { offer: false, source: 'gate' };
  };

  const offers = [
    offer('slow', slowHost),
    ...Array.from({ length: 11 }, (_, i) => offer(`o${i}`, `shop${i}.test`)),
    ...Array.from({ length: 20 }, (_, i) => offer(`slowish${i}`, `late${i}.test`)),
  ];

  const startedAt = Date.now();
  const declined = await resolveOfferPurchasabilityDecisions(offers, {
    // ABOVE the client's 300 ms floor on purpose: this test is about the DEADLINE, not the floor.
    env: gateEnv(), market: MARKET, budgetMs: 400, shouldOfferPurchase: gate,
  });
  const elapsed = Date.now() - startedAt;
  releaseHang();

  assert.ok(elapsed < 1000, `the batch must return on its deadline, took ${elapsed}ms`);
  assert.ok(!declined.has(slowHost), 'a read that lands after the deadline is discarded');
  // AND NOTHING LANDS LATE. The slow merchant answers `browse_only` after the deadline; the page
  // has already been answered, so that verdict must not appear in the set the page was built from.
  const sizeAtDeadline = declined.size;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(declined.size, sizeAtDeadline, 'the returned set is a snapshot, not a live handle');
  assert.ok(!declined.has(slowHost));
  // The merchants that DID answer inside the deadline are still honoured.
  assert.ok(declined.size >= 11, 'every answer that arrived inside the deadline is still honoured');
});

test('F5: offersGateBuyerMarket reads only caller-supplied markets and NEVER defaults', () => {
  // THE DEFECT. This helper lived in src/server.js with zero coverage, and the mutant that defaults
  // it to 'US' survived the entire suite — the one substitution the gate must never make.
  assert.equal(offersGateBuyerMarket({ search: { market: 'us' } }, {}), 'us');
  assert.equal(offersGateBuyerMarket({ market: 'SG' }, {}), 'SG');
  assert.equal(offersGateBuyerMarket({}, { market: 'GB' }), 'GB');
  assert.equal(offersGateBuyerMarket({ search: { market: 'JP' } }, { market: 'GB' }), 'JP', 'search wins');
  assert.equal(offersGateBuyerMarket({}, {}), undefined, 'no market is a question the gate cannot ask');
  assert.equal(offersGateBuyerMarket(null, null), undefined);
  assert.equal(offersGateBuyerMarket({ search: { market: '   ' } }, {}), undefined);
  // And a market it cannot use must not become one the gate asks about.
  assert.equal(offersGateBuyerMarket(undefined, undefined), undefined);
});

test('F4b: the credential step runs INSIDE the caller\'s deadline, not before it', async () => {
  // THE DEFECT. `fetchFact` awaited `resolveCredential()` BEFORE arming the AbortController, so the
  // metadata server's own 1 s ceiling sat outside both budgets: a 300 ms caller could wait 1300 ms.
  let released = null;
  const hang = new Promise((resolve) => {
    released = resolve;
    const t = setTimeout(resolve, 3000); // bounded: a regression must FAIL, never hang the runner
    if (typeof t.unref === 'function') t.unref();
  });
  const client = createMerchantPurchasabilityClient({
    env: { ...gateEnv(), PIVOTA_OPS_OIDC_AUDIENCE: 'https://api.pivota.cc' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => BROWSE_ONLY }),
    // The metadata server never answers.
    metadataFetchImpl: async () => { await hang; return { ok: false, status: 500 }; },
    logger: fakeLogger(),
  });

  const startedAt = Date.now();
  const decision = await client.shouldOfferPurchase({ domain: MERCHANT, market: MARKET, budgetMs: 320 });
  const elapsed = Date.now() - startedAt;
  released();

  assert.equal(decision.offer, true, 'a credential that never arrives fails OPEN');
  assert.ok(elapsed < 1200, `the credential step must sit inside the deadline, took ${elapsed}ms`);
});

test('F1: EVERY annotate call site in src/server.js is gated — including the stamping pass', () => {
  // A UNIT TEST CANNOT SEE THIS. The defect was not in offersPriority.js at all: it was a FOURTH
  // call site (`buildOffersFromGroupMembers`) that the two gated ones re-annotate, so the gate was
  // provably applied and provably had no effect on either serving lane. The invariant is therefore
  // structural — every call site passes a decision — and it is checked the way the defect was found.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const sites = [];
  const re = /annotateOffersWithCommerceMetadata\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    // The option object may be on a later line; a call site is short, so a bounded window is enough.
    sites.push({ index: m.index, window: src.slice(m.index, m.index + 400) });
  }
  assert.equal(sites.length, 3, 'a new annotate call site must be gated and counted here');
  for (const site of sites) {
    assert.ok(
      site.window.includes('declinedDomains'),
      `an UNGATED annotate call site at offset ${site.index}: ${site.window.split('\n')[0]}`,
    );
  }
  // And every one of them is fed by a decision resolved for this request.
  assert.equal((src.match(/resolveOfferPurchasabilityDecisions\(/g) || []).length, 3);
});

// =========================================================================================================
// REVIEW ROUND 3 — the checkout URL shapes that actually occur, and the signals a URL is not
// =========================================================================================================

const DECLINE_ALL = async () => ({ offer: false, source: 'gate' });

async function declineOffer(row, domain = 'merchant.com') {
  const [out] = await annotateOffersWithCommerceMetadataGated([row], {
    env: gateEnv(), market: MARKET, shouldOfferPurchase: DECLINE_ALL,
  });
  assert.equal(readOfferMerchantDomain(row), domain, 'fixture must be for the declined merchant');
  return out;
}

test('N1: every real-world checkout URL shape is suppressed from EVERY field', async () => {
  // THE DEFECT. `CHECKOUT_PATH_RE` anchored the checkout segment at the START of the path, so the
  // two commonest shapes on the platform this gate exists for survived verbatim under
  // `checkout_url`, `external_redirect_url` AND `url` — and the byte-equal fallback was gated on
  // the shape being recognised, i.e. it switched itself off in exactly that case.
  const shapes = [
    ['classic Shopify web checkout (shop-id prefixed)', 'https://merchant.com/12345678/checkouts/abcdef'],
    ['locale-prefixed cart permalink', 'https://merchant.com/en-gb/cart/12345:1'],
    ['locale + shop-id', 'https://merchant.com/en-gb/12345678/checkouts/abcdef'],
    ['cart token permalink', 'https://merchant.com/cart/c/c1-abcdef'],
    ['checkout cn token', 'https://merchant.com/checkouts/cn/tok123'],
    ['bare cart', 'https://merchant.com/cart'],
    ['www + query', 'https://www.merchant.com/cart/1:1?ref=pivota'],
  ];
  for (const [name, url] of shapes) {
    const out = await declineOffer({
      offer_id: 'x', checkout_url: url, external_redirect_url: url, url, action: { url },
    });
    for (const value of deepStrings(out)) {
      assert.ok(!value.includes('merchant.com'), `${name}: a checkout URL survived — ${value}`);
    }
  }
});

test('N1: the byte-equal arm strips a stamped URL out of a checkout-NAMED field whatever its shape', async () => {
  // An unusual shape we do not recognise, published as the checkout url: the shape arm cannot fire,
  // so the byte-equal arm must — and it is no longer gated on the shape arm having fired.
  const odd = 'https://merchant.com/secure/pay/session-9f2';
  const out = await declineOffer({ offer_id: 'x', checkout_url: odd, external_redirect_url: odd });
  assert.ok(!Object.prototype.hasOwnProperty.call(out, 'checkout_url'), 'a field NAMED checkout must lose it');
  assert.ok(!Object.prototype.hasOwnProperty.call(out, 'merchant_checkout_url'));
  // ⚠️ DELIBERATE NARROWING, FLAGGED IN THE PR: the same value is KEPT in a browse-named field.
  // Stripping it everywhere would leave a declined redirect offer with no way to reach the product
  // at all, and browse/referral is what this gate falls back TO.
  assert.equal(out.external_redirect_url, odd, 'the browse link is the fallback, not collateral');
});

test('N2: a declined offer carries NO "buyable here" signal — not just no URL', async () => {
  // THE DEFECT. The first cut removed the URLs and left everything else: the probe below was served
  // as purchase_route:'internal_checkout', internal_checkout:{token}, merchant_checkout_session:
  // {token}, commerce_mode:'merchant_embedded_checkout', checkout_handoff:'embedded' — so
  // `isInternalOffer` was still TRUE and the row could still be picked as the page's default.
  const cart = 'https://merchant.com/cart/1:1';
  const out = await declineOffer({
    offer_id: 'x',
    merchant_id: 'm1',
    price: { amount: 10, currency: 'USD' },
    purchase_route: 'internal_checkout',
    checkout_url: cart,
    internal_checkout: { continue_url: cart, token: 'tok_1' },
  });

  assert.equal(isInternalOffer(out), false, 'the row must not read as an internal (Pivota) checkout');
  for (const field of ['internal_checkout', 'internalCheckout', 'merchant_checkout_session', 'checkout_session']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(out, field), `${field} must be gone`);
  }
  // The repo's OWN links-out vocabulary — surveyed, not invented.
  assert.equal(out.purchase_route, 'affiliate_outbound');
  assert.equal(out.commerce_mode, 'links_out');
  assert.equal(out.checkout_handoff, 'redirect');
  // The token is gone with the payload, so nothing about the session leaks either.
  assert.ok(!deepStrings(out).includes('tok_1'));
  // AND THE OFFER SURVIVES.
  assert.equal(out.offer_id, 'x');
  assert.equal(out.price.amount, 10);
});

test('N2: a declined offer loses the INTERNAL preference that could make it the default', async () => {
  const cart = 'https://merchant.com/cart/1:1';
  const declinedRow = {
    offer_id: 'declined', merchant_id: 'm1', price: { amount: 10, currency: 'USD' },
    purchase_route: 'internal_checkout', checkout_url: cart, internal_checkout: { token: 't' },
    inventory: { in_stock: true },
  };
  const purchasableRow = {
    offer_id: 'ok', merchant_id: 'm2', price: { amount: 10, currency: 'USD' },
    purchase_route: 'internal_checkout', checkout_url: 'https://good-shop.test/cart/9:1',
    inventory: { in_stock: true },
  };
  const backend = fakeBackend((domain) => (domain === 'merchant.com' ? BROWSE_ONLY : PURCHASE));
  const env = gateEnv();
  const annotated = await annotateOffersWithCommerceMetadataGated([declinedRow, purchasableRow], {
    env, market: MARKET, shouldOfferPurchase: realGate({ env, backend, logger: fakeLogger() }),
  });

  assert.equal(annotated.length, 2, 'both offers are still served');
  const declinedOut = annotated.find((o) => o.offer_id === 'declined');
  const keptOut = annotated.find((o) => o.offer_id === 'ok');
  assert.equal(isInternalOffer(declinedOut), false);
  assert.equal(isInternalOffer(keptOut), true, 'the purchasable peer is untouched');
  assert.equal(keptOut.merchant_checkout_url, 'https://good-shop.test/cart/9:1');

  // ⚠️ WHAT THIS DOES AND DOES NOT ASSERT. `src/server.js::compareOffersForDefaultSelection` ranks
  // `offerIsInternalCheckoutCandidate` FIRST, and that predicate reads `purchase_route ===
  // 'internal_checkout'` — which this row no longer says. That preference is what the gate removes.
  assert.notEqual(declinedOut.purchase_route, 'internal_checkout');
  // It does NOT make the module's own picker rank by purchasability: `compareOffersForPresentation`
  // deliberately ignores checkout transport (pinned by `prioritizeOffers does not rank by checkout
  // transport` in tests/offers/offersPriority.test.js), and the brief for this gate says in terms
  // that this seam is not ranking. So on equal price/stock the order is unchanged...
  assert.equal(pickDefaultOfferId(annotated), 'declined', 'ordinary price/stock ranking is untouched');
  // ...and ordinary ranking still works: a cheaper purchasable peer wins on its own merits.
  const cheaper = { ...keptOut, price: { amount: 9, currency: 'USD' } };
  assert.equal(pickDefaultOfferId([declinedOut, cheaper]), 'ok');
});

test('N2: the two consumers the review named still read the declined row as NOT direct', () => {
  // Neither consumer is exported, so this pins THEIR RULES AT THEIR SOURCE: if either condition is
  // edited, this fails and somebody re-checks the values above against it rather than assuming.
  const resolver = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'checkoutHandoffResolver.js'), 'utf8',
  );
  for (const token of ["purchaseRoute === 'affiliate_outbound'", "commerceMode === 'links_out'", "checkoutHandoff === 'redirect'"]) {
    assert.ok(resolver.includes(token), `isCurrentPolicyDirect no longer refuses on ${token}`);
  }
  const intel = fs.readFileSync(path.join(__dirname, '..', 'src', 'pdpProductIntel.js'), 'utf8');
  assert.ok(
    intel.includes("asString(offer?.commerce_mode) === 'merchant_embedded_checkout'"),
    'inferStructuredDataMode no longer keys on merchant_embedded_checkout',
  );
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.ok(
    server.includes("return route === 'internal_checkout';"),
    'offerIsInternalCheckoutCandidate no longer keys on the purchase_route we rewrite',
  );
});

test('N2: the mode is computed AFTER the strip and is stable across three passes', async () => {
  const cart = 'https://merchant.com/cart/1:1';
  const row = {
    offer_id: 'x', purchase_route: 'internal_checkout', checkout_url: cart,
    internal_checkout: { token: 't' }, source_url: 'https://merchant.com/products/gloss',
  };
  const p1 = await declineOffer(row);
  const p2 = (await annotateOffersWithCommerceMetadataGated([p1], {
    env: gateEnv(), market: MARKET, shouldOfferPurchase: DECLINE_ALL,
  }))[0];
  const p3 = (await annotateOffersWithCommerceMetadataGated([p2], {
    env: gateEnv(), market: MARKET, shouldOfferPurchase: DECLINE_ALL,
  }))[0];
  assert.deepEqual(p3, p2);
  assert.deepEqual(p2, p1);
  assert.equal(p3.commerce_mode, 'links_out');
  assert.equal(p3.checkout_handoff, 'redirect');
  assert.equal(p3.source_url, 'https://merchant.com/products/gloss', 'the browse link still survives');
});

test('N3: the deep strip preserves non-plain objects and fails CLOSED past its depth cap', async () => {
  const cart = 'https://merchant.com/cart/1:1';
  const when = new Date(0);
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: { url: cart } } } } } } } } } };
  const out = await declineOffer({ offer_id: 'x', url: cart, seen_at: when, buf: Buffer.from('hi'), deep });

  // 1. A Date came back as `{}` before: `Object.entries(new Date())` is empty, and the walk rebuilt
  //    every object as a plain one.
  assert.ok(out.seen_at instanceof Date, 'a Date must not be rebuilt as a plain object');
  assert.equal(out.seen_at.toISOString(), '1970-01-01T00:00:00.000Z');
  assert.ok(Buffer.isBuffer(out.buf), 'a Buffer must survive as a Buffer');
  assert.equal(out.buf.toString(), 'hi');

  // 2. Past the cap the subtree used to be returned BY REFERENCE, UNSTRIPPED — the one place the
  //    walk gave up was the one place a checkout URL was guaranteed to survive.
  assert.ok(!deepStrings(out).some((v) => v.includes('merchant.com')), 'nothing may survive past the cap');
});

test('N2a: the mode is computed on the STRIPPED row — a surviving browse link makes it links_out', async () => {
  // THE DISTINCTION THIS PINS. The unstripped row is internal (`purchase_route:'internal_checkout'`
  // plus a checkout URL) and would infer `merchant_embedded_checkout`; the stripped row is a
  // links-out row with a product page. Computing before the strip reads the signals the strip just
  // removed, and hands a declined merchant an embedded-checkout label.
  const out = await declineOffer({
    offer_id: 'x',
    purchase_route: 'internal_checkout',
    checkout_url: 'https://merchant.com/cart/1:1',
    internal_checkout: { token: 't' },
    url: 'https://merchant.com/products/gloss',
  });
  assert.equal(out.commerce_mode, 'links_out');
  assert.equal(out.url, 'https://merchant.com/products/gloss', 'the browse link is what remains');
  assert.equal(isInternalOffer(out), false);
});

test('N2e: a declined row with NO link left is still links_out, never merchant_embedded_checkout', async () => {
  const out = await declineOffer({
    offer_id: 'x',
    purchase_route: 'internal_checkout',
    checkout_url: 'https://merchant.com/cart/1:1',
    internal_checkout: { token: 't' },
  });
  // `inferCommerceMode`'s own "nothing at all" fallback is `merchant_embedded_checkout`; the
  // rewritten `purchase_route` is what keeps a declined row out of it.
  assert.equal(out.commerce_mode, 'links_out');
  assert.equal(out.checkout_handoff, 'redirect');
});

test('R1: the explicit delete catches a stamp an earlier pass wrote from a DIFFERENT url', async () => {
  // WHY THE DELETE IS NOT REDUNDANT WITH THE SWEEP. The sweep removes the stamped URL and anything
  // cart-shaped. A `merchant_checkout_url` written by an EARLIER pass, when the row's only link was
  // its product page, is neither: it is PDP-shaped and it is not byte-equal to the URL this pass
  // would stamp. Only the explicit delete takes it, and without it the offer keeps saying
  // "check out here" for a merchant we have declined.
  const out = await declineOffer({
    offer_id: 'x',
    merchant_checkout_url: 'https://merchant.com/products/gloss',
    checkout_url: 'https://merchant.com/cart/1:1',
  });
  assert.ok(
    !Object.prototype.hasOwnProperty.call(out, 'merchant_checkout_url'),
    'a stale stamp from an earlier pass must be deleted outright',
  );
});

test('QUIET LOOP: the offers batch still settles when its deadline is the ONLY thing on the loop', () => {
  // The batch's sibling of the guard in tests/merchant_purchasability_gate.node.test.cjs: with every
  // read hanging, `Promise.race([workers, deadline])` is settled by the deadline timer and nothing
  // else. Unref that timer and the page's promise never settles — silently, and only off this machine.
  const { spawnSync } = require('node:child_process');
  const modulePath = JSON.stringify(path.join(__dirname, '..', 'src', 'offers', 'offersPriority.js'));
  const result = spawnSync(process.execPath, ['-e', `
    const { resolveOfferPurchasabilityDecisions } = require(${modulePath});
    let settled = false;
    resolveOfferPurchasabilityDecisions(
      [{ offer_id: 'a', url: 'https://a.test/cart/1' }, { offer_id: 'b', url: 'https://b.test/cart/1' }],
      {
        env: { MERCHANT_PURCHASABILITY_GATE_ENABLED: '1' },
        market: 'US',
        budgetMs: 400,
        shouldOfferPurchase: () => new Promise(() => {}), // hangs forever
      },
    ).then((declined) => { settled = true; console.log('SETTLED:' + declined.size); });
    process.on('exit', () => { if (!settled) console.log('PENDING_AT_EXIT'); });
  `], { encoding: 'utf8', timeout: 20_000, cwd: path.join(__dirname, '..') });
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  assert.ok(!out.includes('PENDING_AT_EXIT'), `the loop drained with the batch still pending — an unref'd deadline:\n${out}`);
  assert.ok(out.includes('SETTLED:0'), `expected the batch to fail open on its deadline, got:\n${out}`);
});
