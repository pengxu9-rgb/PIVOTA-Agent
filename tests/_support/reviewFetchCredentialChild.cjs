'use strict';

// EVERY OPERATION THAT REACHES THE REVIEW-SUMMARY FETCH, THROUGH THE REAL HANDLERS, in its own process.
// Prints nothing; writes one JSON file. Driven by tests/review_summary_fetch_credential.node.test.cjs.
//
// REAL: the app (routes, auth, the invoke handler, the review-summary cache).
// STUBBED: every host the app dials. One recorder answers all of them and keeps what was sent: method, host,
// path, body, and WHICH credential each header carried (a class, never a value).
//
// Usage: node tests/_support/reviewFetchCredentialChild.cjs <outfile> <auth: real|bypass> <service: on|off>
//   auth=real    the key and checkout-token checks run against a stub auth service
//   auth=bypass  the test-runtime bypass: a request reaches the handler with no key of its own
//   service=off  the gateway has no service credential configured

const fs = require('node:fs');
const path = require('node:path');
const nock = require('nock');
const supertest = require('supertest');

const [outFile, authMode = 'real', serviceMode = 'on'] = process.argv.slice(2);

const BACKEND = 'http://backend.test';
const REVIEWS = 'http://reviews.test';
const AUTH = 'http://auth.test';
const INTROSPECT_PATH = '/agent/internal/auth/introspect';
const INVOKE_PATH = '/agent/shop/v1/invoke';
const SERVICE_KEY = 'service-key-placeholder';
const INTERNAL_KEY = 'internal-key-placeholder';
const CALLER_KEY = `ak_live_${'a'.repeat(64)}`;
const SECOND_CALLER_KEY = `ak_live_${'b'.repeat(64)}`;
const CHECKOUT_TOKEN = `v1.${Buffer.from(JSON.stringify({ agent_id: 'agent_ct', exp: 9999999999 })).toString('base64url')}.${'s'.repeat(43)}`;
const BUYER_REF = 'buyer-ref-placeholder';
const USER_JWT = 'user-jwt-placeholder';
const MERCHANT = 'm_placeholder';

Object.assign(process.env, {
  NODE_ENV: 'test',
  PIVOTA_API_BASE: BACKEND,
  REVIEWS_API_BASE: REVIEWS,
  AGENT_AUTH_EMERGENCY_FALLBACK_ENABLED: 'false',
  LOG_LEVEL: 'silent',
});
for (const name of [
  'DATABASE_URL', 'PIVOTA_API_KEY', 'AGENT_AUTH_INTROSPECT_URL', 'AGENT_AUTH_INTROSPECT_INTERNAL_KEY',
  'INVOKE_AUTH_BYPASS_IN_TEST', 'AGENT_CHECKOUT_STRICT', 'REVIEWS_BACKEND_URL', 'REVIEWS_BACKEND',
  'PDP_REVIEW_SUMMARY_CACHE_ENABLED',
]) delete process.env[name];
if (serviceMode === 'on') process.env.PIVOTA_API_KEY = SERVICE_KEY;
if (authMode === 'real') {
  process.env.AGENT_AUTH_INTROSPECT_URL = `${AUTH}${INTROSPECT_PATH}`;
  process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY = INTERNAL_KEY;
}

let current = null;
const stray = [];

function credentialClass(value) {
  if (!value) return null;
  const raw = String(value).replace(/^Bearer\s+/i, '');
  if (raw === CALLER_KEY) return 'caller_key';
  if (raw === SECOND_CALLER_KEY) return 'second_caller_key';
  if (raw === SERVICE_KEY) return 'service_key';
  if (raw === INTERNAL_KEY) return 'internal_key';
  if (raw === CHECKOUT_TOKEN) return 'checkout_token';
  return 'other';
}

function callerDerivedClass(value) {
  if (!value) return null;
  if (value === BUYER_REF) return 'buyer_ref';
  if (value === USER_JWT) return 'user_jwt';
  return 'other';
}

const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'x-agent-api-key', 'x-internal-key', 'x-checkout-token'];
const CALLER_DERIVED_HEADERS = ['x-buyer-ref', 'x-agent-user-jwt'];

function identityOf(rawHeaders) {
  const headers = {};
  for (const [k, v] of Object.entries(rawHeaders || {})) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v);
  const identity = {};
  for (const name of CREDENTIAL_HEADERS) identity[name] = credentialClass(headers[name]);
  for (const name of CALLER_DERIVED_HEADERS) identity[name] = callerDerivedClass(headers[name]);
  // Every other x- header by NAME, so a header one build sends and the other does not is a visible difference.
  identity.other = Object.keys(headers)
    .filter((k) => k.startsWith('x-') && !CREDENTIAL_HEADERS.includes(k) && !CALLER_DERIVED_HEADERS.includes(k))
    .sort();
  return identity;
}

function productFor(productId) {
  return {
    merchant_id: MERCHANT,
    product_id: productId,
    platform: 'placeholder_platform',
    platform_product_id: productId,
    title: 'Placeholder Serum',
    description: 'A placeholder product.',
    in_stock: true,
    currency: 'USD',
    price: { amount: 29, currency: 'USD' },
    variants: [{ variant_id: `${productId}_v1`, title: 'Default', price: 29, currency: 'USD', in_stock: true }],
  };
}

function cannedReply(uri, body) {
  const p = uri.split('?')[0];
  if (p === INTROSPECT_PATH) {
    if (body && body.checkout_token) {
      return [200, {
        valid: true,
        agent_id: 'agent_ct',
        is_active: true,
        auth_source: 'checkout_token',
        scopes: ['checkout'],
        merchant_ids: [MERCHANT],
        expires_at: Math.floor(Date.now() / 1000) + 600,
      }];
    }
    return [200, { valid: true, agent_id: 'agent_key', is_active: true, auth_source: 'agent_api_key', scopes: ['*'] }];
  }
  if (p === INVOKE_PATH && body && body.operation === 'get_review_summary') {
    return [200, { review_summary: { scale: 5, rating: 4.5, review_count: 12, source: 'placeholder_review_source' } }];
  }
  if (p === INVOKE_PATH && body && body.operation === 'get_product_detail') {
    const productId = body.payload && body.payload.product && body.payload.product.product_id;
    return [200, { product: productFor(String(productId || 'p_placeholder')) }];
  }
  if (p.startsWith('/agent/v1/product-groups/')) return [200, { status: 'success', product_group_id: null, members: [] }];
  return [200, { status: 'success', products: [], items: [], total: 0 }];
}

const isLoopback = (host) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
nock.disableNetConnect();
nock.enableNetConnect(isLoopback);
for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
  nock(/^https?:\/\/(?!127\.0\.0\.1|localhost|\[::1\])/)
    .persist()
    .intercept(/.*/, method)
    .reply(function record(uri, body) {
      let parsed = body;
      if (typeof body === 'string') {
        try {
          parsed = JSON.parse(body);
        } catch {
          // not JSON: keep the text
        }
      }
      const entry = {
        method,
        host: this.req.options.host || this.req.options.hostname || null,
        path: uri,
        body: parsed === '' ? null : parsed,
        identity: identityOf(this.req.headers),
      };
      (current ? current.outbound : stray).push(entry);
      return cannedReply(uri, parsed);
    });
}

// The warning lines the app writes, as (fields, message). No header value is ever a field of these.
const logger = require(path.join(__dirname, '..', '..', 'src', 'logger'));
const warnings = [];
logger.warn = function recordWarn(fields, message) {
  const entry = typeof fields === 'string' ? { fields: {}, message: fields } : { fields: fields || {}, message: message || '' };
  if (/review summary/i.test(entry.message)) warnings.push({ during: current ? current.id : null, ...entry });
};

const app = require(path.join(__dirname, '..', '..', 'src', 'server'));

const CREDENTIALS = {
  none: {},
  key: { Authorization: `Bearer ${CALLER_KEY}` },
  second_key: { Authorization: `Bearer ${SECOND_CALLER_KEY}` },
  // A caller's key with everything caller-derived a request can carry beside it.
  key_buyer: { Authorization: `Bearer ${CALLER_KEY}`, 'X-Buyer-Ref': BUYER_REF, 'X-Agent-User-JWT': USER_JWT },
  key_token: { Authorization: `Bearer ${CALLER_KEY}`, 'X-Checkout-Token': CHECKOUT_TOKEN },
  token: { 'X-Checkout-Token': CHECKOUT_TOKEN },
};

// The operations that reach the review-summary fetch.
function reviewPayload(operation, productId) {
  const ref = { merchant_id: MERCHANT, product_id: productId };
  if (operation === 'get_pdp_v2') return { include: ['offers', 'reviews_preview'], product_ref: ref };
  if (operation === 'prepare_pivota_insights_coverage_v1') return { product_refs: [ref], limit: 1 };
  return { product_ref: ref };
}
const REVIEW_OPERATIONS = ['get_pdp_v2', 'get_product_feedback_v1', 'prepare_pivota_insights_coverage_v1'];
// Neighbouring reads on the same route, which never reach the review fetch.
const NEIGHBOUR_PAYLOADS = {
  get_product_detail: { product: { merchant_id: MERCHANT, product_id: 'p_neighbour_detail' } },
  find_similar_products: { similar: { product_id: 'p_neighbour_similar', limit: 4 } },
  find_products: { search: { merchant_id: MERCHANT, query: 'placeholder serum', page: 1, page_size: 5 } },
  'offers.resolve': { offers: { product: { product_id: 'p_neighbour_offers' }, market: 'US', limit: 3 } },
  get_product_intel_v1: { product_ref: { merchant_id: MERCHANT, product_id: 'p_neighbour_intel' } },
};
const ADDRESSES = { shop: '/agent/shop/v1/invoke', creator: '/agent/creator/v1/invoke' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
let baseUrl = null;

async function send(id, address, body, headers) {
  current = { id, outbound: [] };
  const mine = current;
  let request = supertest(baseUrl).post(address);
  for (const [k, v] of Object.entries(headers)) request = request.set(k, v);
  let res;
  try {
    res = await request.send(body).timeout({ response: 60000, deadline: 60000 });
  } catch (err) {
    res = err.response || { status: `ERR:${err.code || err.message}`, body: null };
  }
  // Work the handler started after it answered is recorded under this request, not the next.
  await sleep(25);
  current = null;
  results.push({
    id,
    operation: body.operation,
    status: res.status,
    body: res.body && Object.keys(res.body).length ? res.body : (res.text || null),
    outbound: mine.outbound,
  });
}

async function main() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const credentials = authMode === 'real' ? ['key', 'key_buyer', 'key_token', 'token', 'none'] : ['none', 'token', 'key_buyer'];
  for (const [label, address] of Object.entries(ADDRESSES)) {
    for (const operation of REVIEW_OPERATIONS) {
      for (const credential of credentials) {
        // Its own product per case, so no case is answered from what another one cached.
        const productId = `p_${label}_${operation}_${credential}`.replace(/[^a-z0-9_]/gi, '_');
        await send(`${label}|${operation}|${credential}`, address, { operation, payload: reviewPayload(operation, productId) }, CREDENTIALS[credential]);
      }
    }
    for (const [operation, payload] of Object.entries(NEIGHBOUR_PAYLOADS)) {
      const credential = authMode === 'real' ? 'key_buyer' : 'none';
      await send(`${label}|neighbour:${operation}|${credential}`, address, { operation, payload }, CREDENTIALS[credential]);
    }
  }

  // ONE product, asked for by two different callers: the second is answered from the first one's entry.
  const first = authMode === 'real' ? 'key_buyer' : 'token';
  const second = authMode === 'real' ? 'second_key' : 'none';
  for (const [n, credential] of [[1, first], [2, second]]) {
    await send(`cache|get_pdp_v2|caller_${n}:${credential}`, ADDRESSES.shop, {
      operation: 'get_pdp_v2',
      payload: reviewPayload('get_pdp_v2', 'p_shared_between_callers'),
    }, CREDENTIALS[credential]);
  }

  fs.writeFileSync(outFile, JSON.stringify({ auth: authMode, service: serviceMode, results, stray, warnings }));
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`reviewFetchCredentialChild failed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(2);
});
