function asString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeUrl(value) {
  const s = asString(value);
  return s ? s : null;
}

function readPurchaseRoute(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return '';
  return asString(o.purchase_route ?? o.purchaseRoute).toLowerCase();
}

function hasInternalPayload(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return false;
  return Boolean(o.internal_checkout ?? o.internalCheckout);
}

function readCheckoutUrl(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return null;
  return normalizeUrl(
    o.checkout_url ??
      o.checkoutUrl ??
      o.purchase_url ??
      o.purchaseUrl ??
      o.internal_checkout_url ??
      o.internalCheckoutUrl,
  );
}

function readAffiliateUrl(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return null;
  return normalizeUrl(
    o.affiliate_url ??
      o.affiliateUrl ??
      o.external_redirect_url ??
      o.externalRedirectUrl ??
      o.external_url ??
      o.externalUrl,
  );
}

function readGenericUrl(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return null;
  return normalizeUrl(o.url);
}

function readMerchantCheckoutSession(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
  if (!o) return null;
  const session =
    o.merchant_checkout_session ??
    o.merchantCheckoutSession ??
    o.checkout_session ??
    o.checkoutSession ??
    o.internal_checkout ??
    o.internalCheckout;
  return session && typeof session === 'object' ? session : null;
}

function isInternalOffer(offer) {
  const route = readPurchaseRoute(offer);
  if (route === 'internal_checkout') return true;
  if (hasInternalPayload(offer)) return true;
  if (readCheckoutUrl(offer)) return true;
  return false;
}

function isExternalOffer(offer) {
  const route = readPurchaseRoute(offer);
  if (route === 'affiliate_outbound') return true;
  if (readAffiliateUrl(offer)) return true;
  return false;
}

function inferCommerceMode(offer) {
  if (isInternalOffer(offer) || readMerchantCheckoutSession(offer)) return 'merchant_embedded_checkout';
  if (isExternalOffer(offer) || readGenericUrl(offer)) return 'links_out';
  return 'merchant_embedded_checkout';
}

function inferCheckoutHandoff(offer) {
  return inferCommerceMode(offer) === 'merchant_embedded_checkout' ? 'embedded' : 'redirect';
}

function enrichOfferCommerceMetadata(offer) {
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) return offer;

  const commerceMode = inferCommerceMode(offer);
  const checkoutHandoff = inferCheckoutHandoff(offer);
  const checkoutUrl =
    readCheckoutUrl(offer) ||
    readAffiliateUrl(offer) ||
    readGenericUrl(offer);
  const merchantCheckoutSession = readMerchantCheckoutSession(offer);

  return {
    ...offer,
    commerce_mode: commerceMode,
    seller_of_record: 'merchant',
    payment_processor_owner: 'merchant',
    order_system_of_record: 'merchant_store_platform',
    checkout_handoff: checkoutHandoff,
    order_writeback_mode: 'merchant_direct',
    ...(checkoutUrl ? { merchant_checkout_url: checkoutUrl } : {}),
    ...(merchantCheckoutSession ? { merchant_checkout_session: merchantCheckoutSession } : {}),
  };
}

function annotateOffersWithCommerceMetadata(offers) {
  const arr = Array.isArray(offers) ? offers : [];
  return arr.map((offer) => enrichOfferCommerceMetadata(offer));
}

function summarizeOfferCommerceMetadata(offers) {
  const arr = annotateOffersWithCommerceMetadata(offers);
  const modes = Array.from(
    new Set(arr.map((offer) => asString(offer?.commerce_mode)).filter(Boolean)),
  );
  return {
    offers: arr,
    commerce_modes: modes,
    seller_of_record: 'merchant',
    payment_processor_owner: 'merchant',
    order_system_of_record: 'merchant_store_platform',
    order_writeback_mode: 'merchant_direct',
  };
}

function scoreOfferForPriority(offer) {
  if (!offer || typeof offer !== 'object') return 99;
  if (isInternalOffer(offer)) return 0;
  if (isExternalOffer(offer)) return 1;
  if (readGenericUrl(offer)) return 2;
  return 50;
}

function prioritizeOffers(offers) {
  const arr = Array.isArray(offers) ? offers.slice() : [];
  if (arr.length <= 1) return arr;

  const scored = arr.map((o, idx) => ({ o, idx, score: scoreOfferForPriority(o) }));
  scored.sort((a, b) => a.score - b.score || a.idx - b.idx);
  return scored.map((x) => x.o);
}

function prioritizeOffersResolveResponse(upstreamData) {
  const data = upstreamData && typeof upstreamData === 'object' && !Array.isArray(upstreamData) ? upstreamData : null;
  if (!data) return upstreamData;

  if (Array.isArray(data.offers)) {
    const summary = summarizeOfferCommerceMetadata(prioritizeOffers(data.offers));
    return {
      ...data,
      offers: summary.offers,
      metadata: {
        ...(data.metadata && typeof data.metadata === 'object' ? data.metadata : {}),
        commerce_modes: summary.commerce_modes,
        seller_of_record: summary.seller_of_record,
        payment_processor_owner: summary.payment_processor_owner,
        order_system_of_record: summary.order_system_of_record,
        order_writeback_mode: summary.order_writeback_mode,
      },
    };
  }

  if (data.data && typeof data.data === 'object' && !Array.isArray(data.data) && Array.isArray(data.data.offers)) {
    const summary = summarizeOfferCommerceMetadata(prioritizeOffers(data.data.offers));
    return {
      ...data,
      data: { ...data.data, offers: summary.offers },
      metadata: {
        ...(data.metadata && typeof data.metadata === 'object' ? data.metadata : {}),
        commerce_modes: summary.commerce_modes,
        seller_of_record: summary.seller_of_record,
        payment_processor_owner: summary.payment_processor_owner,
        order_system_of_record: summary.order_system_of_record,
        order_writeback_mode: summary.order_writeback_mode,
      },
    };
  }

  return upstreamData;
}

module.exports = {
  annotateOffersWithCommerceMetadata,
  enrichOfferCommerceMetadata,
  prioritizeOffers,
  prioritizeOffersResolveResponse,
  summarizeOfferCommerceMetadata,
};
