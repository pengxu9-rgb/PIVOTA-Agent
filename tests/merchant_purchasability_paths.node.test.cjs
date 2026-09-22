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

async function runEscalation({ env, ucpArgs, shouldOfferPurchase }) {
  const { tryEscalateUcpCheckout } = await escalation();
  return tryEscalateUcpCheckout({
    op: { id: 'create_checkout_session', capability: 'checkout' },
    params: { quote: { items: [{ product_id: 'p1', quantity: 1 }] } },
    ctx: {},
    executor: fakeExecutor(),
    ucpArgs,
    env,
    now: 1_700_000_000_000,
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
