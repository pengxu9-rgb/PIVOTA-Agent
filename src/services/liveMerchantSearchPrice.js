'use strict';

// Read-only price verification for a served search page. Only a merchant PDP URL may select
// the storefront. A variant id must match exactly, or every variant must publish the same
// price and currency; a product-level minimum is not an offer for an arbitrary variant.
const { createPublicNetworkFetch } = require('./ucpBuyerAgentClient');

const publicFetch = createPublicNetworkFetch();
const cache = new Map();
const TTL_MS = 120000;
const TIMEOUT_MS = 1800;
const PAGE_DEADLINE_MS = 2500;
const MERCHANT_HEADERS = Object.freeze({
  'User-Agent': 'PivotaCatalog/1.0',
  Accept: 'application/json',
});

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

function unverifiedPriceReason(body, variantId) {
  const variants = body?.product?.variants;
  if (!Array.isArray(variants) || !variants.length) return 'variant_missing';
  const matching = variantId
    ? variants.filter((v) => String(v?.id || '') === variantId || String(v?.admin_graphql_api_id || '') === variantId)
    : variants;
  if (variantId && matching.length !== 1) return 'variant_missing';
  if (matching.some((v) => !String(v?.price_currency || '').trim())) return 'missing_currency';
  return 'unverifiable_price';
}

async function fetchPrice(target, fetchImpl, timeoutMs, pageSignal) {
  const now = Date.now();
  const cached = cache.get(target.url);
  if (cached && cached.expires > now) return { ...cached.value, cacheHit: true };
  const controller = new AbortController();
  const onPageAbort = () => controller.abort();
  if (pageSignal?.aborted) return { reason: 'deadline_exceeded' };
  pageSignal?.addEventListener('abort', onPageAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target.url, {
      redirect: 'error', signal: controller.signal, headers: MERCHANT_HEADERS,
    });
    if (controller.signal.aborted) return { reason: pageSignal?.aborted ? 'deadline_exceeded' : 'timeout' };
    if (!response.ok) {
      const status = Number(response.status);
      return { reason: Number.isInteger(status) && status >= 400 && status <= 599 ? `http_${status}` : 'http_error' };
    }
    let body;
    try {
      body = await response.json();
    } catch {
      return { reason: controller.signal.aborted ? (pageSignal?.aborted ? 'deadline_exceeded' : 'timeout') : 'invalid_json' };
    }
    if (controller.signal.aborted) return { reason: pageSignal?.aborted ? 'deadline_exceeded' : 'timeout' };
    const value = { body, asOf: new Date().toISOString() };
    cache.set(target.url, { value, expires: Date.now() + TTL_MS });
    if (cache.size > 1000) cache.delete(cache.keys().next().value);
    return value;
  } catch {
    return { reason: controller.signal.aborted ? (pageSignal?.aborted ? 'deadline_exceeded' : 'timeout') : 'network_error' };
  } finally {
    clearTimeout(timer);
    pageSignal?.removeEventListener('abort', onPageAbort);
  }
}

async function overlayLiveMerchantSearchPrices(response, options = {}) {
  if (!response || !Array.isArray(response.products) || !response.products.length) return response;
  const fetchImpl = options.fetchImpl || publicFetch;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : TIMEOUT_MS;
  const pageDeadlineMs = Number(options.pageDeadlineMs) > 0 ? Number(options.pageDeadlineMs) : PAGE_DEADLINE_MS;
  const pageController = new AbortController();
  let expirePage;
  const pageExpired = new Promise((resolve) => { expirePage = resolve; });
  const pageTimer = setTimeout(() => { pageController.abort(); expirePage(); }, pageDeadlineMs);
  const perHost = new Map();
  const pageFetches = new Map();
  const eligible = new Set();
  const processed = new Set();
  const failureReasons = {};
  let verified = 0;
  let drifted = 0;
  let attempted = 0;
  let cacheHits = 0;
  let closed = false;
  const countFailure = (reason) => {
    const code = reason || 'unverifiable_price';
    failureReasons[code] = (failureReasons[code] || 0) + 1;
  };
  const getProductJson = (target) => {
    if (!pageFetches.has(target.url)) {
      const cached = cache.get(target.url);
      if (!(cached && cached.expires > Date.now())) attempted += 1;
      pageFetches.set(target.url, fetchPrice(
        target, fetchImpl, timeoutMs, pageController.signal,
      ));
    }
    return pageFetches.get(target.url);
  };
  // Limit both page size and per-domain concurrency. All jobs are awaited before the response
  // leaves unless the whole-page deadline expires. A failed read keeps stored-price provenance.
  const cards = [...response.products];
  for (let index = 0; index < Math.min(20, cards.length); index += 1) {
    const card = cards[index];
    if (!card || typeof card !== 'object') continue;
    const target = targetOf(card);
    if (!target || !(Number(card.price) > 0) || !/^[A-Z]{3}$/.test(String(card.currency || ''))) continue;
    eligible.add(index);
    const host = new URL(target.url).hostname;
    if (!perHost.has(host)) perHost.set(host, []);
    perHost.get(host).push({ index, card, target });
  }
  await Promise.race([Promise.all([...perHost.values()].map(async (queue) => {
    let cursor = 0;
    async function worker() {
      while (cursor < queue.length && !closed && !pageController.signal.aborted) {
        const { index, card, target } = queue[cursor++];
        const fetched = await getProductJson(target);
        if (closed || pageController.signal.aborted) return;
        processed.add(index);
        if (fetched.cacheHit) cacheHits += 1;
        const price = fetched.body && verifiedPrice(fetched.body, target.variant);
        if (!price || price.currency !== String(card.currency).toUpperCase()) {
          cards[index] = { ...card, price_source: card.price_source || 'catalog_offer' };
          countFailure(fetched.reason || (price ? 'currency_mismatch' : unverifiedPriceReason(fetched.body, target.variant)));
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
  })), pageExpired]);
  closed = true;
  clearTimeout(pageTimer);
  if (pageController.signal.aborted) {
    for (const index of eligible) {
      if (processed.has(index)) continue;
      const card = cards[index];
      cards[index] = { ...card, price_source: card.price_source || 'catalog_offer' };
      countFailure('deadline_exceeded');
    }
  }
  return {
    ...response,
    products: cards,
    metadata: {
      ...(response.metadata || {}),
      live_merchant_price: {
        attempted: attempted > 0, eligible_count: eligible.size, fetch_attempt_count: attempted,
        cache_hit_count: cacheHits, verified_count: verified, drift_count: drifted,
        failure_reasons: failureReasons, deadline_exceeded: pageController.signal.aborted,
      },
    },
  };
}

module.exports = { targetOf, verifiedPrice, overlayLiveMerchantSearchPrices };
