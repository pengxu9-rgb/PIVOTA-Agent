'use strict';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' ? v.trim() : '';
const signature = (v) => /^sig_[a-f0-9]{32}$/i.test(text(v)) ? text(v).toLowerCase() : null;

// Only canonical signature URLs prove a conflict. A retailer URL, a product-group ID, and an
// external source ID can legitimately refer to the same product without sharing a spelling.
function signatureFromProductUrl(value) {
  if (!text(value).includes('/products/')) return null;
  try {
    const url = new URL(text(value));
    if (url.hostname !== 'pivota.cc' && !url.hostname.endsWith('.pivota.cc')) return null;
    const match = /^\/products\/([^/]+)\/?$/.exec(url.pathname);
    return match ? signature(decodeURIComponent(match[1])) : null;
  } catch { return null; }
}

function recommendationIdentityConflict(item) {
  if (!object(item)) return false;
  const ids = new Set();
  const add = (v) => { const id = signature(v); if (id) ids.add(id); };
  const addUrl = (v) => { const id = signatureFromProductUrl(v); if (id) ids.add(id); };
  const carriers = [item, item.sku, item.product].filter(object);
  for (const row of carriers) {
    add(row.product_id); add(row.productId);
    for (const key of ['url', 'pdp_url', 'pdpUrl', 'product_url', 'productUrl', 'canonical_pdp_url', 'canonicalPdpUrl', 'purchase_path', 'purchasePath']) addUrl(row[key]);
    const refs = [row.canonical_product_ref, row.pdp_open?.product_ref, row.pdp_open?.get_pdp_v2_payload?.product_ref];
    for (const ref of refs) {
      if (object(ref)) { add(ref.product_id); add(ref.productId); }
      else add(ref);
    }
    addUrl(row.pdp_open?.external?.url);
    // Inspect identity-bearing evidence roots only, never comparison/alternative products.
    for (const bundle of [row.product_intel, row.pivota_insights, row.shopping_card, row.search_card]) {
      if (!object(bundle)) continue;
      add(bundle.product_id);
      add(bundle.subject?.product_id);
      if (bundle.subject?.kind === 'product' || bundle.subject?.type === 'product') add(bundle.subject.id);
    }
  }
  return ids.size > 1;
}

function sameRecommendationProduct(plan, candidate) {
  const idOf = (row) => text(row?.sku?.product_id || row?.product?.product_id || row?.product_id || row?.productId);
  const merchantOf = (row) => text(row?.sku?.merchant_id || row?.product?.merchant_id || row?.merchant_id);
  const left = idOf(plan);
  const right = idOf(candidate);
  if (!left || left !== right || recommendationIdentityConflict(plan) || recommendationIdentityConflict(candidate)) return false;
  if (signature(left)) return true;
  const merchant = merchantOf(plan);
  return Boolean(merchant && merchant === merchantOf(candidate));
}

module.exports = { recommendationIdentityConflict, sameRecommendationProduct };
