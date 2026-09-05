'use strict';

/*
 * The one host a live Shopify Admin API token may ever be sent to.
 *
 * `merchant_stores.domain` is a plain text column. The gateway only READS it — every writer lives in
 * the pivota-backend repo — so nothing in this process can assume the value was ever constrained.
 * It reaches `https://${domain}/admin/api/<version>/shop.json` carrying `X-Shopify-Access-Token`,
 * which makes a wrong row not merely an SSRF but an EXPORT of a working Admin credential to whatever
 * host that row names. That asymmetry is why this refuses by shape rather than by blocklist: a
 * private-range check alone would still hand the token to `attacker.example`.
 *
 * The Shopify Admin API is served ONLY on `<shop>.myshopify.com`. A custom storefront domain does not
 * answer /admin/api at all, so pinning the host removes no working lookup — it turns a request that
 * was already guaranteed to fail into a local refusal that costs no packet and leaks no credential.
 *
 * The regex is deliberately byte-identical in intent to the backend's `_validate_myshopify_domain`
 * (routes/merchant_store_connections.py:145) so the two repos agree on one shop-handle shape. That
 * guard runs on the OAuth *input*; the value actually persisted comes from the upstream shop.json
 * `myshopify_domain` field and is re-validated by neither side. A guard on one path does not cover
 * the other, which is precisely why this exists at the read path too.
 */

// Anchored, ASCII-only, single label. Everything hostile fails on the character class rather than on
// a special case: `@` (userinfo), `:` (port), `%` (percent-encoding), `[`/`]` (IPv6 literal), a
// trailing dot, an ideographic full stop `。` and every other IDN homograph, tabs and newlines. It is
// also why a raw IP literal can never match — there is no digits-only form ending in .myshopify.com.
const SHOPIFY_ADMIN_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Reduce a stored `domain` to the exact host an Admin API call may target, or null.
 *
 * Normalisation here is purely LEXICAL and never goes through `new URL()`. WHATWG parsing applies
 * IDNA, which maps `。` (U+3002) onto `.` and would turn `shop。myshopify.com` — a name Shopify never
 * issued — into a passing `shop.myshopify.com`. Parsing also keeps the brackets on an IPv6 literal.
 * Trimming a few known-benign wrappers and then demanding an exact match on what is LEFT cannot be
 * widened by any encoding trick: whatever survives the trim must itself be the literal host.
 *
 * @param {unknown} raw value of merchant_stores.domain
 * @returns {string|null} canonical `<shop>.myshopify.com`, or null if it is not one
 */
function normalizeShopifyAdminHost(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  let host = String(raw).trim();
  if (!host) return null;
  // Historic rows sometimes carry a scheme and/or a trailing slash. Both are stripped because the
  // caller used to interpolate the column straight into a URL, so those rows were already reaching
  // the network; nothing else about the value is forgiven.
  host = host.replace(/^https?:\/\//i, '');
  // Cut at the first path, query or fragment delimiter. Anything after it cannot be part of the host,
  // and leaving it in place is how `evil.example/#.myshopify.com` gets read as a myshopify name.
  const cut = host.search(/[/?#]/);
  if (cut !== -1) host = host.slice(0, cut);
  host = host.toLowerCase();
  return SHOPIFY_ADMIN_HOST.test(host) ? host : null;
}

module.exports = { normalizeShopifyAdminHost, SHOPIFY_ADMIN_HOST };
