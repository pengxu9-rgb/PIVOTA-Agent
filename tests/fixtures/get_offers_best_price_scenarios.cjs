'use strict';

// Fixture offers.resolve responses for get_offers' best-offer pick (tests/get_offers_fresh_best_price.node.test.cjs),
// run through the REAL handler: makeGetOffers over mapOffersResolveResponse, with the real UCP live offer reader
// (services/ucpLiveOfferRead) over a fake merchant store when a scenario declares a market. Nothing is fetched.
//
// LEGACY scenarios carry neither `price_stale` nor `best_price_offer_id` (what offers.resolve sends with
// OFFERS_RESOLVE_GROUP_SEED_SIBLINGS off). Their answers are frozen in
// get_offers_best_offer_parity_golden.json, generated from origin/main BEFORE the fresh-price change.

const { makeGetOffers, mapOffersResolveResponse } = require('../../src/agentSignals/intelligenceReads');
const { createUcpLiveOfferReader } = require('../../src/services/ucpLiveOfferRead');

const FIXED_NOW = Date.parse('2026-10-16T12:00:00.000Z');

function toolResult(payload) {
  return { ok: true, status: 200, response: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } };
}

/** A fake UCP store per host: { [host]: { handle, US: [{ id, amount (minor units), currency, available }] } }. */
function fakeUcpClient(stores) {
  return {
    async discoverEndpoint(base) {
      const host = String(base).replace(/^https?:\/\//, '').split('/')[0];
      return stores[host] ? { mcpEndpoint: `${base}/api/ucp/mcp` } : null;
    },
    async lookupCatalog(endpoint, { ids, context }) {
      const host = String(endpoint).replace(/^https?:\/\//, '').split('/')[0];
      const store = stores[host] || {};
      const variants = (store[context.address_country] || [])
        .filter((v) => ids.includes(`gid://shopify/ProductVariant/${v.id}`) || ids.includes(v.id))
        .map((v) => ({
          id: `gid://shopify/ProductVariant/${v.id}`,
          title: 'Size',
          price: { amount: v.amount, currency: v.currency },
          availability: { available: v.available },
        }));
      // A missing id is answered as Shopify answers it: an info `not_found` message (-> variant_gone).
      const gid = (id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/ProductVariant/${id}`);
      const missing = ids.filter((id) => !variants.some((v) => v.id === gid(id)));
      return toolResult({
        products: variants.length ? [{ id: 'gid://shopify/Product/1', handle: store.handle, variants }] : [],
        messages: missing.map((id) => ({ type: 'info', code: 'not_found', content: gid(id) })),
      });
    },
  };
}

function realReader(stores) {
  const r = createUcpLiveOfferReader({ ucpClient: fakeUcpClient(stores), mode: 'enforce', now: () => FIXED_NOW });
  return (offers, ctx) => r.readOffers(offers, ctx);
}

/** An offer as offers.resolve normalizes it. */
function offer(id, host, price, currency, extra = {}) {
  return {
    offer_id: id,
    merchant_id: host,
    merchant_name: host,
    price,
    currency,
    in_stock: true,
    availability: 'in_stock',
    url: `https://${host}/products/cream`,
    purchase_route: 'affiliate_outbound',
    affiliate_url: `https://api.pivota.cc/r?token=${encodeURIComponent(id)}`,
    updated_at: '2026-10-16T09:00:00+00:00',
    source: { type: 'catalog_offer', offer_id: id, canonical_url: `https://${host}/products/cream` },
    ...extra,
  };
}

/** Run one scenario through the real get_offers handler; the agent-facing answer. */
async function runScenario(scn) {
  const handler = makeGetOffers({
    fetchOffers: async () => mapOffersResolveResponse(JSON.parse(JSON.stringify(scn.backend)), 'grp_fallback'),
    ...(scn.stores ? { readOffersLive: realReader(scn.stores) } : {}),
    ...(scn.liveVerificationOptIn ? { liveVerificationOptIn: () => true } : {}),
    ...(scn.now ? { now: () => scn.now } : {}),
  });
  return handler({ payload: { product_id: 'sig_cream', ...(scn.payload || {}) } });
}

// Neither field: the answer must be byte-identical to origin/main's.
const LEGACY_SCENARIOS = {
  // No market: every currency the backend returned, compared by raw amount (today's behaviour, kept).
  no_market_mixed_currencies: {
    backend: {
      offers: [
        offer('of:a', 'a.example.com', 30, 'USD'),
        offer('of:b', 'b.example.co.uk', 20, 'GBP'),
        offer('of:c', 'c.example.jp', 2000, 'JPY'),
      ],
      mapping: { canonical_product_group_id: 'grp1' },
    },
  },
  no_market_sellable_and_verification_tiers: {
    backend: {
      offers: [
        offer('of:a', 'a.example.com', 13, 'USD', { in_stock: false, availability: 'out_of_stock' }),
        offer('of:b', 'b.example.com', 19.5, 'USD', { stock_verified: false }),
        offer('of:c', 'c.example.com', 21, 'USD', { stock_verified: true, merchant_price_verified: true }),
        offer('of:d', 'd.example.com', 18, 'USD'),
        offer('of:e', 'e.example.com', null, 'USD'),
      ],
    },
  },
  market_us_with_live_reads: {
    payload: { market: 'US' },
    liveVerificationOptIn: true,
    stores: {
      'live.example.com': { handle: 'cream', US: [{ id: '41111111', amount: 2600, currency: 'USD', available: true }] },
      'flag.example.com': { handle: 'cream', US: [{ id: '42222222', amount: 1700, currency: 'USD', available: true }] },
    },
    backend: {
      offers: [
        offer('of:live', 'live.example.com', 24, 'USD', {
          execution_spec: { merchant_domain: 'live.example.com', variant_id: '41111111', cart_url: 'https://live.example.com/cart/41111111:1?country=US' },
        }),
        offer('of:flag', 'flag.example.com', 15, 'USD', {
          in_stock: undefined,
          availability: 'unknown',
          execution_spec: { merchant_domain: 'flag.example.com', variant_id: null, cart_url: null },
          requires_live_verification: { reasons: ['stale_snapshot'], price_stale: true, lookup_variant_id: '42222222' },
          source: { type: 'external_seed', seed_id: 'eps_flag', canonical_url: 'https://flag.example.com/products/cream' },
        }),
        offer('of:plain', 'plain.example.com', 22, 'USD'),
        offer('of:gbp', 'gbp.example.co.uk', 10, 'GBP'),
      ],
    },
  },
  all_unpriced: {
    backend: { offers: [offer('of:a', 'a.example.com', null, 'USD'), offer('of:b', 'b.example.com', undefined, 'USD')] },
  },
};

module.exports = { FIXED_NOW, offer, runScenario, realReader, LEGACY_SCENARIOS };
