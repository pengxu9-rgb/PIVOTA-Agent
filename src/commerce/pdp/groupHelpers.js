const {
  resolveProductGroupCacheEnabled,
  resolveProductGroupCacheMetrics,
  resolveProductGroupCacheTtlMs,
  getResolveProductGroupCacheEntry,
  setResolveProductGroupCache,
} = require('./hotCaches');
const { normalizeOfferMoney } = require('./offerMoney');
const {
  buildOfferId: buildOfferIdBase,
  buildProductGroupId: buildProductGroupIdBase,
} = require('../../offers/offerIds');
const {
  resolveProductGroupFromUpstream: resolveProductGroupFromUpstreamBase,
  resolveProductGroupByProductIdFromUpstream: resolveProductGroupByProductIdFromUpstreamBase,
} = require('./upstreamAdapters');
const {
  fetchProductDetailForOffers: fetchProductDetailForOffersBase,
} = require('../catalog/productDetailAdapters');

function normalizeGroupMembers(rawMembers) {
  return (Array.isArray(rawMembers) ? rawMembers : [])
    .map((member) => ({
      merchant_id: String(member?.merchant_id || member?.merchantId || '').trim(),
      merchant_name: member?.merchant_name || member?.merchantName || undefined,
      product_id: String(member?.product_id || member?.productId || '').trim(),
      platform: member?.platform ? String(member.platform).trim() : undefined,
      is_primary: Boolean(member?.is_primary || member?.isPrimary),
    }))
    .filter((member) => Boolean(member.merchant_id) && Boolean(member.product_id));
}

function computeOfferTotal(offer) {
  return Number(offer?.price?.amount || 0) + Number(offer?.shipping?.cost?.amount || 0);
}

async function resolveProductGroupCached({
  productId,
  merchantId,
  platform,
  checkoutToken,
  bypassCache,
  debug,
  resolveProductGroupFromUpstream = resolveProductGroupFromUpstreamBase,
  resolveProductGroupByProductIdFromUpstream =
    resolveProductGroupByProductIdFromUpstreamBase,
} = {}) {
  const normalizedProductId = String(productId || '').trim();
  const normalizedMerchantId = String(merchantId || '').trim() || null;
  const normalizedPlatform = platform ? String(platform).trim() : null;

  if (!normalizedProductId) return null;

  const cacheKey = JSON.stringify({
    productId: normalizedProductId,
    merchantId: normalizedMerchantId,
    platform: normalizedPlatform,
    hasCheckoutToken: Boolean(checkoutToken),
  });
  const cacheEnabled = resolveProductGroupCacheEnabled && bypassCache !== true;
  if (!cacheEnabled) resolveProductGroupCacheMetrics.bypasses += 1;
  const cachedEntry = cacheEnabled ? getResolveProductGroupCacheEntry(cacheKey) : null;
  if (cachedEntry?.value) {
    const ageMs =
      typeof cachedEntry.storedAtMs === 'number'
        ? Math.max(0, Date.now() - cachedEntry.storedAtMs)
        : 0;
    return debug === true
      ? {
          ...cachedEntry.value,
          cache: { hit: true, age_ms: ageMs, ttl_ms: resolveProductGroupCacheTtlMs },
        }
      : cachedEntry.value;
  }

  const resolvedGroup = normalizedMerchantId
    ? await resolveProductGroupFromUpstream({
        merchantId: normalizedMerchantId,
        productId: normalizedProductId,
        platform: normalizedPlatform,
        checkoutToken,
      })
    : await resolveProductGroupByProductIdFromUpstream({
        productId: normalizedProductId,
        platform: normalizedPlatform,
        checkoutToken,
      });

  const productGroupIdRaw =
    resolvedGroup?.product_group_id || resolvedGroup?.productGroupId || null;
  const resolvedProductGroupId =
    typeof productGroupIdRaw === 'string' && productGroupIdRaw.trim()
      ? productGroupIdRaw.trim()
      : null;
  const members = normalizeGroupMembers(resolvedGroup?.members);
  const canonicalMember = members.find((member) => member.is_primary) || members[0] || null;

  const result = {
    status: 'success',
    ...(resolvedProductGroupId ? { product_group_id: resolvedProductGroupId } : {}),
    canonical_product_ref: canonicalMember
      ? {
          merchant_id: canonicalMember.merchant_id,
          product_id: canonicalMember.product_id,
          ...(canonicalMember.platform ? { platform: canonicalMember.platform } : {}),
        }
      : null,
    members,
  };

  if (cacheEnabled) setResolveProductGroupCache(cacheKey, result);
  return debug === true
    ? { ...result, cache: { hit: false, age_ms: 0, ttl_ms: resolveProductGroupCacheTtlMs } }
    : result;
}

async function buildOffersFromGroupMembers({
  productGroupId,
  members,
  checkoutToken,
  limit,
  preferredMerchantId,
  fetchProductDetailForOffers = fetchProductDetailForOffersBase,
  buildProductGroupId = buildProductGroupIdBase,
  buildOfferId = buildOfferIdBase,
} = {}) {
  const groupMembers = Array.isArray(members) ? members : [];
  const normalizedLimit = Math.min(
    Math.max(1, Number(limit || groupMembers.length || 10) || 10),
    50,
  );
  const normalizedPreferredMerchantId = preferredMerchantId
    ? String(preferredMerchantId).trim()
    : null;

  if (!groupMembers.length) return null;

  const normalizedMembers = normalizeGroupMembers(groupMembers).slice(0, normalizedLimit);
  const canonicalMember =
    normalizedMembers.find((member) => member.is_primary) || normalizedMembers[0] || null;
  const canonicalProductRef = canonicalMember
    ? {
        merchant_id: canonicalMember.merchant_id,
        product_id: canonicalMember.product_id,
        ...(canonicalMember.platform ? { platform: canonicalMember.platform } : {}),
      }
    : null;

  const merchantNameById = new Map(
    normalizedMembers
      .map((member) => [String(member.merchant_id || '').trim(), member.merchant_name])
      .filter(([merchantId]) => Boolean(merchantId)),
  );

  const fetched = [];
  const chunkSize = 4;
  for (let idx = 0; idx < normalizedMembers.length; idx += chunkSize) {
    const chunk = normalizedMembers.slice(idx, idx + chunkSize);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(
      chunk.map(async (member) =>
        fetchProductDetailForOffers({
          merchantId: member.merchant_id,
          productId: member.product_id,
          checkoutToken,
        }).catch(() => null),
      ),
    );
    fetched.push(...results);
  }

  const products = fetched.filter(Boolean);
  if (!products.length) return null;

  const resolvedProductGroupId =
    (productGroupId ? String(productGroupId).trim() : null) ||
    (canonicalProductRef?.platform
      ? buildProductGroupId({
          platform: String(canonicalProductRef.platform || '').trim(),
          platform_product_id: String(
            products[0]?.platform_product_id || products[0]?.platformProductId || '',
          ).trim(),
        })
      : null) ||
    (products[0]?.platform
      ? buildProductGroupId({
          platform: String(products[0].platform || '').trim(),
          platform_product_id: String(
            products[0].platform_product_id || products[0].platformProductId || '',
          ).trim(),
        })
      : null) ||
    `pg:pid:${String(canonicalProductRef?.product_id || products[0]?.product_id || products[0]?.id || '').trim()}`;

  const offers = products.map((product) => {
    const merchantId = String(product.merchant_id || '').trim();
    const offerProductId = String(product.product_id || '').trim() || undefined;
    const currency = product.currency || 'USD';
    const shippingCost = product.shipping?.cost || product.shipping_cost || null;
    const shippingCostAmount =
      shippingCost == null
        ? undefined
        : Number(typeof shippingCost === 'object' ? shippingCost.amount : shippingCost);
    const shippingCostCurrency =
      shippingCost && typeof shippingCost === 'object'
        ? String(shippingCost.currency || currency)
        : currency;
    const etaRaw = product.shipping?.eta_days_range || product.shipping?.etaDaysRange || null;
    const etaRange =
      Array.isArray(etaRaw) && etaRaw.length >= 2
        ? [Number(etaRaw[0]) || 0, Number(etaRaw[1]) || 0]
        : undefined;

    return {
      offer_id:
        buildOfferId({
          merchant_id: merchantId,
          product_group_id: resolvedProductGroupId,
          fulfillment_type: product.fulfillment_type || 'merchant',
          tier: 'default',
        }) ||
        `of:v1:${merchantId}:${resolvedProductGroupId}:${product.fulfillment_type || 'merchant'}:default`,
      product_group_id: resolvedProductGroupId,
      product_id: offerProductId,
      merchant_id: merchantId,
      merchant_name:
        product.merchant_name || product.store_name || merchantNameById.get(merchantId) || undefined,
      price: normalizeOfferMoney(product.price, currency),
      shipping:
        product.shipping || etaRange || shippingCostAmount != null
          ? {
              method_label:
                product.shipping?.method_label || product.shipping?.methodLabel || undefined,
              eta_days_range: etaRange,
              ...(shippingCostAmount != null && Number.isFinite(shippingCostAmount)
                ? { cost: normalizeOfferMoney(shippingCostAmount, shippingCostCurrency) }
                : {}),
            }
          : undefined,
      returns: product.returns || undefined,
      inventory: {
        in_stock: typeof product.in_stock === 'boolean' ? product.in_stock : undefined,
      },
      fulfillment_type: product.fulfillment_type || undefined,
      risk_tier: 'standard',
    };
  });

  const sortedByTotal = [...offers].sort((left, right) => computeOfferTotal(left) - computeOfferTotal(right));
  const bestPriceOfferId = sortedByTotal[0]?.offer_id || null;
  const preferredOfferId = normalizedPreferredMerchantId
    ? offers.find((offer) => offer.merchant_id === normalizedPreferredMerchantId)?.offer_id || null
    : null;
  const defaultOfferId = preferredOfferId || bestPriceOfferId;

  return {
    status: 'success',
    product_group_id: resolvedProductGroupId,
    canonical_product_ref: canonicalProductRef,
    offers_count: offers.length,
    offers,
    default_offer_id: defaultOfferId,
    best_price_offer_id: bestPriceOfferId,
  };
}

module.exports = {
  resolveProductGroupCached,
  buildOffersFromGroupMembers,
};
