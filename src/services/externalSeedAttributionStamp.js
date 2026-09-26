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

// ADR-009: detect the LANE, not the seller. Comparing the merchant identity
// against the sentinel seller is the shape the ratchet forbids — it goes blind
// the moment seed rows are re-keyed onto their observed sellers, while these two
// fields are what actually survive that migration. Both JS seed builders emit
// both (externalSeedProducts.js ~4490/4514 and ~4781/4797).
const SEED_LANE_SOURCE = 'external_seed';
const SEED_LANE_PLATFORM = 'external';
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

const KILL_SWITCH_ON_VALUES = new Set(['1', 'true', 'on', 'yes']);
const KILL_SWITCH_OFF_VALUES = new Set(['0', 'false', 'off', 'no']);
let unrecognizedKillSwitchWarned = false;

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

function sameOrigin(candidateUrl, referenceUrl) {
  try {
    return new URL(candidateUrl).origin === new URL(referenceUrl).origin;
  } catch (_) {
    return false;
  }
}

// Default ON. Both truthy and falsy spellings are accepted so that an operator
// reaching for the kill switch in an incident cannot accidentally ARM the thing
// they meant to disarm ('true' used to read as OFF). An unrecognized value is
// treated as ON — a typo must not silently drop attribution — and warns once.
function isExternalSeedAttributionStampEnabled(env = process.env, logger = null) {
  const raw = env ? env.EXTERNAL_SEED_ATTRIBUTION_STAMP_ENABLED : undefined;
  const normalized = String(raw === undefined || raw === null ? '' : raw)
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  if (KILL_SWITCH_ON_VALUES.has(normalized)) return true;
  if (KILL_SWITCH_OFF_VALUES.has(normalized)) return false;
  if (!unrecognizedKillSwitchWarned) {
    unrecognizedKillSwitchWarned = true;
    if (logger?.warn) {
      logger.warn(
        { value: normalized },
        'unrecognized EXTERNAL_SEED_ATTRIBUTION_STAMP_ENABLED value; treating the stamp as enabled',
      );
    }
  }
  return true;
}

function externalSeedAttributionTimeoutMs(env = process.env) {
  const raw = Number(env ? env.EXTERNAL_SEED_ATTRIBUTION_TIMEOUT_MS : undefined);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_ATTRIBUTION_TIMEOUT_MS;
}

function isExternalSeedLaneCard(card) {
  if (!isPlainObject(card)) return false;
  const source = String(card.source || '').trim().toLowerCase();
  const platform = String(card.platform || '').trim().toLowerCase();
  return source === SEED_LANE_SOURCE || platform === SEED_LANE_PLATFORM;
}

// A card is a stamp candidate only when it is on the external-seed lane with a
// usable http(s) destination, a seed id to join on, and NO external_redirect_url
// at all. An existing redirect is never second-guessed or replaced.
function collectUnattributedSeedCards(products, { env = process.env, logger = null } = {}) {
  if (!Array.isArray(products)) return [];
  if (!isExternalSeedAttributionStampEnabled(env, logger)) return [];
  const out = [];
  for (const card of products) {
    if (!isExternalSeedLaneCard(card)) continue;
    if (nonEmptyString(card.external_redirect_url)) continue;
    if (!usableHttpUrl(card.destination_url)) continue;
    if (!nonEmptyString(card.external_seed_id)) continue;
    out.push(card);
  }
  return out;
}

// The per-candidate `market` / `tool` describe the SEED ROW and stay null when
// the card carries none; the request's market/tool travel at the body top level
// (see createBackendSeedLinkFetcher).
function buildSeedLinkCandidates(cards) {
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
  const cards = collectUnattributedSeedCards(products, { env, logger });
  const candidates = buildSeedLinkCandidates(cards);
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
    // The card's own raw url is the origin of record. The redirect itself is
    // deliberately NOT origin-checked against it: it is our own first-party
    // /r?token= host, which is a different origin on purpose.
    const rawDestination = card.destination_url;
    card.external_redirect_url = redirectUrl;
    // A null destination means the backend minted a referral link but no
    // attributed destination: keep the card's own raw url rather than blanking
    // it. A destination on a DIFFERENT origin is refused outright — a mint
    // response must never be able to move a card's merchant.
    const attributedDestination = usableHttpUrl(link.destination_url);
    if (attributedDestination && sameOrigin(attributedDestination, rawDestination)) {
      card.destination_url = attributedDestination;
    }
    const cartUrl = usableHttpUrl(link.cart_url);
    if (cartUrl && sameOrigin(cartUrl, rawDestination)) {
      card.cart_url = cartUrl;
    }
    // Copy per card: two cards resolving to one link must not share a mutable
    // tracking object that a later consumer could edit for both.
    if (isPlainObject(link.tracking)) card.tracking = { ...link.tracking };
    stamped += 1;
  }
  return { candidates: candidates.length, stamped };
}

// Records what the mint was asked for and what it delivered, on the body that is
// actually about to be sent. Written at send time because the refine and
// page-size passes rebuild `metadata`. A run with zero candidates says nothing
// worth reporting, so the key stays absent rather than reading as "0 stamped".
function applyExternalSeedAttributionMetadata(responseBody, counts) {
  if (!isPlainObject(responseBody)) return responseBody;
  if (!isPlainObject(counts) || !(Number(counts.candidates) > 0)) return responseBody;
  const metadata = isPlainObject(responseBody.metadata) ? responseBody.metadata : {};
  metadata.external_seed_attribution = {
    candidates: Number(counts.candidates) || 0,
    stamped: Number(counts.stamped) || 0,
  };
  responseBody.metadata = metadata;
  return responseBody;
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
    const headers = typeof buildHeaders === 'function' ? buildHeaders() : buildHeaders;
    // No internal key, no mint. buildInvokeUpstreamAuthHeaders falls back to the
    // CALLER's key when PIVOTA_API_KEY is unset, and a caller-scoped mint would
    // put one caller's identity behind links that every other caller is then
    // served from cache. Failing here lands on the fail-soft path: raw
    // destination urls, cards untouched.
    if (!isPlainObject(headers)) throw new Error('internal_key_unavailable');
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
  SEED_LANE_SOURCE,
  SEED_LANE_PLATFORM,
  MAX_SEED_LINK_CANDIDATES,
  DEFAULT_ATTRIBUTION_TIMEOUT_MS,
  SEED_LINK_PATH,
  isExternalSeedAttributionStampEnabled,
  externalSeedAttributionTimeoutMs,
  collectUnattributedSeedCards,
  buildSeedLinkCandidates,
  stampExternalSeedAttribution,
  applyExternalSeedAttributionMetadata,
  createBackendSeedLinkFetcher,
};
