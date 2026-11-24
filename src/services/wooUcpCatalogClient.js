'use strict';

const { createPublicNetworkFetch } = require('./ucpBuyerAgentClient');
const { DEFAULT_UCP_VERSION, SHOPPING_SERVICE, CATALOG_LOOKUP_CAPABILITY } = require('./ucpBuyerAgentProfile');

const WOO_REST_PATH = '/wp-json/wc/ucp/v1';
const WOO_ID = /^[1-9][0-9]{0,19}$/;

function fail(code, evidence) {
  throw Object.assign(new Error(code), { code, evidence });
}

function httpsUrl(value, errorCode, evidence) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !/[?#]/.test(url.href)) return url;
  } catch {
    // Report a stable code without logging the supplied value.
  }
  return fail(errorCode, evidence);
}

function declaresLookup(ucp) {
  const entries = ucp?.capabilities?.[CATALOG_LOOKUP_CAPABILITY];
  return Array.isArray(entries) && entries.some((entry) => entry?.version === DEFAULT_UCP_VERSION);
}

function catalogEndpoint(profile, origin, evidence) {
  const ucp = profile?.ucp;
  if (ucp?.version !== DEFAULT_UCP_VERSION) fail('discovery_version_unsupported', evidence);
  if (!declaresLookup(ucp)) fail('lookup_capability_missing', evidence);
  const bindings = ucp.services?.[SHOPPING_SERVICE];
  const rest = Array.isArray(bindings)
    ? bindings.filter((binding) => binding?.transport === 'rest' && binding.version === DEFAULT_UCP_VERSION)
    : [];
  if (rest.length !== 1 || typeof rest[0].endpoint !== 'string') fail('rest_binding_missing_or_ambiguous', evidence);
  const endpoint = httpsUrl(rest[0].endpoint, 'unexpected_woo_binding', evidence);
  if (endpoint.origin !== origin) fail('proxy_or_external_binding', evidence);
  endpoint.pathname = endpoint.pathname.replace(/\/$/, '');
  if (!endpoint.pathname.endsWith(WOO_REST_PATH)) fail('unexpected_woo_binding', evidence);
  return endpoint.href;
}

function readExactVariant(body, { productId, variantId, currency }, evidence) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const { ucp, products } = body ?? {};
  if (ucp?.version !== DEFAULT_UCP_VERSION || ucp.status !== 'success' || !declaresLookup(ucp) ||
      messages.some((message) => message?.type === 'error')) {
    fail('lookup_ucp_failure', evidence);
  }
  if (!Array.isArray(products)) fail('invalid_lookup_response', evidence);
  if (products.length === 0 && messages.some((message) => message?.code === 'not_found')) fail('not_found', evidence);

  const [product] = products;
  const variants = product?.variants;
  const variant = Array.isArray(variants) && variants.length === 1 ? variants[0] : null;
  if (products.length !== 1 || product?.id !== productId || variant?.id !== variantId ||
      !Array.isArray(variant.inputs) || !variant.inputs.some((input) => input?.id === variantId && input.match === 'exact')) {
    fail('exact_variant_not_returned', evidence);
  }

  const amount = variant.price?.amount;
  const observedCurrency = variant.price?.currency;
  const available = variant.availability?.available;
  if (!Number.isSafeInteger(amount) || amount < 0 || typeof observedCurrency !== 'string' ||
      !/^[A-Z]{3}$/.test(observedCurrency) || typeof available !== 'boolean') {
    fail('invalid_variant_price_or_availability', evidence);
  }
  if (observedCurrency !== currency || messages.some((message) => message?.code === 'currency_not_supported')) {
    fail('currency_mismatch', { ...evidence, observedCurrency });
  }
  return { productId, variantId, sku: typeof variant.sku === 'string' ? variant.sku : null, price: { amount, currency }, available };
}

/**
 * Direct catalog reads for one operator-configured WooCommerce origin. Use verified
 * Woo product/variation IDs and an explicit market and currency. The response is
 * catalog data. The caller must verify shipping and checkout totals separately.
 */
function createWooUcpCatalogClient({ merchantOrigin, profileUrl, fetchMerchant = createPublicNetworkFetch(), timeoutMs = 10000 } = {}) {
  const target = httpsUrl(merchantOrigin, 'expected_bare_https_origin');
  if (target.pathname !== '/') fail('expected_bare_https_origin');
  const { origin } = target;
  const headers = { accept: 'application/json', 'user-agent': 'Pivota-UCP-BuyerAgent/1.0' };
  if (profileUrl) headers['ucp-agent'] = `profile="${httpsUrl(profileUrl, 'expected_public_https_agent_profile').href}"`;

  async function requestJson(url, stage, options = {}) {
    const response = await fetchMerchant(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const evidence = { stage, http: response.status, type };
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      fail('rate_limited', { ...evidence, retryAfter: /^\d{1,10}$/.test(retryAfter ?? '') ? retryAfter : undefined });
    }
    if (response.status === 401) fail('authentication_required', evidence);
    if (response.status === 403) fail('access_denied', evidence);
    if (response.status === 404) fail('route_unavailable', evidence);
    if (response.status >= 300 && response.status < 400) fail('redirect', evidence);
    if (!response.ok) fail('http_failure', evidence);
    if (type !== 'application/json') fail('unexpected_content_type', evidence);
    try {
      return { evidence, body: await response.json() };
    } catch {
      return fail('invalid_json', evidence);
    }
  }

  async function lookupVariant({ productId, variantId, country, currency }) {
    if (![productId, variantId].every((id) => typeof id === 'string' && WOO_ID.test(id)) || productId === variantId) {
      fail('expected_distinct_numeric_woo_ids');
    }
    if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country) ||
        typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      fail('expected_market_and_currency');
    }

    const discovery = await requestJson(`${origin}/.well-known/ucp`, 'discovery', { headers });
    const endpoint = catalogEndpoint(discovery.body, origin, discovery.evidence);
    const lookup = await requestJson(`${endpoint}/catalog/lookup`, 'lookup', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [variantId], context: { address_country: country, currency } }),
    });
    const messages = Array.isArray(lookup.body?.messages) ? lookup.body.messages : [];
    const codes = messages.slice(0, 15).map((message) => message?.code)
      .filter((code) => typeof code === 'string' && /^[\w.-]{1,80}$/.test(code));
    const evidence = { ...lookup.evidence, codes };
    const variant = readExactVariant(lookup.body, { productId, variantId, currency }, evidence);
    return {
      origin, version: DEFAULT_UCP_VERSION,
      discovery: { ...discovery.evidence, transport: 'rest', endpoint },
      lookup: { ...evidence, ...variant },
    };
  }

  return { lookupVariant };
}

module.exports = { createWooUcpCatalogClient };
