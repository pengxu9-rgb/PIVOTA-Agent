'use strict';
/**
 * Fix Plan D · T4 — Olive Young AFFILIATE-FEED ingest adapter (compliant 3P lane).
 *
 * DECIDED 2026-07-12: the OY data path is the affiliate network product feed, NOT
 * crawling (OY ToS prohibits commercial reproduction — see
 * docs/amazon_paapi_3p_ingest_scope.md and docs/oliveyoung_affiliate_feed_runbook.md).
 * This module is the FEED-FORMAT ADAPTER SEAM: it turns an affiliate network's
 * product datafeed record into the canonical offer shape the seed pipeline expects,
 * so the discover script (scripts/discover-oliveyoung-affiliate-offers.cjs) stays
 * format-agnostic and the mapping is unit-testable against a fixture.
 *
 * We NEVER fabricate product data. Without live credentials the lane runs only in
 * `--fixture` mode (dev/test) or fails gracefully (see hasAffiliateCredentials).
 */

const crypto = require('node:crypto');

const OY_CHANNEL = 'olive_young';
const OY_SELLER_NAME = 'Olive Young';
const OY_CANONICAL_HOSTS = ['global.oliveyoung.com', 'oliveyoung.com', 'oliveyoung.co.kr'];

function asString(v) { return String(v == null ? '' : v).trim(); }
function asObject(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

function normalizeAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const cleaned = asString(value).replace(/[^0-9.-]+/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeCurrency(value) {
  const c = asString(value).toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : '';
}

function normalizeAvailability(value) {
  const v = asString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (['in_stock', 'instock', 'available', 'in_stock_online', 'y', 'yes', 'true'].includes(v)) return 'in_stock';
  if (['out_of_stock', 'outofstock', 'unavailable', 'sold_out', 'n', 'no', 'false'].includes(v)) return 'out_of_stock';
  return v || 'unknown';
}

function normalizeUrl(value) {
  const raw = asString(value);
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return '';
  }
}

function hostOf(url) {
  try { return new URL(normalizeUrl(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/**
 * Normalize ONE raw affiliate datafeed record into the canonical offer shape.
 * Field aliases cover the common networks (Impact / CJ / Rakuten / Partnerize)
 * plus a raw OY export. Unknown fields are ignored; nothing is invented.
 */
function normalizeFeedRecord(raw, { market = 'US' } = {}) {
  const r = asObject(raw);
  const brand = asString(r.brand || r.brand_name || r.manufacturer || r.Brand);
  const title = asString(r.product_name || r.name || r.title || r.Name || r.product_title);
  const productUrl = normalizeUrl(r.product_url || r.url || r.link || r.landing_page_url || r.buy_url || r.Link);
  // Prefer the affiliate deeplink/tracking URL as the destination when present.
  const deeplink = normalizeUrl(r.deeplink || r.tracking_url || r.aff_url || r.click_url || r.affiliate_url);
  const destinationUrl = deeplink || productUrl;
  const price = normalizeAmount(
    r.price ?? r.sale_price ?? r.current_price ?? r.retail_price ?? asObject(r.pricing).amount,
  );
  const currency = normalizeCurrency(r.currency || r.price_currency || asObject(r.pricing).currency || 'USD');
  const availability = normalizeAvailability(r.availability || r.stock_status || r.in_stock || r.stock);
  const imageUrl = normalizeUrl(r.image_url || r.image || r.image_link || r.imageUrl || r.thumbnail);
  const sourceProductId = asString(r.product_id || r.sku || r.id || r.prdtNo || r.gtin);
  const category = asString(r.category || r.category_path || r.product_type || r.google_product_category);
  return {
    channel: OY_CHANNEL,
    seller_name: OY_SELLER_NAME,
    source_product_id: sourceProductId,
    brand,
    title,
    product_url: productUrl,
    destination_url: destinationUrl,
    price_amount: price,
    price_currency: currency,
    availability,
    image_url: imageUrl,
    category_path: category,
    market: asString(market || r.market || r.country || 'US').toUpperCase(),
  };
}

/**
 * Parse a raw feed PAYLOAD (already-loaded string or object) into raw records.
 * Supported formats: 'json_array' (top-level array), 'json_products'
 * ({products:[...]} / {items:[...]} / {offers:[...]}). CSV/XML adapters can be
 * registered later without touching callers.
 */
function parseFeed(payload, { format = 'auto' } = {}) {
  let data = payload;
  if (typeof payload === 'string') {
    try { data = JSON.parse(payload); } catch { return []; }
  }
  const fmt = format === 'auto'
    ? (Array.isArray(data) ? 'json_array' : 'json_products')
    : format;
  if (fmt === 'json_array') return Array.isArray(data) ? data : [];
  if (fmt === 'json_products') {
    const obj = asObject(data);
    const list = obj.products || obj.items || obj.offers || obj.data || obj.results;
    return Array.isArray(list) ? list : [];
  }
  return [];
}

/**
 * True only when the OY feed lane has real credentials configured. Without these
 * the discover script must NOT hit the network (it runs fixture-only / no-ops).
 */
function hasAffiliateCredentials(env = process.env) {
  const network = asString(env.OY_AFFILIATE_NETWORK);
  const feedUrl = asString(env.OY_AFFILIATE_FEED_URL);
  const apiKey = asString(env.OY_AFFILIATE_API_KEY || env.OY_AFFILIATE_TOKEN);
  return Boolean(network && feedUrl && apiKey);
}

/** Is this offer safe to ingest? (real OY host or affiliate deeplink, priced, sane). */
function isSafeOYOffer(offer) {
  const o = asObject(offer);
  const host = hostOf(o.product_url) || hostOf(o.destination_url);
  const hostOk = OY_CANONICAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) || Boolean(hostOf(o.destination_url));
  return Boolean(
    o.brand &&
      o.title &&
      o.destination_url &&
      hostOk &&
      o.price_amount != null &&
      o.price_amount > 0 &&
      normalizeCurrency(o.price_currency),
  );
}

function stableHash(prefix, parts, length = 16) {
  const hash = crypto.createHash('sha256').update(parts.map(asString).join('\n')).digest('hex').slice(0, length);
  return `${prefix}${hash}`;
}

/**
 * Build a seed row from a normalized OY offer — mirrors the Ulta discover shape
 * (retailerFields + discovered_via) so the same sync/resolve-first path applies.
 * `buildDiscoveredVia` is injected to reuse the T3 provenance module.
 */
function buildSeedRowFromOYOffer(offer, { market = 'US', buildDiscoveredVia } = {}) {
  const o = asObject(offer);
  const url = normalizeUrl(o.destination_url || o.product_url);
  const canonical = normalizeUrl(o.product_url) || url;
  const externalProductId = `oliveyoung:${stableHash('', [o.source_product_id || canonical, o.title], 16)}`;
  const seedId = stableHash('eps_', ['oliveyoung-affiliate-offer', externalProductId], 24);
  const imageUrls = o.image_url ? [o.image_url] : [];
  const discoveredVia = typeof buildDiscoveredVia === 'function'
    ? buildDiscoveredVia({ channel: OY_CHANNEL, evidenceUrl: canonical || url })
    : { channel: OY_CHANNEL, evidence_url: canonical || url, at: new Date().toISOString() };
  const retailerFields = {
    source_role: 'retailer_offer',
    source_listing_scope: 'retailer_offer',
    merchant_display_name: OY_SELLER_NAME,
    seller_or_retailer_name: OY_SELLER_NAME,
    seller_name: OY_SELLER_NAME,
    store_name: OY_SELLER_NAME,
    purchase_route: 'external_link_out',
    commerce_mode: 'links_out',
    checkout_handoff: 'merchant_pdp',
    external_redirect_url: url,
  };
  const snapshot = {
    source: 'oliveyoung_affiliate_feed_v1',
    extracted_at: new Date().toISOString(),
    brand: o.brand,
    source_site: 'global.oliveyoung.com',
    source_product_id: o.source_product_id || null,
    canonical_url: canonical,
    destination_url: url,
    external_redirect_url: url,
    title: o.title,
    price_amount: o.price_amount,
    price_currency: o.price_currency,
    availability: o.availability,
    image_url: o.image_url || '',
    image_urls: imageUrls,
    images: imageUrls,
  };
  return {
    seed_id: seedId,
    external_product_id: externalProductId,
    market: asString(market || o.market || 'US').toUpperCase(),
    tool: 'affiliate_feed',
    destination_url: url,
    canonical_url: canonical,
    domain: hostOf(canonical) || 'global.oliveyoung.com',
    title: o.title,
    image_url: o.image_url || null,
    price_amount: o.price_amount,
    price_currency: o.price_currency,
    availability: o.availability,
    status: 'active',
    attached_product_key: null,
    requires_seed_correction: false,
    seed_data: {
      ...retailerFields,
      brand: o.brand,
      title: o.title,
      external_product_id: externalProductId,
      canonical_url: canonical,
      destination_url: url,
      price_amount: o.price_amount,
      price_currency: o.price_currency,
      availability: o.availability,
      image_url: o.image_url || null,
      image_urls: imageUrls,
      images: imageUrls,
      category_path: o.category_path || 'beauty',
      discovered_via: discoveredVia,
      oliveyoung_affiliate: {
        contract_version: 'oliveyoung_affiliate_feed.v1',
        source_product_id: o.source_product_id || null,
      },
      snapshot: { ...snapshot, ...retailerFields, discovered_via: discoveredVia },
    },
  };
}

module.exports = {
  OY_CHANNEL,
  OY_SELLER_NAME,
  OY_CANONICAL_HOSTS,
  normalizeFeedRecord,
  parseFeed,
  hasAffiliateCredentials,
  isSafeOYOffer,
  buildSeedRowFromOYOffer,
  hostOf,
};
