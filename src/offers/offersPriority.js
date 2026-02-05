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
    return { ...data, offers: prioritizeOffers(data.offers) };
  }

  if (data.data && typeof data.data === 'object' && !Array.isArray(data.data) && Array.isArray(data.data.offers)) {
    return { ...data, data: { ...data.data, offers: prioritizeOffers(data.data.offers) } };
  }

  return upstreamData;
}

module.exports = {
  prioritizeOffers,
  prioritizeOffersResolveResponse,
};

