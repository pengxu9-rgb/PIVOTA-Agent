'use strict';

const path = require('node:path');

const VERSION = '2026-04-08';
const LOOKUP = 'dev.ucp.shopping.catalog.lookup';
const FIXTURE_SKU = 'UCP-FIX-BLUE';
const FIXTURE_AMOUNT = 1234;

function reject(code, evidence) {
  throw Object.assign(new Error(code), { code, evidence });
}

function readOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    reject('expected_bare_https_origin');
  }
  return url.origin;
}

function messages(body) {
  if (!Array.isArray(body?.messages)) return [];
  return body.messages.slice(0, 15).map((message) => message?.code)
    .filter((code) => typeof code === 'string' && /^[\w.-]{1,80}$/.test(code));
}

async function jsonResponse(fetchMerchant, url, options, stage) {
  const response = await fetchMerchant(url, {
    ...options, redirect: 'manual', signal: AbortSignal.timeout(10000),
  });
  const type = response.headers.get('content-type')?.split(';')[0];
  const evidence = { stage, http: response.status, type };
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    reject('rate_limited', { ...evidence, retryAfter: /^\d{1,10}$/.test(retryAfter ?? '') ? retryAfter : undefined });
  }
  if (response.status === 401) reject('authentication_required', evidence);
  if (response.status === 403) reject('access_denied', evidence);
  if (response.status >= 300 && response.status < 400) reject('redirect', evidence);
  if (!response.ok) reject('http_failure', evidence);
  if (type?.toLowerCase() !== 'application/json') reject('unexpected_content_type', evidence);
  try {
    return { evidence, body: await response.json() };
  } catch {
    reject('invalid_json', evidence);
  }
}

async function probeWooCatalog({ fetchMerchant, origin, productId, variantId, profile }) {
  origin = readOrigin(origin);
  if (![productId, variantId].every((id) => /^[1-9]\d{0,19}$/.test(id ?? '')) || productId === variantId) {
    reject('expected_distinct_numeric_woo_ids');
  }

  const headers = { accept: 'application/json', 'user-agent': 'Pivota-UCP-Catalog-Check/1.0' };
  if (profile) {
    const profileUrl = new URL(profile);
    if (profileUrl.protocol !== 'https:' || profileUrl.username || profileUrl.password || profileUrl.search || profileUrl.hash) {
      reject('expected_public_https_agent_profile');
    }
    headers['ucp-agent'] = `profile="${profileUrl.href}"`;
  }

  const discovery = await jsonResponse(fetchMerchant, `${origin}/.well-known/ucp`, { headers }, 'discovery');
  const ucp = discovery.body?.ucp;
  if (ucp?.version !== VERSION) reject('discovery_version_unsupported', discovery.evidence);
  if (!Array.isArray(ucp.capabilities?.[LOOKUP]) || !ucp.capabilities[LOOKUP].some((entry) => entry?.version === VERSION)) {
    reject('lookup_capability_missing', discovery.evidence);
  }
  const bindings = ucp.services?.['dev.ucp.shopping'];
  const rest = Array.isArray(bindings) && bindings.filter((item) => item?.transport === 'rest' && item.version === VERSION);
  if (!rest || rest.length !== 1 || typeof rest[0].endpoint !== 'string') reject('rest_binding_missing_or_ambiguous', discovery.evidence);
  const endpoint = new URL(rest[0].endpoint);
  if (endpoint.origin !== origin) reject('proxy_or_external_binding', discovery.evidence);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !endpoint.pathname.replace(/\/$/, '').endsWith('/wp-json/wc/ucp/v1')) {
    reject('unexpected_woo_binding', discovery.evidence);
  }

  const lookupUrl = `${endpoint.href.replace(/\/$/, '')}/catalog/lookup`;
  const lookup = await jsonResponse(fetchMerchant, lookupUrl, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [variantId], context: { address_country: 'US', currency: 'USD' } }),
  }, 'lookup');
  const evidence = { ...lookup.evidence, codes: messages(lookup.body) };
  if (lookup.body?.ucp?.version !== VERSION || lookup.body.ucp.status !== 'success') reject('lookup_ucp_failure', evidence);
  const [product, extraProduct] = Array.isArray(lookup.body.products) ? lookup.body.products : [];
  const [variant, extraVariant] = Array.isArray(product?.variants) ? product.variants : [];
  if (extraProduct || extraVariant || product?.id !== productId || variant?.id !== variantId ||
      !Array.isArray(variant.inputs) || !variant.inputs.some((item) => item?.id === variantId && item.match === 'exact') ||
      variant.sku !== FIXTURE_SKU) {
    reject('exact_fixture_variant_not_returned', evidence);
  }
  if (variant.price?.amount !== FIXTURE_AMOUNT || variant.price?.currency !== 'USD' ||
      variant.availability?.available !== true || evidence.codes.includes('currency_not_supported')) {
    reject('fixture_price_or_availability_mismatch', evidence);
  }

  return {
    status: 'pass', origin, version: VERSION, auth: 'anonymous', profileIncluded: Boolean(profile),
    discovery: { ...discovery.evidence, transport: 'rest', endpoint: endpoint.href },
    lookup: { ...evidence, productId, variantId, sku: FIXTURE_SKU, price: { amount: FIXTURE_AMOUNT, currency: 'USD' }, available: true },
  };
}

module.exports = { probeWooCatalog };

if (require.main === module) {
  const [gateway, origin, productId, variantId] = process.argv.slice(2);
  if (!gateway || !origin || !productId || !variantId) {
    console.error('Usage: node probe-woo-catalog.cjs GATEWAY_ROOT HTTPS_ORIGIN PRODUCT_ID VARIANT_ID');
    process.exitCode = 2;
  } else {
    const { createPublicNetworkFetch } = require(path.resolve(gateway, 'src/services/ucpBuyerAgentClient.js'));
    probeWooCatalog({
      fetchMerchant: createPublicNetworkFetch(), origin, productId, variantId,
      profile: process.env.WOO_CATALOG_AGENT_PROFILE_URL,
    }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
      console.error(JSON.stringify({ status: 'failed', code: error.code ?? error.name, evidence: error.evidence }));
      process.exitCode = 1;
    });
  }
}
