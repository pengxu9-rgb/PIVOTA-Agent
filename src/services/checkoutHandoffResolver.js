const {
  createExecutionFacingOutput,
} = require('../modules/contracts/executionFacingContracts');
const {
  isWarmHandoffEnabled,
  createWarmHandoffService,
  WARM_HANDOFF_DISPOSITION,
} = require('./ucpWarmHandoff');
const {
  toVariantGid,
  resolveVariantFromSeed,
} = require('./shopifyVariantResolver');

const HANDOFF_KIND = 'pivota_agent_checkout_handoff';
const DIRECT_COMMERCE_PATH = 'pivota_direct_quote_first';
const WARM_HANDOFF_AUTHORITY = 'pivota_ucp_warm_handoff';

const FORBIDDEN_MONEY_FIELDS = new Set([
  'amount',
  'total_amount',
  'totalamount',
  'unit_price',
  'unitprice',
  'expected_amount',
  'expectedamount',
  'confirmation_token',
  'confirmationtoken',
  'card_token',
  'cardtoken',
  'payment_token',
  'paymenttoken',
  'payment_method_token',
  'paymentmethodtoken',
  'client_secret',
  'clientsecret',
  'payment_intent_id',
  'paymentintentid',
  'paymentintent',
  'psp_reference',
  'pspreference',
]);

const AVAILABLE_STATUSES = new Set([
  'available',
  'in_stock',
  'in stock',
  'instock',
]);

const UNAVAILABLE_STATUSES = new Set([
  'out_of_stock',
  'out of stock',
  'sold_out',
  'sold out',
  'unavailable',
]);

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstNonEmptyString(...value);
      if (nested) return nested;
      continue;
    }
    const token = String(value || '').trim();
    if (token) return token;
  }
  return '';
}

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function normalizeAvailability(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function containsForbiddenMoneyField(value, path = []) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = containsForbiddenMoneyField(value[index], [...path, String(index)]);
      if (found) return found;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = normalizeToken(key);
    const nextPath = [...path, key];
    if (FORBIDDEN_MONEY_FIELDS.has(normalizedKey)) {
      return nextPath.join('.');
    }
    const found = containsForbiddenMoneyField(nested, nextPath);
    if (found) return found;
  }
  return null;
}

function readCheckoutHandoffDescriptor(payload = {}) {
  if (!isPlainObject(payload)) return null;
  for (const key of [
    'handoff_descriptor',
    'handoffDescriptor',
    'checkout_handoff',
    'checkoutHandoff',
    'handoff',
    'descriptor',
  ]) {
    if (isPlainObject(payload[key])) return payload[key];
  }
  if (
    normalizeToken(payload.kind) === HANDOFF_KIND ||
    normalizeToken(payload.status) === 'eligible'
  ) {
    return payload;
  }
  return null;
}

function buildBlock(reasonCode, input = {}) {
  const reason = String(reasonCode || 'not_transactable_now').trim();
  return createExecutionFacingOutput({
    context: input.context || {},
    status: 'blocked',
    resolution_authority: 'pivota_live_revalidation',
    fallback_applied: false,
    fallback_reason_codes: [reason],
    resolved_product: input.resolved_product || null,
    resolved_offer: input.resolved_offer || null,
    serviceability: {
      status: 'blocked',
      reason_code: reason,
      ...(input.serviceability && isPlainObject(input.serviceability) ? input.serviceability : {}),
    },
    checkout_handoff: {
      status: 'blocked',
      reason_code: reason,
      kind: HANDOFF_KIND,
      order_created: false,
      payment_submitted: false,
    },
    blockers: [reason],
  });
}

function selectModuleData(pdp, moduleType) {
  const modules = Array.isArray(pdp?.modules)
    ? pdp.modules
    : Array.isArray(pdp?.data?.modules)
      ? pdp.data.modules
      : [];
  const module = modules.find((item) => normalizeToken(item?.type) === normalizeToken(moduleType));
  return isPlainObject(module?.data) ? module.data : null;
}

function extractPdpProduct(pdp) {
  if (!isPlainObject(pdp)) return null;
  if (isPlainObject(pdp.product)) return pdp.product;
  if (isPlainObject(pdp.data?.product)) return pdp.data.product;
  const canonical = selectModuleData(pdp, 'canonical');
  if (isPlainObject(canonical?.pdp_payload?.product)) return canonical.pdp_payload.product;
  if (isPlainObject(canonical?.product)) return canonical.product;
  if (isPlainObject(canonical?.pdp_payload)) return canonical.pdp_payload;
  return null;
}

function extractPdpOffers(pdp, product = null) {
  const candidates = [
    pdp?.offers,
    pdp?.data?.offers,
    product?.offers,
    selectModuleData(pdp, 'offers')?.offers,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((item) => isPlainObject(item));
    }
  }
  return [];
}

function matchesAnyIdentity(candidate, identities) {
  const values = [
    candidate?.offer_id,
    candidate?.offerId,
    candidate?.sku_id,
    candidate?.skuId,
    candidate?.variant_id,
    candidate?.variantId,
    candidate?.selected_variant_id,
    candidate?.selectedVariantId,
    candidate?.product_id,
    candidate?.productId,
  ].map((item) => String(item || '').trim()).filter(Boolean);
  return identities.some((identity) => values.includes(identity));
}

function pickCurrentOffer({ descriptor = {}, offers = [] } = {}) {
  const identities = [
    descriptor.offer_id,
    descriptor.offerId,
    descriptor.sku_id,
    descriptor.skuId,
    descriptor.sku_key,
    descriptor.skuKey,
    descriptor.variant_id,
    descriptor.variantId,
  ].map((item) => String(item || '').trim()).filter(Boolean);

  if (identities.length) {
    const exact = offers.find((offer) => matchesAnyIdentity(offer, identities));
    if (exact) return exact;
  }

  const direct = offers.find((offer) => isCurrentPolicyDirect(offer));
  return direct || offers[0] || null;
}

function valueHasExplicitTrueAvailability(value) {
  if (!isPlainObject(value)) return false;
  const status = normalizeAvailability(
    firstNonEmptyString(
      value.status,
      value.availability_status,
      value.availabilityStatus,
      value.availability,
      value.inventory?.status,
      value.inventory?.availability,
      value.commerce_facts_v1?.availability?.status,
      value.commerceFactsV1?.availability?.status,
    ),
  );
  if (AVAILABLE_STATUSES.has(status)) return true;
  if (value.in_stock === true || value.inStock === true) return true;
  if (value.inventory?.in_stock === true || value.inventory?.inStock === true) return true;
  if (value.availability?.in_stock === true || value.availability?.inStock === true) return true;
  if (value.commerce_facts_v1?.availability?.in_stock === true) return true;

  const quantity = Number(
    value.inventory_quantity ??
      value.inventoryQuantity ??
      value.available_quantity ??
      value.availableQuantity ??
      value.inventory?.quantity ??
      value.inventory?.available_quantity ??
      value.inventory?.availableQuantity ??
      value.availability?.available_quantity ??
      value.availability?.availableQuantity,
  );
  return Number.isFinite(quantity) && quantity > 0;
}

function valueHasExplicitFalseAvailability(value) {
  if (!isPlainObject(value)) return false;
  const status = normalizeAvailability(
    firstNonEmptyString(
      value.status,
      value.availability_status,
      value.availabilityStatus,
      value.availability,
      value.inventory?.status,
      value.inventory?.availability,
      value.commerce_facts_v1?.availability?.status,
      value.commerceFactsV1?.availability?.status,
    ),
  );
  if (UNAVAILABLE_STATUSES.has(status)) return true;
  if (value.in_stock === false || value.inStock === false) return true;
  if (value.inventory?.in_stock === false || value.inventory?.inStock === false) return true;
  if (value.availability?.in_stock === false || value.availability?.inStock === false) return true;
  if (value.commerce_facts_v1?.availability?.in_stock === false) return true;
  return false;
}

function isOfferOrderable(offer, product) {
  if (valueHasExplicitFalseAvailability(offer) || valueHasExplicitFalseAvailability(product)) {
    return false;
  }
  return valueHasExplicitTrueAvailability(offer) || valueHasExplicitTrueAvailability(product);
}

function hasExplicitFalseServing(pdp, product) {
  return (
    pdp?.serviceability?.serving_eligible === false ||
    pdp?.serviceability?.eligible === false ||
    pdp?.serving_eligible === false ||
    pdp?.metadata?.serving_eligible === false ||
    pdp?.metadata?.route_health?.serving_eligible === false ||
    product?.serving_eligible === false ||
    product?.servingEligible === false
  );
}

function hasExplicitTrueServing(pdp, product) {
  return (
    pdp?.serviceability?.serving_eligible === true ||
    pdp?.serviceability?.eligible === true ||
    pdp?.serving_eligible === true ||
    pdp?.metadata?.serving_eligible === true ||
    pdp?.metadata?.route_health?.serving_eligible === true ||
    product?.serving_eligible === true ||
    product?.servingEligible === true
  );
}

function isServingConfirmed(pdp, product, revalidation = {}) {
  if (hasExplicitFalseServing(pdp, product)) return false;
  if (hasExplicitTrueServing(pdp, product)) return true;
  return revalidation.serving_eligible_only === true && normalizeToken(pdp?.status) !== 'blocked';
}

function isCurrentPolicyDirect(value) {
  if (!isPlainObject(value)) return false;
  const purchaseRoute = normalizeToken(value.purchase_route || value.purchaseRoute);
  const commerceMode = normalizeToken(value.commerce_mode || value.commerceMode);
  const checkoutHandoff = normalizeToken(value.checkout_handoff || value.checkoutHandoff);
  const commercePath = normalizeToken(value.commerce_path || value.commercePath);

  if (
    purchaseRoute === 'affiliate_outbound' ||
    purchaseRoute === 'external_checkout' ||
    commerceMode === 'links_out' ||
    checkoutHandoff === 'redirect'
  ) {
    return false;
  }
  if (commercePath === DIRECT_COMMERCE_PATH) return true;
  if (value.allows_pivota_order === true && value.allows_psp_creation === true) return true;
  if (value.allowsPivotaOrder === true && value.allowsPspCreation === true) return true;
  return (
    purchaseRoute === 'internal_checkout' &&
    (checkoutHandoff === 'embedded' || commerceMode === 'merchant_embedded_checkout')
  );
}

function isPolicyStillSupported(descriptor, offer, product, pdp) {
  if (normalizeToken(descriptor?.commerce_path || descriptor?.commercePath) !== DIRECT_COMMERCE_PATH) {
    return false;
  }
  return (
    isCurrentPolicyDirect(offer) ||
    isCurrentPolicyDirect(product) ||
    isCurrentPolicyDirect(pdp?.serviceability)
  );
}

function projectProduct(product, descriptor = {}) {
  if (!isPlainObject(product)) return null;
  return {
    merchant_id: firstNonEmptyString(product.merchant_id, product.merchantId, descriptor.merchant_id),
    product_id: firstNonEmptyString(product.product_id, product.productId, product.id),
    title: firstNonEmptyString(product.title, product.name) || null,
    brand: firstNonEmptyString(product.brand, product.vendor) || null,
    pivota_signature_id: firstNonEmptyString(
      product.pivota_signature_id,
      product.sellable_item_group_id,
      product.sellableItemGroupId,
      descriptor.pivota_signature_id,
    ) || null,
    canonical_url: firstNonEmptyString(product.canonical_url, product.canonicalUrl) || null,
    destination_url: firstNonEmptyString(product.destination_url, product.destinationUrl) || null,
    image_url: firstNonEmptyString(product.image_url, product.imageUrl) || null,
  };
}

function projectOffer(offer, descriptor = {}) {
  if (!isPlainObject(offer)) return null;
  return {
    offer_id: firstNonEmptyString(offer.offer_id, offer.offerId, descriptor.offer_id) || null,
    merchant_id: firstNonEmptyString(offer.merchant_id, offer.merchantId, descriptor.merchant_id) || null,
    product_id: firstNonEmptyString(offer.product_id, offer.productId, descriptor.product_id) || null,
    sku_id: firstNonEmptyString(
      offer.sku_id,
      offer.skuId,
      offer.variant_id,
      offer.variantId,
      offer.selected_variant_id,
      descriptor.sku_id,
      descriptor.sku_key,
    ) || null,
    purchase_route: firstNonEmptyString(offer.purchase_route, offer.purchaseRoute) || null,
    commerce_mode: firstNonEmptyString(offer.commerce_mode, offer.commerceMode) || null,
    checkout_handoff: firstNonEmptyString(offer.checkout_handoff, offer.checkoutHandoff) || null,
    availability_status: firstNonEmptyString(
      offer.availability?.status,
      offer.commerce_facts_v1?.availability?.status,
      offer.availability,
      offer.inventory?.availability,
    ) || null,
    explicit_available_stock: valueHasExplicitTrueAvailability(offer),
  };
}

function buildPreviewQuoteTemplate({ merchantId, productId, skuId }) {
  return {
    operation: 'preview_quote',
    payload: {
      quote: {
        merchant_id: merchantId,
        items: [
          {
            product_id: productId,
            sku_id: skuId,
            quantity: 1,
          },
        ],
      },
    },
  };
}

function buildProductRef(descriptor = {}) {
  const merchantId = firstNonEmptyString(descriptor.merchant_id, descriptor.merchantId);
  const productId = firstNonEmptyString(
    descriptor.pivota_signature_id,
    descriptor.pivotaSignatureId,
    descriptor.product_id,
    descriptor.productId,
    descriptor.product_key,
    descriptor.productKey,
  );
  const offerId = firstNonEmptyString(descriptor.offer_id, descriptor.offerId);
  const variantId = firstNonEmptyString(
    descriptor.sku_id,
    descriptor.skuId,
    descriptor.sku_key,
    descriptor.skuKey,
    descriptor.variant_id,
    descriptor.variantId,
  );
  return {
    ...(merchantId ? { merchant_id: merchantId } : {}),
    ...(productId ? { product_id: productId } : {}),
    ...(offerId ? { offer_id: offerId } : {}),
    ...(variantId ? { variant_id: variantId } : {}),
  };
}

function validateDescriptor(descriptor) {
  if (!isPlainObject(descriptor)) return 'descriptor_missing';
  if (containsForbiddenMoneyField(descriptor)) return 'money_field_in_descriptor';
  if (normalizeToken(descriptor.kind) !== HANDOFF_KIND) return 'descriptor_kind_invalid';
  if (normalizeToken(descriptor.status) !== 'eligible') return 'descriptor_not_eligible';
  if (normalizeToken(descriptor.source_deliverability_status) !== 'transactable') {
    return 'descriptor_not_transactable';
  }
  if (normalizeToken(descriptor.commerce_path || descriptor.commercePath) !== DIRECT_COMMERCE_PATH) {
    return 'policy_not_supported';
  }
  if (!firstNonEmptyString(descriptor.merchant_id, descriptor.merchantId)) {
    return 'merchant_identity_missing';
  }
  if (
    !firstNonEmptyString(
      descriptor.pivota_signature_id,
      descriptor.pivotaSignatureId,
      descriptor.product_id,
      descriptor.productId,
      descriptor.product_key,
      descriptor.productKey,
    )
  ) {
    return 'product_identity_missing';
  }
  return null;
}

function hostFromUrl(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try { return new URL(withScheme).hostname.toLowerCase(); } catch { return ''; }
}

// The brand storefront domain for a crawled offer. Prefer an explicit brand/official domain, then the crawled
// canonical/destination storefront URL. (For a retailer offer this yields the retailer host, whose /.well-known/ucp
// discovery will simply fail -> null -> cold redirect, so no wrong-brand cart is ever built.)
function deriveWarmHandoffBrandDomain(descriptor = {}, product = null, offer = null) {
  return firstNonEmptyString(
    descriptor.brand_domain,
    descriptor.brandDomain,
    descriptor.brand_official_domain,
    descriptor.official_domain,
    hostFromUrl(descriptor.canonical_url),
    hostFromUrl(descriptor.destination_url),
    hostFromUrl(product && product.canonical_url),
    hostFromUrl(product && product.destination_url),
    hostFromUrl(offer && (offer.destination_url || offer.destinationUrl)),
    hostFromUrl(offer && (offer.canonical_url || offer.canonicalUrl)),
  );
}

// Resolve a Shopify variant GID from descriptor/offer/product identifiers, then from any embedded seed_data.
// Offline only (no network) — this runs on the request path.
function deriveWarmHandoffVariantGid(descriptor = {}, product = null, offer = null) {
  const direct = toVariantGid(descriptor.variant_gid)
    || toVariantGid(descriptor.variantGid)
    || toVariantGid(descriptor.variant_id)
    || toVariantGid(descriptor.variantId)
    || toVariantGid(offer && (offer.variant_gid || offer.variantGid))
    || toVariantGid(offer && (offer.variant_id || offer.variantId))
    || toVariantGid(offer && (offer.selected_variant_id || offer.selectedVariantId))
    || toVariantGid(offer && offer.sku_id)
    || toVariantGid(offer && offer.sku);
  if (direct) return direct;
  for (const seed of [descriptor.seed_data, offer && offer.seed_data, product && product.seed_data]) {
    if (isPlainObject(seed)) {
      const fromSeed = resolveVariantFromSeed(seed, { preferAvailable: true });
      if (fromSeed && fromSeed.variantGid) return fromSeed.variantGid;
    }
  }
  return null;
}

function resolveWarmHandoffService(deps = {}) {
  if (deps.warmHandoff && typeof deps.warmHandoff.resolveWarmHandoff === 'function') return deps.warmHandoff;
  if (typeof deps.resolveWarmHandoff === 'function') return { resolveWarmHandoff: deps.resolveWarmHandoff };
  // Prod default: build an env-configured warm-handoff service (only reached when the flag is ON, so never on
  // the flag-OFF path). Cached on deps so repeated policy branches reuse per-domain endpoint discovery.
  try {
    if (!deps.__warmHandoffServiceSingleton) {
      deps.__warmHandoffServiceSingleton = createWarmHandoffService(
        isPlainObject(deps.warmHandoffOptions) ? deps.warmHandoffOptions : {},
      );
    }
    return deps.__warmHandoffServiceSingleton;
  } catch {
    return null;
  }
}

function buildWarmHandoffOutput({ input = {}, descriptor = {}, product = null, offer = null, handoff = {} }) {
  const resolvedProduct = projectProduct(product, descriptor);
  const resolvedOffer = projectOffer(offer, descriptor);
  const output = createExecutionFacingOutput({
    context: input.context || {},
    status: 'resolved',
    resolution_authority: WARM_HANDOFF_AUTHORITY,
    fallback_applied: false,
    fallback_reason_codes: [],
    resolved_product: resolvedProduct,
    resolved_offer: resolvedOffer,
    serviceability: {
      status: 'confirmed',
      disposition: WARM_HANDOFF_DISPOSITION,
      orderable_offer: true,
    },
    checkout_handoff: {
      status: 'warm_handoff_ready',
      kind: HANDOFF_KIND,
      disposition: WARM_HANDOFF_DISPOSITION,
      // The pre-built cart on the BRAND'S OWN Shopify checkout. Returned as a string only; Pivota NEVER opens
      // it server-side and NEVER completes payment.
      continue_url: firstNonEmptyString(handoff.continue_url) || null,
      cart_id: firstNonEmptyString(handoff.cart_id) || null,
      line_item: isPlainObject(handoff.line_item) ? handoff.line_item : null,
      validation_authority: WARM_HANDOFF_AUTHORITY,
      order_created: false,
      payment_submitted: false,
    },
    blockers: [],
  });
  const forbiddenPath = containsForbiddenMoneyField(output);
  if (forbiddenPath) return null;
  return output;
}

// Flag-gated (UCP_WARM_HANDOFF_ENABLED, DEFAULT OFF) attempt to upgrade a cold redirect into a warm handoff:
// a pre-built cart on the brand's own Shopify checkout. Returns an execution-facing warm_handoff output on
// success, or null so the caller keeps today's exact behavior. With the flag OFF this is an immediate no-op,
// so flag-OFF resolution is byte-identical to before this lane existed.
async function maybeResolveWarmHandoff({ input = {}, descriptor = {}, product = null, offer = null, deps = {} }) {
  if (!isWarmHandoffEnabled(deps && deps.env ? deps.env : process.env)) return null;
  const service = resolveWarmHandoffService(deps);
  if (!service) return null;
  const brandDomain = deriveWarmHandoffBrandDomain(descriptor, product, offer);
  const variantGid = deriveWarmHandoffVariantGid(descriptor, product, offer);
  if (!brandDomain || !variantGid) return null;
  let handoff;
  try {
    handoff = await service.resolveWarmHandoff({ brandDomain, variantGid, quantity: 1 });
  } catch {
    return null;
  }
  if (!handoff || !firstNonEmptyString(handoff.continue_url)) return null;
  return buildWarmHandoffOutput({ input, descriptor, product, offer, handoff });
}

async function resolveCheckoutHandoff(input = {}, deps = {}) {
  const accessScope = input.access_scope || input.accessScope || {};
  if (accessScope.allow_checkout_handoff !== true) {
    return buildBlock('checkout_handoff_not_allowed', { context: input.context });
  }

  const payload = input.payload && isPlainObject(input.payload) ? input.payload : {};
  const descriptor = input.descriptor || readCheckoutHandoffDescriptor(payload);
  const descriptorError = validateDescriptor(descriptor);
  if (descriptorError) {
    // A crawled redirect offer fails direct-policy validation with `policy_not_supported`. Before blocking,
    // try the (flag-gated) warm handoff — a pre-built cart on the brand's own Shopify checkout. Flag OFF =>
    // no-op => identical `policy_not_supported` block as before.
    if (descriptorError === 'policy_not_supported') {
      const warm = await maybeResolveWarmHandoff({ input, descriptor, deps });
      if (warm) return warm;
    }
    return buildBlock(descriptorError, { context: input.context });
  }

  const resolvePdp = typeof deps.resolvePdp === 'function' ? deps.resolvePdp : null;
  if (!resolvePdp) return buildBlock('identity_unresolved', { context: input.context });

  let resolved;
  try {
    resolved = await resolvePdp({
      descriptor,
      product_ref: buildProductRef(descriptor),
      include: ['offers'],
      options: { serving_eligible_only: true },
    });
  } catch (err) {
    return buildBlock('identity_unresolved', {
      context: input.context,
      serviceability: {
        upstream_error: err?.code || err?.message || 'pdp_revalidation_failed',
      },
    });
  }

  const pdp = isPlainObject(resolved?.body) ? resolved.body : resolved;
  if (!isPlainObject(pdp) || normalizeToken(pdp.status) === 'blocked' || pdp.error) {
    return buildBlock('identity_unresolved', { context: input.context });
  }

  const product = extractPdpProduct(pdp);
  if (!product) return buildBlock('identity_unresolved', { context: input.context });
  const revalidation = {
    serving_eligible_only: resolved?.serving_eligible_only === true || resolved?.revalidation?.serving_eligible_only === true,
  };
  if (!isServingConfirmed(pdp, product, revalidation)) {
    return buildBlock('serving_not_ready', {
      context: input.context,
      resolved_product: projectProduct(product, descriptor),
    });
  }

  const offers = extractPdpOffers(pdp, product);
  const offer = pickCurrentOffer({ descriptor, offers });
  if (!offer) {
    return buildBlock('offer_not_orderable', {
      context: input.context,
      resolved_product: projectProduct(product, descriptor),
    });
  }

  const resolvedProduct = projectProduct(product, descriptor);
  const resolvedOffer = projectOffer(offer, descriptor);
  if (!isPolicyStillSupported(descriptor, offer, product, pdp)) {
    // Live-revalidated offer is a redirect (not direct Pivota checkout). Try the flag-gated warm handoff using
    // the freshly resolved brand storefront + variant before falling back to the cold-redirect block. Flag OFF
    // => no-op => identical `policy_not_supported` block.
    const warm = await maybeResolveWarmHandoff({ input, descriptor, product, offer, deps });
    if (warm) return warm;
    return buildBlock('policy_not_supported', {
      context: input.context,
      resolved_product: resolvedProduct,
      resolved_offer: resolvedOffer,
    });
  }
  if (!isOfferOrderable(offer, product)) {
    return buildBlock('offer_not_orderable', {
      context: input.context,
      resolved_product: resolvedProduct,
      resolved_offer: resolvedOffer,
    });
  }

  const merchantId = firstNonEmptyString(
    resolvedOffer?.merchant_id,
    resolvedProduct?.merchant_id,
    descriptor.merchant_id,
  );
  const productId = firstNonEmptyString(
    resolvedOffer?.product_id,
    resolvedProduct?.product_id,
    descriptor.product_id,
    descriptor.product_key,
  );
  const skuId = firstNonEmptyString(
    resolvedOffer?.sku_id,
    descriptor.sku_id,
    descriptor.sku_key,
    descriptor.offer_id,
  );
  if (!merchantId || !productId || !skuId) {
    return buildBlock('identity_unresolved', {
      context: input.context,
      resolved_product: resolvedProduct,
      resolved_offer: resolvedOffer,
    });
  }

  const output = createExecutionFacingOutput({
    context: input.context || {},
    status: 'resolved',
    resolution_authority: 'pivota_live_revalidation',
    fallback_applied: false,
    fallback_reason_codes: [],
    resolved_product: resolvedProduct,
    resolved_offer: resolvedOffer,
    serviceability: {
      status: 'confirmed',
      serving_eligible: true,
      orderable_offer: true,
      policy_supported: true,
    },
    checkout_handoff: {
      status: 'quote_ready',
      kind: HANDOFF_KIND,
      source_deliverability_status: 'transactable',
      source_audit_run_id: firstNonEmptyString(
        descriptor.source_audit_run_id,
        descriptor.sourceAuditRunId,
      ) || null,
      validation_authority: 'pivota_live_revalidation',
      preview_quote_template: buildPreviewQuoteTemplate({ merchantId, productId, skuId }),
      order_created: false,
      payment_submitted: false,
    },
    blockers: [],
  });

  const forbiddenPath = containsForbiddenMoneyField(output);
  if (forbiddenPath) {
    return buildBlock('money_field_in_handoff_response', { context: input.context });
  }
  return output;
}

module.exports = {
  DIRECT_COMMERCE_PATH,
  HANDOFF_KIND,
  WARM_HANDOFF_DISPOSITION,
  buildProductRef,
  containsForbiddenMoneyField,
  readCheckoutHandoffDescriptor,
  resolveCheckoutHandoff,
  deriveWarmHandoffBrandDomain,
  deriveWarmHandoffVariantGid,
  maybeResolveWarmHandoff,
};
