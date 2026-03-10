'use strict';

// -----------------------------------------------------------------------
// Pure mapper / helper functions extracted from routes.js for dupe_suggest.
// These have NO external async dependencies and can be unit-tested in isolation.
// -----------------------------------------------------------------------

function joinBrandAndName(brandRaw, nameRaw) {
  const brand = String(brandRaw || '').trim();
  const name = String(nameRaw || '').trim();
  if (!brand) return name;
  if (!name) return brand;
  const brandLower = brand.toLowerCase();
  const nameLower = name.toLowerCase();
  if (nameLower === brandLower || nameLower.startsWith(`${brandLower} `)) return name;
  return `${brand} ${name}`.trim();
}

function unwrapProductLike(inputObj) {
  const base = inputObj && typeof inputObj === 'object' && !Array.isArray(inputObj) ? inputObj : null;
  if (!base) return null;
  const nestedProduct = base.product && typeof base.product === 'object' && !Array.isArray(base.product) ? base.product : null;
  const nestedSku = base.sku && typeof base.sku === 'object' && !Array.isArray(base.sku) ? base.sku : null;
  if (nestedProduct) return nestedProduct;
  if (nestedSku) return nestedSku;
  return base;
}

function buildProductInputText(inputObj, url) {
  if (typeof url === 'string' && url.trim()) return url.trim();
  const o = unwrapProductLike(inputObj);
  if (!o) return null;
  const brand = typeof o.brand === 'string' ? o.brand.trim() : '';
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const display = typeof o.display_name === 'string' ? o.display_name.trim() : typeof o.displayName === 'string' ? o.displayName.trim() : '';
  const productName = typeof o.product_name === 'string' ? o.product_name.trim() : typeof o.productName === 'string' ? o.productName.trim() : '';
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const sku = typeof o.sku_id === 'string' ? o.sku_id.trim() : typeof o.skuId === 'string' ? o.skuId.trim() : '';
  const pid = typeof o.product_id === 'string' ? o.product_id.trim() : typeof o.productId === 'string' ? o.productId.trim() : '';
  const bestName = display || name || productName || title;
  if (brand && bestName) return joinBrandAndName(brand, bestName);
  if (bestName) return bestName;
  if (sku) return sku;
  if (pid) return pid;
  return null;
}

function extractAnchorIdFromProductLike(obj) {
  const source = unwrapProductLike(obj);
  if (!source) return null;
  const raw =
    (typeof source.sku_id === 'string' && source.sku_id) ||
    (typeof source.skuId === 'string' && source.skuId) ||
    (typeof source.product_id === 'string' && source.product_id) ||
    (typeof source.productId === 'string' && source.productId) ||
    null;
  const v = raw ? String(raw).trim() : '';
  return v || null;
}

function buildOriginalStub(url, inputText) {
  const urlStr = String(url || '').trim();
  const textStr = String(inputText || '').trim();
  const nameGuess = textStr || (urlStr ? urlStr.split('/').filter(Boolean).pop() || '' : '');
  return {
    _stub: true,
    url: urlStr || null,
    name: nameGuess || null,
    name_guess: nameGuess || null,
    anchor_resolution_status: 'failed',
    anchor_resolution_reason: urlStr ? 'url_resolution_failed' : 'no_product_object',
  };
}

function resolveOriginalForPayload(originalObj, url, inputText) {
  if (originalObj && typeof originalObj === 'object' && !Array.isArray(originalObj)) {
    const base = unwrapProductLike(originalObj) || originalObj;
    const name = buildProductInputText(base, null);
    const original = {
      ...base,
      ...(name && !base.name ? { name } : {}),
      ...(name && !base.display_name && !base.displayName ? { display_name: name } : {}),
      ...(typeof url === 'string' && url.trim() && !base.url && !base.product_url && !base.productUrl ? { url: url.trim() } : {}),
    };
    return { original, anchor_resolution_status: 'confirmed' };
  }
  return { original: buildOriginalStub(url, inputText), anchor_resolution_status: 'failed' };
}

/**
 * Build a deterministic KB key from the best-available anchor signal.
 * @param {function} normalizeDupeKbKey - normalizer from dupeKbStore
 */
function buildDupeSuggestKbKey({ anchor, url, text }, normalizeDupeKbKey) {
  const id = String(anchor || '').trim();
  if (id) return normalizeDupeKbKey(`id:${id}`);
  const u = String(url || '').trim();
  if (u) return normalizeDupeKbKey(`url:${u}`);
  const t = String(text || '').trim();
  if (!t) return null;
  const norm = t.toLowerCase().replace(/\s+/g, ' ').slice(0, 220);
  return normalizeDupeKbKey(`text:${norm}`);
}

function hasKnownAlternativePrice(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const priceTier = String(item.price_tier || item.priceTier || '').trim().toLowerCase();
  if (priceTier && priceTier !== 'price_unknown') return true;
  const product = item.product && typeof item.product === 'object' && !Array.isArray(item.product) ? item.product : null;
  if (!product) return false;
  const price = product.price && typeof product.price === 'object' && !Array.isArray(product.price) ? product.price : null;
  if (!price) return false;
  const usd = Number(price.usd);
  const cny = Number(price.cny);
  if (Number.isFinite(usd) && usd > 0) return true;
  if (Number.isFinite(cny) && cny > 0) return true;
  return price.unknown === false;
}

function normalizeCandidatePoolMeta(metaRaw) {
  const meta = metaRaw && typeof metaRaw === 'object' && !Array.isArray(metaRaw) ? metaRaw : {};
  const count = Number(meta.count);
  const sourcesUsed = Array.isArray(meta.sources_used) ? meta.sources_used.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const priceCoverageRate = Number(meta.price_coverage_rate);
  return {
    count: Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0,
    sources_used: sourcesUsed,
    price_coverage_rate: Number.isFinite(priceCoverageRate) ? Math.max(0, Math.min(1, priceCoverageRate)) : 0,
    degraded: meta.degraded === true,
  };
}

function buildDupeSuggestQualityAssessment({
  resolvedOriginal,
  dupes,
  comparables,
  verified,
  hasMeaningfulQuality,
  candidatePoolMeta = null,
}) {
  const dupeList = Array.isArray(dupes) ? dupes : [];
  const comparableList = Array.isArray(comparables) ? comparables : [];
  const items = [...dupeList, ...comparableList];
  const verifiedAnchor = Boolean(
    resolvedOriginal &&
    typeof resolvedOriginal === 'object' &&
    resolvedOriginal.anchor_resolution_status === 'confirmed',
  );
  const verifiedPrices = items.some((it) => hasKnownAlternativePrice(it));
  const qualityIssues = [];
  if (!verifiedAnchor) qualityIssues.push('anchor_unresolved');
  if (!hasMeaningfulQuality) qualityIssues.push('insufficient_evidence');
  if (items.length > 0 && !verifiedPrices) qualityIssues.push('all_prices_unknown');
  if (candidatePoolMeta && Number(candidatePoolMeta.count || 0) === 0) qualityIssues.push('candidate_pool_empty');
  const qualityOk = Boolean(verified) && qualityIssues.length === 0;
  return {
    validated_schema: true,
    verified_anchor: verifiedAnchor,
    verified_prices: verifiedPrices,
    quality_ok: qualityOk,
    quality_issues: qualityIssues,
  };
}

module.exports = {
  joinBrandAndName,
  buildProductInputText,
  extractAnchorIdFromProductLike,
  buildOriginalStub,
  resolveOriginalForPayload,
  buildDupeSuggestKbKey,
  hasKnownAlternativePrice,
  normalizeCandidatePoolMeta,
  buildDupeSuggestQualityAssessment,
};
