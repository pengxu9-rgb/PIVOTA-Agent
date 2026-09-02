'use strict';

// External-seed cards that this gateway builds in JavaScript straight from
// Postgres (buildExternalSeedProduct / buildExternalSeedBrandSearchProduct) ship
// with a RAW `destination_url` and no `external_redirect_url`. Cards the Python
// backend builds ship a signed `/r?token=` redirect plus an attributed
// destination. This process holds no signing secret by design
// (safety-kernel/src/protocol/resultSanitizer.js: the backend stamps those
// links), so the only way a JS-built card can carry a click id is to ask the
// backend to mint one.
//
// The mint call is deliberately CALLER-INDEPENDENT: search_catalog results are
// cached and shared across callers (mcp-server/src/commerceToolSurface.js), so a
// link minted for one caller is served to the next. It therefore carries only
// the internal PIVOTA_API_KEY headers — no X-Buyer-Ref, no X-Agent-User-JWT, no
// caller key.

const axios = require('axios');

const EXTERNAL_SEED_MERCHANT_ID = 'external_seed';
const MAX_SEED_LINK_CANDIDATES = 50;
const DEFAULT_ATTRIBUTION_TIMEOUT_MS = 800;
const SEED_LINK_PATH = '/agent/shop/v1/attribution/external-seed-links';

// Fields copied straight through from the card onto the mint candidate when
// present. All are optional; the backend treats an absent/null one as unknown.
const PASSTHROUGH_CANDIDATE_FIELDS = [
  'utm_template',
  'domain',
  'attached_product_key',
  'attached_variant_id',
  'seller_ref',
  'seed_kind',
  'variant_id',
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  if (typeof value !== 'string') {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function usableHttpUrl(value) {
  const raw = nonEmptyString(value);
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return raw;
}

// Default ON. Any value other than '1' (an explicitly set, non-'1' value)
// disables the hook entirely, which keeps the res.json interceptor synchronous.
function isExternalSeedAttributionStampEnabled(env = process.env) {
  const raw = env ? env.EXTERNAL_SEED_ATTRIBUTION_STAMP_ENABLED : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  return String(raw).trim() === '1';
}

function externalSeedAttributionTimeoutMs(env = process.env) {
  const raw = Number(env ? env.EXTERNAL_SEED_ATTRIBUTION_TIMEOUT_MS : undefined);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_ATTRIBUTION_TIMEOUT_MS;
}

function isExternalSeedCard(card) {
  if (!isPlainObject(card)) return false;
  const source = String(card.source || '').trim().toLowerCase();
  const merchantId = String(card.merchant_id || '').trim().toLowerCase();
  return source === EXTERNAL_SEED_MERCHANT_ID || merchantId === EXTERNAL_SEED_MERCHANT_ID;
}

// A card is a stamp candidate only when it is an external-seed card with a
// usable http(s) destination, a seed id to join on, and NO external_redirect_url
// at all. An existing redirect is never second-guessed or replaced.
function collectUnattributedSeedCards(products, { env = process.env } = {}) {
  if (!Array.isArray(products)) return [];
  if (!isExternalSeedAttributionStampEnabled(env)) return [];
  const out = [];
  for (const card of products) {
    if (!isExternalSeedCard(card)) continue;
    if (nonEmptyString(card.external_redirect_url)) continue;
    if (!usableHttpUrl(card.destination_url)) continue;
    if (!nonEmptyString(card.external_seed_id)) continue;
    out.push(card);
  }
  return out;
}

// `market` / `tool` describe the REQUEST and travel at the body top level (see
// createBackendSeedLinkFetcher); the per-candidate `market` / `tool` describe the
// seed row and stay null when the card carries none.
function buildSeedLinkCandidates(cards, { market = null, tool = null } = {}) { // eslint-disable-line no-unused-vars
  if (!Array.isArray(cards)) return [];
  const candidates = [];
  for (const card of cards) {
    if (candidates.length >= MAX_SEED_LINK_CANDIDATES) break;
    if (!isPlainObject(card)) continue;
    const externalSeedId = nonEmptyString(card.external_seed_id);
    const destinationUrl = usableHttpUrl(card.destination_url);
    if (!externalSeedId || !destinationUrl) continue;
    const candidate = {
      external_seed_id: externalSeedId,
      external_product_id:
        nonEmptyString(card.external_product_id) ||
        nonEmptyString(card.product_id) ||
        nonEmptyString(card.id) ||
        null,
      destination_url: destinationUrl,
      canonical_url: nonEmptyString(card.canonical_url),
      market: nonEmptyString(card.market),
      tool: nonEmptyString(card.tool),
    };
    for (const field of PASSTHROUGH_CANDIDATE_FIELDS) {
      candidate[field] =
        card[field] === undefined || card[field] === '' ? null : card[field];
    }
    candidates.push(candidate);
  }
  return candidates;
}

function indexLinksBySeedId(links) {
  const bySeedId = new Map();
  const byProductId = new Map();
  for (const link of links) {
    if (!isPlainObject(link)) continue;
    const seedId = nonEmptyString(link.external_seed_id);
    if (seedId && !bySeedId.has(seedId)) bySeedId.set(seedId, link);
    const productId = nonEmptyString(link.external_product_id);
    if (productId && !byProductId.has(productId)) byProductId.set(productId, link);
  }
  return { bySeedId, byProductId };
}

function resolveLinkForCard(card, index) {
  const seedId = nonEmptyString(card.external_seed_id);
  if (seedId && index.bySeedId.has(seedId)) return index.bySeedId.get(seedId);
  const productId =
    nonEmptyString(card.external_product_id) ||
    nonEmptyString(card.product_id) ||
    nonEmptyString(card.id);
  if (productId && index.byProductId.has(productId)) return index.byProductId.get(productId);
  return null;
}

// Mutates the matching cards IN PLACE. Fail-soft: any throw from `fetchLinks`,
// or any non-array response, stamps nothing and reports the error. Never throws.
async function stampExternalSeedAttribution(
  products,
  { fetchLinks, market = null, tool = null, logger = null, env = process.env } = {},
) {
  const cards = collectUnattributedSeedCards(products, { env });
  const candidates = buildSeedLinkCandidates(cards, { market, tool });
  if (!candidates.length) return { candidates: 0, stamped: 0 };
  if (typeof fetchLinks !== 'function') {
    return { candidates: candidates.length, stamped: 0, error: 'fetch_links_unavailable' };
  }

  let links = null;
  try {
    links = await fetchLinks(candidates, { market, tool });
  } catch (err) {
    const message = err?.message || String(err);
    if (logger?.warn) {
      logger.warn(
        { candidates: candidates.length, err: message },
        'external seed attribution mint failed; serving raw destination urls',
      );
    }
    return { candidates: candidates.length, stamped: 0, error: message };
  }

  if (!Array.isArray(links)) {
    if (logger?.warn) {
      logger.warn(
        { candidates: candidates.length },
        'external seed attribution mint returned a non-array links payload',
      );
    }
    return { candidates: candidates.length, stamped: 0, error: 'invalid_links_payload' };
  }

  const index = indexLinksBySeedId(links);
  let stamped = 0;
  // Only the cards that produced a candidate may be stamped, so a truncated
  // (>50) page cannot pick up a link meant for a card we never sent.
  const stampable = cards.slice(0, MAX_SEED_LINK_CANDIDATES);
  for (const card of stampable) {
    const link = resolveLinkForCard(card, index);
    if (!link) continue;
    const redirectUrl = usableHttpUrl(link.external_redirect_url);
    if (!redirectUrl) continue;
    card.external_redirect_url = redirectUrl;
    // A null destination means the backend minted a referral link but no
    // attributed destination: keep the card's own raw url rather than blanking it.
    const attributedDestination = nonEmptyString(link.destination_url);
    if (attributedDestination) card.destination_url = attributedDestination;
    const cartUrl = nonEmptyString(link.cart_url);
    if (cartUrl) card.cart_url = cartUrl;
    if (isPlainObject(link.tracking)) card.tracking = link.tracking;
    stamped += 1;
  }
  return { candidates: candidates.length, stamped };
}

// HTTP implementation of `fetchLinks`, shaped like fetchSimilarProductsFromUpstream
// in src/server.js but on a short, independent budget: this is a best-effort
// enrichment and must never hold a search response open.
function createBackendSeedLinkFetcher({
  apiBase,
  buildHeaders,
  timeoutMs = null,
  env = process.env,
} = {}) {
  return async function fetchExternalSeedLinks(candidates, { market = null, tool = null } = {}) {
    const base = String(apiBase || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('PIVOTA_API_BASE is not configured');
    const headers = typeof buildHeaders === 'function' ? buildHeaders() : buildHeaders || {};
    const resp = await axios({
      method: 'POST',
      url: `${base}${SEED_LINK_PATH}`,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      timeout:
        Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
          ? Number(timeoutMs)
          : externalSeedAttributionTimeoutMs(env),
      data: {
        market: nonEmptyString(market),
        tool: nonEmptyString(tool),
        candidates,
      },
    });
    return Array.isArray(resp?.data?.links) ? resp.data.links : null;
  };
}

module.exports = {
  EXTERNAL_SEED_MERCHANT_ID,
  MAX_SEED_LINK_CANDIDATES,
  DEFAULT_ATTRIBUTION_TIMEOUT_MS,
  SEED_LINK_PATH,
  isExternalSeedAttributionStampEnabled,
  externalSeedAttributionTimeoutMs,
  collectUnattributedSeedCards,
  buildSeedLinkCandidates,
  stampExternalSeedAttribution,
  createBackendSeedLinkFetcher,
};
