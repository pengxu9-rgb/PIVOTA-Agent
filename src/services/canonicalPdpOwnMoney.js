'use strict';

const { buildCanonicalOwnOfferSellerSql } = require('./canonicalOwnOfferSellerSql');
const { buildVariants, pickDefaultVariant } = require('../pdpBuilder');
const { computeOfferTotal, prioritizeOffers } = require('../offers/offersPriority');

const CANONICAL_PRODUCT = Symbol('canonical-product');

function storedNumericVariant(id, productKey) {
  const raw = typeof id === 'string' ? id.trim() : '';
  if (/^[0-9]{1,20}$/.test(raw)) return raw;
  const gid = /^gid:\/\/shopify\/ProductVariant\/([0-9]{1,20})$/.exec(raw);
  if (gid) return gid[1];
  const external = /^(ext_[A-Za-z0-9]+):([0-9]{1,20})$/.exec(raw);
  return external && external[1] === productKey.split('::').at(-1) ? external[2] : null;
}

const CURRENT_OWN_OFFER_UNAVAILABLE = 'CURRENT_OWN_OFFER_UNAVAILABLE';
const CURRENT_OWN_OFFER_READ_FAILED = 'CURRENT_OWN_OFFER_READ_FAILED';
const CURRENT_MONEY_FIELDS = ['price', 'price_amount', 'priceAmount', 'current_price', 'currentPrice'];

function unavailable(message = 'Current own listing money is unavailable') {
  const error = new Error(message);
  error.code = CURRENT_OWN_OFFER_UNAVAILABLE;
  return error;
}

// A gap (no eligible current own money) and a failed or timed-out read are both reported, never priced.
function currentOwnMoneyReasonCode(error) {
  return error?.code === CURRENT_OWN_OFFER_UNAVAILABLE ? CURRENT_OWN_OFFER_UNAVAILABLE : CURRENT_OWN_OFFER_READ_FAILED;
}

function withoutCurrentMoney(record) {
  const next = { ...record };
  for (const field of CURRENT_MONEY_FIELDS) delete next[field];
  return next;
}

function unavailableVariant(variant) {
  return { ...withoutCurrentMoney(variant), current_own_offer_status: 'unavailable' };
}

// On the gap path nothing left on the own listing may contradict "not purchasable": no money and no
// stock count beside in_stock:false. (The gateway also strips every savings presentation field.)
const QUANTITY_FIELDS = ['available_quantity', 'availableQuantity', 'inventory_quantity', 'quantity', 'stock'];
const WITHHELD_FIELDS = [...CURRENT_MONEY_FIELDS, ...QUANTITY_FIELDS];

function notInStock(state) {
  const next = { ...(state && typeof state === 'object' && !Array.isArray(state) ? state : {}), in_stock: false };
  for (const field of QUANTITY_FIELDS) delete next[field];
  return next;
}

function withheld(record) {
  const next = { ...record };
  for (const field of WITHHELD_FIELDS) delete next[field];
  for (const key of ['availability', 'inventory']) {
    if (next[key] && typeof next[key] === 'object' && !Array.isArray(next[key])) next[key] = notInStock(next[key]);
  }
  return next;
}

function withheldVariant(variant) {
  return { ...withheld(variant), current_own_offer_status: 'unavailable' };
}

// The built (pdpBuilder) shape of a withheld variant: no price, and not in stock.
function withheldBuiltVariant(variant) {
  return { ...withheldVariant(variant), availability: notInStock(variant?.availability) };
}

// This is the selected enrichment canonical source, not a generic seed price overlay.
function usesCanonicalOwnMoney(ref, market, currency) {
  return Boolean(ref?.product_key && ref?.source_system === 'catalog_enrichment_agent_v1' &&
    ref?.platform === 'external_seed' && market === 'US' && currency === 'USD');
}

async function readCanonicalOwnMoney({ ref, query }) {
  const result = await query(`
    SELECT co.offer_id, co.sku_key, s.source_variant_id,
      co.currency, coalesce(co.merchant_effective_price, co.list_price) AS amount
    FROM catalog_products own_cp
    JOIN catalog_row_trust own_trust ON own_trust.subject_type = 'product'
      AND own_trust.subject_key = own_cp.product_key AND own_trust.serving_decision = 'public'
    JOIN catalog_offers co ON co.product_key = own_cp.product_key
    JOIN catalog_skus s ON s.sku_key = co.sku_key
      AND s.product_key = own_cp.product_key AND s.merchant_id = own_cp.merchant_id
      AND s.currency = 'USD' AND s.suppressed_at IS NULL AND s.suppression_reason IS NULL
    WHERE own_cp.product_key = $1 AND own_cp.merchant_id = $2
      AND own_cp.platform = 'external_seed'
      AND own_cp.source_system = 'catalog_enrichment_agent_v1'
      AND own_cp.sync_status = 'live' AND own_cp.suppression_reason IS NULL
      AND ${buildCanonicalOwnOfferSellerSql()}
      AND co.market = 'US' AND co.currency = 'USD' AND co.availability = 'in_stock'
      AND co.suppressed_at IS NULL AND co.suppression_reason IS NULL
      AND coalesce(co.merchant_effective_price, co.list_price) > 0
    ORDER BY s.source_variant_id, co.offer_id
  `, [ref.product_key, ref.merchant_id]);
  return moneyFromOwnRows(result.rows || [], ref.product_key);
}

// One rule for turning eligible own-offer rows into money per variant, shared by the selected listing
// and every other seller's listing.
function moneyFromOwnRows(rows, productKey) {
  const moneyByVariant = new Map();
  for (const row of rows) {
    const id = typeof row.source_variant_id === 'string' ? row.source_variant_id.trim() : '';
    if (!id) continue;
    const placeholder = id === productKey && row.sku_key === `${productKey}::canonical`;
    const numeric = storedNumericVariant(id, productKey);
    // Unknown external namespace IDs do not gain a numeric alias by suffix.
    const keys = placeholder ? [CANONICAL_PRODUCT] : [id, ...(numeric ? [numeric] : [])];
    const amount = Number(row.amount);
    const minor = Math.round(amount * 100);
    if (row.currency !== 'USD' || !Number.isSafeInteger(minor) || minor <= 0 ||
        Math.abs(amount * 100 - minor) > 1e-6) throw unavailable();
    for (const key of keys) {
      const previous = moneyByVariant.get(key);
      if (previous && previous.minor !== minor) throw unavailable('Conflicting current own listing prices');
      moneyByVariant.set(key, { amount, currency: row.currency, minor });
    }
  }
  if (!moneyByVariant.size) throw unavailable();
  return moneyByVariant;
}

// Other sellers' listings on a verified page are checked by the same rules as the selected listing's
// own money: public trust, live, enrichment lane, own-seller offer, US/USD, in stock, positive whole
// cents. One statement for every displayed listing. A listing that maps to more than one product, has
// no eligible row, or carries conflicting prices is simply absent from the result (unverified).
const MAX_VERIFIED_SELLER_LISTINGS = 20;

async function readCanonicalSellerOffersMoney({ listings, query }) {
  const unique = [];
  const seen = new Set();
  for (const listing of listings || []) {
    const merchantId = typeof listing?.merchant_id === 'string' ? listing.merchant_id.trim() : '';
    const productId = typeof listing?.product_id === 'string' ? listing.product_id.trim() : '';
    const key = `${merchantId}\u0000${productId}`;
    if (!merchantId || !productId || seen.has(key)) continue;
    seen.add(key);
    unique.push({ merchantId, productId });
    if (unique.length >= MAX_VERIFIED_SELLER_LISTINGS) break;
  }
  const verified = new Map();
  if (!unique.length) return verified;
  const result = await query(`
    WITH wanted AS (
      SELECT * FROM unnest($1::text[], $2::text[]) AS w(merchant_id, product_id)
    ), listing AS (
      SELECT DISTINCT w.merchant_id, w.product_id, cp.product_key
      FROM wanted w
      JOIN catalog_products cp ON cp.merchant_id = w.merchant_id
        AND (cp.source_product_id = w.product_id OR cp.product_key IN (
          SELECT eps.attached_product_key FROM external_product_seeds eps
          WHERE eps.external_product_id = w.product_id AND eps.status = 'active'))
    )
    SELECT l.merchant_id AS listing_merchant_id, l.product_id AS listing_product_id,
      own_cp.product_key, co.offer_id, co.sku_key, s.source_variant_id,
      co.currency, coalesce(co.merchant_effective_price, co.list_price) AS amount
    FROM listing l
    JOIN catalog_products own_cp ON own_cp.product_key = l.product_key
    JOIN catalog_row_trust own_trust ON own_trust.subject_type = 'product'
      AND own_trust.subject_key = own_cp.product_key AND own_trust.serving_decision = 'public'
    JOIN catalog_offers co ON co.product_key = own_cp.product_key
    JOIN catalog_skus s ON s.sku_key = co.sku_key
      AND s.product_key = own_cp.product_key AND s.merchant_id = own_cp.merchant_id
      AND s.currency = 'USD' AND s.suppressed_at IS NULL AND s.suppression_reason IS NULL
    WHERE own_cp.platform = 'external_seed'
      AND own_cp.source_system = 'catalog_enrichment_agent_v1'
      AND own_cp.sync_status = 'live' AND own_cp.suppression_reason IS NULL
      AND ${buildCanonicalOwnOfferSellerSql()}
      AND co.market = 'US' AND co.currency = 'USD' AND co.availability = 'in_stock'
      AND co.suppressed_at IS NULL AND co.suppression_reason IS NULL
      AND coalesce(co.merchant_effective_price, co.list_price) > 0
    ORDER BY l.merchant_id, l.product_id, s.source_variant_id, co.offer_id
  `, [unique.map(item => item.merchantId), unique.map(item => item.productId)]);
  const grouped = new Map();
  for (const row of result.rows || []) {
    const key = `${row.listing_merchant_id}\u0000${row.listing_product_id}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  for (const [key, rows] of grouped) {
    const productKeys = new Set(rows.map(row => row.product_key));
    if (productKeys.size !== 1) continue;
    const [productKey] = productKeys;
    try {
      verified.set(key, moneyFromOwnRows(rows, productKey));
    } catch {
      // Conflicting or malformed money: this listing stays unverified, the others are unaffected.
    }
  }
  return verified;
}

function sellerListingKey(offer) {
  return `${String(offer?.merchant_id || '').trim()}\u0000${String(offer?.product_id || '').trim()}`;
}

function projectVariant(variant, moneyByVariant, nativeIdentity = null) {
  const id = nativeIdentity || String(variant?.variant_id || variant?.id ||
    variant?.variant_attributes?.variant_id || variant?.sku || variant?.sku_id || '').trim();
  const money = moneyByVariant.get(id);
  if (!money) return unavailableVariant(variant);
  // Identity, options, visibility, source quality and availability remain the source's fields.
  return { ...variant, price: { amount: money.amount, currency: money.currency },
    price_amount: money.amount, currency: money.currency };
}

// The enrichment lane mints this as a single-item listing's only seed variant (pivota-backend
// services/catalog_enrichment_agent/ingestion.py synthetic_variant: `<external_product_id>::canonical`,
// product title, no options). It names the product itself, as the `<product_key>::canonical` placeholder
// SKU that prices it does.
function laneProductVariantId(ref) {
  return ref?.product_id ? `${ref.product_id}::canonical` : null;
}

// The variant identities that ARE the selected listing's product, never one of its options: the one rule
// for every check that lets product-grain money stand for a displayed variant.
function isOwnImplicitVariantId(id, ref, aliases = []) {
  const value = String(id || '').trim();
  return Boolean(value) && (value === ref?.product_id || value === laneProductVariantId(ref) ||
    aliases.some(alias => alias && value === alias));
}

function isCanonicalProductGrain(product, ref) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  if (!variants.length) return true;
  if (variants.length !== 1 || !ref?.product_id) return false;
  const variant = variants[0];
  const id = String(variant.variant_id || variant.id || '');
  // The external-seed builder materializes this exact implicit source product variant.
  // A numeric/group-selected variant is not backed by the product placeholder.
  if (id === ref.product_id) {
    return variant.title === 'Default' && Array.isArray(variant.options) && variant.options.length === 0;
  }
  // The lane's minted product variant. The lane writes it only as a seed's SOLE variant (real variants
  // replace it), so beside nothing else it is the product; an option the builder derives from the title
  // ("Size: 120 g") describes that one item and offers no choice.
  return id === laneProductVariantId(ref);
}

function projectCanonicalProductMoney(product, moneyByVariant, { ref = null } = {}) {
  const nativeVariants = buildVariants(product);
  const selected = pickDefaultVariant(product, nativeVariants);
  const productGrain = isCanonicalProductGrain(product, ref);
  const selectedMoney = productGrain ? moneyByVariant.get(CANONICAL_PRODUCT)
    : moneyByVariant.get(String(selected?.variant_id || ''));
  if (!selectedMoney) throw unavailable();
  const variants = Array.isArray(product?.variants) ? product.variants.map((variant, index) => {
    if (productGrain) return { ...variant, price: { amount: selectedMoney.amount, currency: selectedMoney.currency },
      price_amount: selectedMoney.amount, currency: selectedMoney.currency };
    return projectVariant(variant, moneyByVariant, nativeVariants[index]?.variant_id);
  }) : product.variants;
  return { ...product, variants, price: { amount: selectedMoney.amount, currency: selectedMoney.currency },
    price_amount: selectedMoney.amount, currency: selectedMoney.currency,
    default_variant_id: selected.variant_id };
}

function projectCanonicalOffersMoney(data, ref, moneyByVariant, { productGrain = false, selectedVariantId = null, publicSignatureId = null } = {}) {
  if (!data || !Array.isArray(data.offers)) return data;
  const offers = data.offers.map(offer => {
    // A sibling listing keeps its own primary source. Only this exact selected listing is projected.
    if (offer.merchant_id !== ref.merchant_id || offer.product_id !== ref.product_id) return offer;
    const explicitId = String(offer.selected_variant_id || offer.variant_id || '').trim();
    const id = explicitId || selectedVariantId;
    if (productGrain) {
      // Only the native implicit product variant is backed by the canonical placeholder.
      // An independently hydrated numeric/group variant needs its own exact SKU money.
      const implicitId = selectedVariantId || ref.product_id;
      const signature = /^sig_[a-z0-9]+$/i.test(publicSignatureId || '') ? [publicSignatureId] : [];
      const owned = identity => isOwnImplicitVariantId(identity, ref, signature);
      const identities = [explicitId, ...(offer.variants || []).map(v => String(v.variant_id || '').trim())].filter(Boolean);
      if (!implicitId || !owned(implicitId) || identities.some(identity => !owned(identity))) throw unavailable();
    }
    const money = productGrain ? moneyByVariant.get(CANONICAL_PRODUCT) : moneyByVariant.get(id);
    if (!money) throw unavailable();
    const variants = Array.isArray(offer.variants)
      ? offer.variants.map(variant => {
        const current = productGrain ? money : moneyByVariant.get(String(variant.variant_id));
        if (!current) return projectVariant(variant, moneyByVariant);
        return { ...variant, price: { current: { amount: current.amount, currency: current.currency } } };
      })
      : offer.variants;
    return { ...offer, price: { amount: money.amount, currency: money.currency },
      ...(variants ? { variants } : {}) };
  });
  return rankCanonicalOffers(data, offers);
}

// Every other seller's offer on a verified page shows only money the current read verified. An offer
// with verified money is re-priced from it (offer and each of its own variants) and listed in
// `verifiedOffers`; an offer that could not be verified keeps its listing but loses its money, is out
// of stock and says why, so it can never be bought on a stale cache price. The selected listing is
// already projected by projectCanonicalOffersMoney and is left untouched here.
function projectSellerOffersMoney(data, ref, verifiedByListing) {
  if (!data || !Array.isArray(data.offers)) return { data, verifiedOffers: [] };
  const verifiedOffers = [];
  const offers = data.offers.map(offer => {
    if (isSelectedListingOffer(offer, ref)) return offer;
    const money = verifiedByListing?.get(sellerListingKey(offer));
    const offerVariantId = String(offer?.selected_variant_id || offer?.variant_id || '').trim();
    const rows = Array.isArray(offer?.variants) ? offer.variants : [];
    // Product-grain: one placeholder price for a listing with no own variant axis.
    const grain = money?.get(CANONICAL_PRODUCT);
    const variantMoney = (id) => (grain && (rows.length <= 1) ? grain : money?.get(String(id || '').trim()));
    const selectedMoney = money && variantMoney(offerVariantId || rows[0]?.variant_id || offer?.product_id);
    if (!money || !selectedMoney) {
      const next = { ...withheld(offer), current_own_offer_status: 'unavailable',
        price_verification: 'unverified', inventory: notInStock(offer?.inventory) };
      if (rows.length) next.variants = rows.map(withheldBuiltVariant);
      return next;
    }
    const variants = rows.map(variant => {
      const current = variantMoney(variant?.variant_id);
      if (!current) return withheldBuiltVariant(variant);
      verifiedOffers.push({ offer_id: offer.offer_id, merchant_id: offer.merchant_id, product_id: offer.product_id,
        variant_id: String(variant.variant_id), amount: current.amount, currency: current.currency });
      return { ...variant, price: { current: { amount: current.amount, currency: current.currency } } };
    });
    if (!rows.length) {
      verifiedOffers.push({ offer_id: offer.offer_id, merchant_id: offer.merchant_id, product_id: offer.product_id,
        variant_id: offerVariantId || String(offer.product_id), amount: selectedMoney.amount, currency: selectedMoney.currency });
    }
    return { ...offer, price: { amount: selectedMoney.amount, currency: selectedMoney.currency },
      price_verification: 'verified', ...(rows.length ? { variants } : {}) };
  });
  return { data: rankCanonicalOffers(data, offers), verifiedOffers };
}

function rankCanonicalOffers(data, offers) {
  const prioritized = prioritizeOffers(offers);
  const priced = prioritized.filter(offer => offer?.price?.currency === 'USD');
  const best = [...priced].sort((left, right) => computeOfferTotal(left) - computeOfferTotal(right))[0];
  return { ...data, offers: prioritized, best_price_offer_id: best?.offer_id || null };
}

// Missing current own money is a gap, not a page failure: the selected listing renders unpriced and
// not purchasable. No seed/APV or other-listing money is substituted for it.
function withholdCanonicalProductMoney(product) {
  const next = { ...withheld(product), current_own_offer_status: 'unavailable', in_stock: false };
  if (Array.isArray(product?.variants)) next.variants = product.variants.map(withheldVariant);
  return next;
}

// The same gap applied to an already built PDP payload (the selected offer failed after the product
// was projected): the card, its variants and selector lose their money and the price module goes.
function withholdVariantSelectorMoney(data) {
  if (!data || !Array.isArray(data.variants)) return data;
  return { ...data, variants: data.variants.map(withheldBuiltVariant) };
}

function withholdCanonicalPdpPayloadMoney(payload) {
  if (!payload?.product || typeof payload.product !== 'object') return payload;
  const source = payload.product;
  const product = { ...withheld(source), availability: notInStock(source.availability) };
  if (Array.isArray(source.variants)) product.variants = source.variants.map(withheldBuiltVariant);
  const modules = Array.isArray(payload.modules)
    ? payload.modules.filter(module => module?.type !== 'price_promo').map(module => module?.type === 'variant_selector'
      ? { ...module, data: withholdVariantSelectorMoney(module.data) } : module)
    : payload.modules;
  return { ...payload, product, ...(modules ? { modules } : {}) };
}

const WITHHELD_OFFER_ID_SUFFIX = '__current_own_unavailable';

function isSelectedListingOffer(offer, ref) {
  return offer?.merchant_id === ref.merchant_id && offer?.product_id === ref.product_id;
}

// Only the exact selected listing loses its money; every other listing (another seller, or the same
// seller's twin listing) keeps its own offer, attribution and money. The unpriced offer is out of
// stock and never wins the best-price marker. The card is the selected listing, so the default offer
// is that listing's offer, and it leads its own merchant's offers: a client that picks "the card
// merchant's first offer" (agent-ui pickInternalFirstOfferId) must land on it, not on a priced twin.
// Other merchants' offers keep their relative order. A same-merchant twin can carry the very same offer id
// (buildOfferId has no listing discriminator), so the withheld offer gets its own id here: neither
// marker can then resolve to the twin through the shared id.
function withholdCanonicalOffersMoney(data, ref) {
  if (!data || !Array.isArray(data.offers)) return data;
  const otherIds = new Set(data.offers.filter(offer => !isSelectedListingOffer(offer, ref))
    .map(offer => offer?.offer_id).filter(Boolean));
  const offers = data.offers.map(offer => {
    if (!isSelectedListingOffer(offer, ref)) return offer;
    const next = { ...withheld(offer), current_own_offer_status: 'unavailable', inventory: notInStock(offer.inventory) };
    if (otherIds.has(offer.offer_id)) next.offer_id = `${offer.offer_id}${WITHHELD_OFFER_ID_SUFFIX}`;
    if (Array.isArray(offer.variants)) next.variants = offer.variants.map(withheldBuiltVariant);
    return next;
  });
  const ranked = rankCanonicalOffers(data, offers);
  const own = ranked.offers.find(offer => isSelectedListingOffer(offer, ref));
  if (!own) return ranked;
  const rest = ranked.offers.filter(offer => offer !== own);
  const merchantSlot = rest.findIndex(offer => offer?.merchant_id === own.merchant_id);
  const ordered = merchantSlot < 0 ? ranked.offers
    : [...rest.slice(0, merchantSlot), own, ...rest.slice(merchantSlot)];
  return { ...ranked, offers: ordered, ...(own.offer_id ? { default_offer_id: own.offer_id } : {}) };
}

// A listing without current own money is not purchasable, so a legacy (non-evidence) reply must not
// offer generic "Add to Cart" / "Buy Now" actions for it: they carry no target and send an agent into
// a checkout that cannot succeed. Every other action and all content are kept.
const PURCHASE_ACTION_TYPES = new Set(['add_to_cart', 'buy_now']);

function withoutCanonicalPurchaseActions(response) {
  if (!response || !Array.isArray(response.modules)) return response;
  return {
    ...response,
    modules: response.modules.map(module => {
      const payload = module?.type === 'canonical' ? module.data?.pdp_payload : null;
      if (!payload || !Array.isArray(payload.actions)) return module;
      return { ...module, data: { ...module.data, pdp_payload: { ...payload,
        actions: payload.actions.filter(action => !PURCHASE_ACTION_TYPES.has(action?.action_type)) } } };
    }),
  };
}

module.exports = { usesCanonicalOwnMoney, readCanonicalOwnMoney, readCanonicalSellerOffersMoney, projectSellerOffersMoney,
  MAX_VERIFIED_SELLER_LISTINGS, withoutCanonicalPurchaseActions,
  projectCanonicalProductMoney, projectCanonicalOffersMoney, storedNumericVariant, isCanonicalProductGrain, isOwnImplicitVariantId,
  currentOwnMoneyReasonCode, withholdCanonicalProductMoney, withholdCanonicalPdpPayloadMoney, withholdVariantSelectorMoney,
  withholdCanonicalOffersMoney, CURRENT_OWN_OFFER_UNAVAILABLE, CURRENT_OWN_OFFER_READ_FAILED };
