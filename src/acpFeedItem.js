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
  };
}

module.exports = { buildAcpFeedItem };
