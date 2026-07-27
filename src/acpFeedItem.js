'use strict';

// ACP product-feed item mapper (attributed-redirect lane, D1 decision).
//
// `link` = the Pivota canonical PDP (a spec-clean product landing page whose outbound buttons are themselves
// attributed) — NOT the raw merchant URL. The signed /r attribution deep-link that pivota-backend stamps on
// external-seed products (`external_redirect_url` on products, `affiliate_url` on offers) rides separately as
// `external_redirect_url` for agents that follow tool links programmatically. The shared protocol sanitizer
// preserves that link verbatim (shape-gated) — see safety-kernel resultSanitizer ATTRIBUTED_LINK_KEYS.
//
// Pure projection, no I/O — unit-tested in isolation (tests/acp_feed_item.node.test.cjs).

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

/**
 * @param {object} p Raw product from backend find_products.
 * @param {{ buildPublicProductUrl?: (id: string) => string }} deps PDP URL builder (gateway-owned).
 */
function buildAcpFeedItem(p, { buildPublicProductUrl } = {}) {
  const o = isPlainObject(p) ? p : {};
  const productId = firstNonEmpty(o.id, o.product_id, o.sku_id, o.external_product_id);
  const attributedUrl = firstNonEmpty(o.external_redirect_url, o.affiliate_url);
  const pdpUrl = productId && typeof buildPublicProductUrl === 'function' ? buildPublicProductUrl(productId) : undefined;
  return {
    id: productId,
    title: o.title ?? o.name,
    description: o.description,
    link: pdpUrl ?? attributedUrl ?? o.link ?? o.url,
    external_redirect_url: attributedUrl,
    image_link: o.image_link ?? o.image ?? o.image_url ?? (Array.isArray(o.images) ? o.images[0] : undefined),
    price: o.price,
    currency: o.currency,
    availability: o.availability ?? (o.in_stock === false ? 'out_of_stock' : o.in_stock === true ? 'in_stock' : undefined),
    brand: o.brand ?? o.merchant_id,
    variants: o.variants,
    // ADR-018 (pivota-backend docs/adr): the connection layer and the execution
    // path are TWO fields, deliberately never collapsed into one "tier".
    //
    // `connection_layer` is supply provenance — how the row reached the index
    // (1 crawled / 2 product-synced / 3 synced + PSP). `execution_path` is what
    // this agent actually gets: attributed_redirect, warm_handoff,
    // delegated_checkout, or pivota_psp_checkout.
    //
    // They are separate because the layer number does NOT predict execution
    // quality. Warm-handoff eligibility keys on BRAND DOMAIN, not layer, so a
    // crawled layer-1 COSRX row out-executes a non-allowlisted layer-2 row; and
    // the Pivota-orchestrated ACP checkout is dark, making layer 3 currently the
    // least transactable of the three through Pivota. A single collapsed tier
    // would let a redirect-only item read as one-click — the execution-layer
    // fallback the standing rule forbids. An agent that wants to know what it
    // gets reads `execution_path`; `connection_layer` is provenance only.
    //
    // Both are `undefined` on the existing find_products lane, which does not
    // supply them, so today's feed output is byte-identical.
    connection_layer: o.connection_layer,
    execution_path: o.execution_path,
  };
}

/**
 * Is this mapped item price-quotable?
 *
 * Shopping ingesters (ChatGPT / Google) REJECT price-less items — that, and not
 * merchant realness, is why the serving catalog was never pointed at this feed
 * (every serving-eligible lane emitted `price: null` until #1824). So an item
 * that survives every other gate but cannot be quoted is DROPPED rather than
 * emitted with `price: null`: a rejected item costs us the whole submission's
 * credibility, an absent one costs us one row.
 *
 * Amount AND currency are both required, and currency is never defaulted — an
 * amount without its own currency is the INR-served-as-USD class, which is the
 * one defect on this surface that misinforms a buyer about money.
 *
 * @param {object} item Output of buildAcpFeedItem.
 */
function isQuotableFeedItem(item) {
  const o = isPlainObject(item) ? item : {};
  const amount = Number(o.price);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  return typeof o.currency === 'string' && o.currency.trim() !== '';
}

module.exports = { buildAcpFeedItem, isQuotableFeedItem };
