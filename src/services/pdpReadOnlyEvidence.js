'use strict';

const { isOwnImplicitVariantId } = require('./canonicalPdpOwnMoney');

// Evidence can be useful when the selected listing has no current own offer.
// This projection must never turn cached money, availability or a sibling
// listing into an executable offer. It is applied at the public response edge,
// after builders and optional modules have had their last chance to enrich it.
const COMMERCE_FIELDS = new Set([
  'price', 'pricing', 'price_amount', 'priceAmount', 'current_price', 'currentPrice',
  'price_min', 'price_max', 'min_price', 'max_price', 'compare_at_price', 'compareAtPrice',
  'from_price', 'price_range', 'estimated_best_price', 'exact_quote_price',
  'list_price', 'sale_price', 'regular_price', 'original_price', 'merchant_effective_price',
  'discount', 'discount_amount', 'discount_percent', 'savings', 'savings_amount',
  'savings_percent', 'savings_presentation', 'promotion', 'promotions',
  'payment_offer_summary', 'payment_offer_badges', 'payment_pricing',
  'store_discount_evidence', 'store_discount_summary', 'store_discount_badges',
  'discount_evidence', 'promotion_lines',
  'in_stock', 'inStock', 'available', 'available_quantity', 'inventory_quantity',
  'quantity', 'stock', 'inventory', 'availability',
  'purchase_route', 'purchaseRoute', 'checkout_handoff', 'checkoutHandoff',
  'external_redirect_url', 'external_url', 'destination_url', 'purchase_url',
  'checkout_url', 'affiliate_url', 'buy_url',
  'merchant_checkout_url', 'merchantCheckoutUrl', 'checkoutUrl', 'externalRedirectUrl',
  'redirect_url', 'redirectUrl', 'buyUrl',
  'offer_id', 'default_offer_id', 'best_price_offer_id', 'selected_offer_id',
  'offers', 'offers_count', 'offer_mode', 'payment_offer_evidence', 'is_buy_pick',
  'purchase_eligible',
  'actions', 'action',
]);

function stripCommerce(value) {
  if (Array.isArray(value)) return value.map(stripCommerce);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !COMMERCE_FIELDS.has(key))
    .map(([key, child]) => [key,
      key === 'commerce_mode' ? 'read_only'
        : key === 'structured_data_mode' ? 'product_snippet'
          : stripCommerce(child)]));
}

function buildReadOnlyCommerce(reasonCode) {
  return {
    state: 'unavailable',
    read_only: true,
    purchase_eligible: false,
    reason_code: reasonCode,
  };
}

function projectReadOnlyVariant(variant) {
  if (!variant || typeof variant !== 'object') return variant;
  const clean = stripCommerce(variant);
  for (const key of ['url', 'source_url', 'canonical_url']) delete clean[key];
  return { ...clean, current_own_offer_status: 'unavailable',
    purchase_eligible: false, availability: {} };
}

function projectReadOnlyProduct(product) {
  if (!product || typeof product !== 'object') return product;
  const clean = stripCommerce(product);
  for (const key of ['url', 'source_url', 'canonical_url']) delete clean[key];
  return {
    ...clean,
    commerce_mode: 'read_only',
    purchase_eligible: false,
    current_own_offer_status: 'unavailable',
    // Unknown is deliberately different from "out of stock".
    availability: {},
    ...(Array.isArray(clean.variants)
      ? { variants: clean.variants.map(projectReadOnlyVariant) }
      : {}),
  };
}

function projectReadOnlyPdpResponse(response, reasonCode) {
  const commerce = buildReadOnlyCommerce(reasonCode);
  const modules = (response.modules || []).map(module => {
    // Similar products have their own identity and own offer gate. The state of
    // this listing must neither suppress nor lend eligibility to those cards.
    if (module.type === 'similar') return module;
    if (module.type === 'offers') return {
      ...module,
      data: {
        status: 'unavailable', offers: [], offers_count: 0,
        default_offer_id: null, best_price_offer_id: null,
        reason_codes: [reasonCode], commerce,
      },
      reason: reasonCode,
    };
    const next = { ...module, data: stripCommerce(module.data) };
    if (module.type === 'canonical' && next.data?.pdp_payload) {
      next.data.commerce = commerce;
      next.data.offer_source = 'unavailable';
      const quality = next.data.pdp_payload.quality_signals;
      next.data.pdp_payload = {
        ...next.data.pdp_payload,
        commerce,
        product: projectReadOnlyProduct(next.data.pdp_payload.product),
        modules: (next.data.pdp_payload.modules || [])
          .filter(child => child.type !== 'price_promo')
          .map(child => child.type === 'variant_selector' && Array.isArray(child.data?.variants)
            ? { ...child, data: { ...child.data, variants: child.data.variants.map(projectReadOnlyVariant) } }
            : child),
        actions: [],
        ...(quality ? { quality_signals: {
          ...quality,
          coverage_by_module: { ...quality.coverage_by_module, price_promo: 0, buy_box: 0 },
          gating: { ...quality.gating, buy_box_ok: false },
        } } : {}),
      };
    }
    if (module.type === 'variant_selector' && Array.isArray(next.data?.variants)) {
      next.data.variants = next.data.variants.map(projectReadOnlyVariant);
    }
    return next;
  });
  return {
    ...response,
    modules,
    metadata: {
      ...response.metadata,
      commerce,
      ...(response.metadata?.pdp_provenance ? {
        pdp_provenance: { ...response.metadata.pdp_provenance, offer_source: 'unavailable' },
      } : {}),
      // No cached normalized offer facts should escape this projection either.
      normalized_pdp: stripCommerce(response.metadata?.normalized_pdp),
    },
  };
}

// Call only after the existing exact current-own-money gate succeeds. The
// response's selected seller/variant can still have changed during later offer
// hydration, so bind proof to the final displayed tuple as well as that read.
// Another seller's offer is certified only as it is finally served: exactly one offer with this
// seller/listing/offer id, showing exactly the verified money on exactly that variant.
function bindVerifiedSellerOffers(response, ref, verifiedOffers) {
  const offersModule = (response.modules || []).find(module => module.type === 'offers');
  const offers = Array.isArray(offersModule?.data?.offers) ? offersModule.data.offers : [];
  const sameMoney = (shown, entry) => shown && typeof shown.amount === 'number' && Number.isFinite(shown.amount) &&
    shown.amount > 0 && shown.amount === entry.amount && shown.currency === entry.currency;
  const bound = [];
  const seen = new Set();
  for (const entry of Array.isArray(verifiedOffers) ? verifiedOffers : []) {
    if (!entry?.offer_id || !entry.merchant_id || !entry.product_id || !entry.variant_id) continue;
    if (entry.merchant_id === ref.merchant_id && entry.product_id === ref.product_id) continue;
    const key = [entry.offer_id, entry.merchant_id, entry.product_id, entry.variant_id].join('\u0000');
    if (seen.has(key)) continue;
    const matches = offers.filter(offer => offer?.offer_id === entry.offer_id &&
      offer?.merchant_id === entry.merchant_id && offer?.product_id === entry.product_id);
    if (matches.length !== 1 || matches[0].price_verification !== 'verified') continue;
    const offer = matches[0];
    const rows = Array.isArray(offer.variants) ? offer.variants : [];
    const ok = rows.length
      ? rows.filter(row => String(row?.variant_id) === entry.variant_id).length === 1 &&
        sameMoney(rows.find(row => String(row?.variant_id) === entry.variant_id)?.price?.current, entry)
      : sameMoney(offer.price, entry);
    if (!ok) continue;
    seen.add(key);
    bound.push({ offer_id: entry.offer_id, merchant_id: entry.merchant_id, product_id: entry.product_id,
      variant_id: entry.variant_id, amount: entry.amount, currency: entry.currency });
    if (bound.length >= 200) break;
  }
  return bound;
}

function projectVerifiedCanonicalCommerce(response, { ref, selectedVariantId, productGrain, money, moneyByVariant, verifiedAt, verifiedOffers = [] }) {
  // This is the time of the current own-offer database verification, not a
  // claim about when the retailer last updated its source data.
  const expiresAt = verifiedAt + 60000;
  if (!Number.isFinite(verifiedAt) || verifiedAt > Date.now() || expiresAt <= Date.now()) return response;
  const canonical = response.modules?.find(module => module.type === 'canonical');
  const payload = canonical?.data?.pdp_payload;
  const product = payload?.product;
  const selected = canonical?.data?.selected_commerce_ref;
  if (!product || !ref?.merchant_id || !ref?.product_id ||
      selected?.merchant_id !== ref.merchant_id || selected?.product_id !== ref.product_id ||
      product.merchant_id !== ref.merchant_id || product.source_product_id !== ref.product_id) return response;
  const expectedVariant = String(selectedVariantId || '').trim();
  const displayedVariant = String(product.default_variant_id || '').trim();
  const ownAliases = new Set([ref.product_id, product.product_id]);
  // The variant ids product-grain money may stand for: the product itself under any of its aliases.
  const isOwnImplicit = id => isOwnImplicitVariantId(id, ref, [product.product_id]);
  const variantMatches = expectedVariant && displayedVariant &&
    (expectedVariant === displayedVariant ||
      (productGrain && isOwnImplicit(expectedVariant) && isOwnImplicit(displayedVariant)));
  const displayedMoney = product.price?.current;
  if (!variantMatches || !money || displayedMoney?.currency !== money.currency ||
      Number(displayedMoney?.amount) !== Number(money.amount)) return response;
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const counts = new Map();
  for (const variant of variants) {
    const id = String(variant?.variant_id || '').trim();
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const verifiedVariants = variants.flatMap(variant => {
    const id = String(variant?.variant_id || '').trim();
    if (!id || counts.get(id) !== 1 ||
        (variant.merchant_id && variant.merchant_id !== ref.merchant_id) ||
        (variant.source_product_id && variant.source_product_id !== ref.product_id) ||
        (variant.product_id && !ownAliases.has(variant.product_id))) return [];
    const own = productGrain && id === displayedVariant && isOwnImplicit(id)
      ? money : moneyByVariant?.get(id);
    const shown = variant.price?.current;
    if (!own || !shown || shown.currency !== own.currency ||
        typeof shown.amount !== 'number' || shown.amount !== Number(own.amount) ||
        !Number.isFinite(shown.amount) || shown.amount <= 0) return [];
    return [{ variant_id: id, amount: shown.amount, currency: shown.currency }];
  });
  // Bound the public receipt while always retaining the selected proof. A
  // displayed option without its own entry remains unverified on the client.
  verifiedVariants.sort((a, b) => Number(b.variant_id === displayedVariant) - Number(a.variant_id === displayedVariant));
  const boundedVariants = verifiedVariants.slice(0, 100);
  if (!boundedVariants.some(variant => variant.variant_id === displayedVariant)) return response;
  const commerce = {
    state: 'ready', read_only: false, purchase_eligible: true,
    reason_code: 'CURRENT_OWN_OFFER_VERIFIED',
    product_ref: { merchant_id: ref.merchant_id, product_id: ref.product_id },
    selected_variant_id: displayedVariant,
    verified_variants: boundedVariants,
    verified_offers: bindVerifiedSellerOffers(response, ref, verifiedOffers),
    verified_at: new Date(verifiedAt).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
  };
  return {
    ...response,
    metadata: { ...response.metadata, commerce },
    modules: response.modules.map(module => module !== canonical ? module : {
      ...module, data: { ...module.data, commerce, pdp_payload: { ...payload, commerce } },
    }),
  };
}

module.exports = { buildReadOnlyCommerce, projectReadOnlyPdpResponse, projectVerifiedCanonicalCommerce, bindVerifiedSellerOffers };
