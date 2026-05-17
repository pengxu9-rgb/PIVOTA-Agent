'use strict';

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const str = typeof value === 'string' ? value : String(value);
    const trimmed = str.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function toShopifyIdText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  if (typeof value === 'object') {
    return firstNonEmptyString(
      value.id,
      value.gid,
      value.admin_graphql_api_id,
      value.productId,
      value.product_id,
      value.productGid,
      value.product_gid,
      value.variantId,
      value.variant_id,
      value.variantGid,
      value.variant_gid,
      value.code,
      value.title,
      value.name,
    );
  }
  return String(value).trim();
}

function asArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return Array.from(value);
  return [value];
}

function listShopifyIdTextValues(value) {
  return asArray(value).map(toShopifyIdText).filter(Boolean);
}

function gidCandidateSet(...values) {
  const out = new Set();
  for (const value of values) {
    const text = toShopifyIdText(value);
    if (!text) continue;
    out.add(text);
    const trimmed = text.replace(/^gid:\/\/shopify\/[^/]+\//i, '').trim();
    if (trimmed && trimmed !== text) out.add(trimmed);
    const numericTail = text.match(/(\d+)(?:\D*)$/);
    if (numericTail && numericTail[1]) out.add(numericTail[1]);
  }
  return out;
}

function gidCandidatesMatchList(candidateSet, values) {
  const expanded = gidCandidateSet(...listShopifyIdTextValues(values));
  for (const value of expanded) {
    if (candidateSet.has(value)) return true;
  }
  return false;
}

function gidMatchesList(candidate, values) {
  if (!Array.isArray(values) || values.length === 0) return false;
  const candidateSet = gidCandidateSet(candidate);
  if (candidateSet.size === 0) return false;
  return gidCandidatesMatchList(candidateSet, values);
}

// Given a Shopify-style GID like `gid://shopify/Product/123`, returns the trailing
// numeric ID `123`. Returns null for anything that doesn't fit the pattern (custom
// IDs with numeric suffixes like `internal_chydan_1` are NOT canonicalized — only
// values that look like a Shopify GID are transformed).
function canonicalShopifyNumericId(value) {
  const text = toShopifyIdText(value);
  if (!text) return null;
  const m = text.match(/^gid:\/\/shopify\/[^/]+\/(\d+)$/i);
  return m ? m[1] : null;
}

// Expand a `scope.productIds`-style array so both the raw GIDs AND their numeric
// tails are present. Storing both forms keeps the admin UI's view stable (it sees
// what it sent) while ensuring any matcher that hasn't been GID-normalized still
// hits. De-duped; preserves first-seen order.
function expandProductIdScope(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    const text = toShopifyIdText(raw);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    const numeric = canonicalShopifyNumericId(text);
    if (numeric && !seen.has(numeric)) {
      seen.add(numeric);
      out.push(numeric);
    }
  }
  return out;
}

module.exports = {
  toShopifyIdText,
  listShopifyIdTextValues,
  gidCandidateSet,
  gidCandidatesMatchList,
  gidMatchesList,
  canonicalShopifyNumericId,
  expandProductIdScope,
};
