'use strict';

// Read-only price verification for a served search page. Only a merchant PDP URL may select
// the storefront. A variant id must match exactly, or every variant must publish the same
// price and currency; a product-level minimum is not an offer for an arbitrary variant.
const { createPublicNetworkFetch } = require('./ucpBuyerAgentClient');

const publicFetch = createPublicNetworkFetch();
const cache = new Map();
const TTL_MS = 120000;
const TIMEOUT_MS = 800;

function targetOf(card) {
  const raw = card?.destination_url || card?.merchant_canonical_url || card?.source_url;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const match = url.pathname.match(/^\/products\/([a-z0-9][a-z0-9-]*)\/?$/i);
    if (!match) return null;
    const variant = String(card.source_variant_id || url.searchParams.get('variant') || '').trim();
    return { url: `${url.origin}/products/${match[1]}.json`, variant };
  } catch {
    return null;
  }
}

function verifiedPrice(body, variantId) {
  const variants = body?.product?.variants;
  if (!Array.isArray(variants) || !variants.length) return null;
  const matching = variantId
    ? variants.filter((v) => String(v?.id || '') === variantId || String(v?.admin_graphql_api_id || '') === variantId)
    : variants;
  if (variantId && matching.length !== 1) return null;
  const prices = matching.map((v) => {
    const raw = String(v?.price ?? '');
    const currency = String(v?.price_currency || '').trim().toUpperCase();
    if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(raw) || !/^[A-Z]{3}$/.test(currency)) return null;
    const amount = Number(raw);
    return amount > 0 ? { amount, currency } : null;
  });
  if (prices.some((p) => !p)) return null;
  if (prices.some((p) => p.amount !== prices[0].amount || p.currency !== prices[0].currency)) return null;
  return prices[0];
}

async function fetchPrice(target, fetchImpl, timeoutMs) {
  const now = Date.now();
  const cached = cache.get(target.url);
  if (cached && cached.expires > now) return cached.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target.url, { redirect: 'error', signal: controller.signal });
    if (!response.ok) return null;
    const body = await response.json();
    const value = { body, asOf: new Date().toISOString() };
    cache.set(target.url, { value, expires: Date.now() + TTL_MS });
    if (cache.size > 1000) cache.delete(cache.keys().next().value);
    return value;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function overlayLiveMerchantSearchPrices(response, options = {}) {
  if (!response || !Array.isArray(response.products) || !response.products.length) return response;
  const fetchImpl = options.fetchImpl || publicFetch;
  const timeoutMs = options.timeoutMs || TIMEOUT_MS;
  const perHost = new Map();
  let verified = 0;
  let drifted = 0;
  // Limit both page size and per-domain concurrency. All jobs are awaited before the response
  // leaves; on a failed fetch the stored offer remains visible with its provenance.
  const cards = [...response.products];
  for (let index = 0; index < Math.min(20, cards.length); index += 1) {
    const card = cards[index];
    if (!card || typeof card !== 'object') continue;
    const target = targetOf(card);
    if (!target || !(Number(card.price) > 0) || !/^[A-Z]{3}$/.test(String(card.currency || ''))) continue;
    const host = new URL(target.url).hostname;
    if (!perHost.has(host)) perHost.set(host, []);
    perHost.get(host).push({ index, card, target });
  }
  await Promise.all([...perHost.values()].map(async (queue) => {
    let cursor = 0;
    async function worker() {
      while (cursor < queue.length) {
        const { index, card, target } = queue[cursor++];
        const fetched = await fetchPrice(target, fetchImpl, timeoutMs);
        const price = fetched && verifiedPrice(fetched.body, target.variant);
        if (!price || price.currency !== String(card.currency).toUpperCase()) {
          cards[index] = { ...card, price_source: card.price_source || 'catalog_offer' };
          continue;
        }
        verified += 1;
        if (Math.abs(Number(card.price) - price.amount) > 0.01) drifted += 1;
        cards[index] = {
          ...card, price: price.amount, price_amount: price.amount,
          currency: price.currency, price_currency: price.currency,
          price_source: 'merchant_live', price_as_of: fetched.asOf,
        };
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker()));
  }));
  return {
    ...response,
    products: cards,
    metadata: {
      ...(response.metadata || {}),
      live_merchant_price: { attempted: true, verified_count: verified, drift_count: drifted },
    },
  };
}

module.exports = { targetOf, verifiedPrice, overlayLiveMerchantSearchPrices };
