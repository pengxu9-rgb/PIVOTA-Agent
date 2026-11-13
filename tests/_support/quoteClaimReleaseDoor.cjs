'use strict';

// THE QUOTE-CLAIM DOOR FIXTURE: the real gateway app, offline, with the three doors that turn a priced session
// into an order lit (`/mcp` complete_checkout_session, `/mcp` create_payment_link, ACP REST complete), and a
// backend whose answer to "create the order" a test scripts one call at a time. Used by
// tests/quote_claim_release_door.node.test.cjs, and by a private differential harness that boots it over two
// trees (`root`) and compares answers and outbound traffic.
//
// REAL: the routes, the JSON-RPC adapter, the tool surface, the ACP REST adapter (its signature check and its
// buyer token verifier), the shared intake, the canonical executor, the payment-authorization verifier (a signed
// grant, checked against a key this fixture mints), the kernel, its ledger and stores, and the gateway's own
// upstream transport: the request it builds for the backend, and what it makes of every answer and of no answer.
//
// STUBBED: the BACKEND, with nock, because none is reachable here. Every request it receives is recorded
// (`upstream`), so a test can count the orders asked for. It prices a cart in the currency of the country the
// request ships to (PRICED_IN below; `none` = the request names no country). The gateway holds no such table on
// this path: the session's currency is whatever the backend answered.
// Every name is a placeholder.

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const nock = require('nock');

const IDS = Object.freeze({
  PRODUCT: `sig_${'1'.repeat(32)}`,
  SOURCE: '9001',
  SELLER: 'merch_shop_a',
  VARIANT: 'v-9001-1',
});
const PRICED_IN = Object.freeze({ US: 'USD', SG: 'SGD', GB: 'GBP', DE: 'EUR', none: 'USD' });
const UNIT_MINOR = 1800;
const BACKEND_BASE = 'http://backend.quote-claim.test';
const BUYER = Object.freeze({ 'X-Test-User-Ref': 'buyer-0001', 'X-Test-Acp-Session-Id': 'sess-0001' });
const ACP_SECRET = 'acp-signing-secret-0123456789abc';
const ACP_BUYER_ISSUER = 'https://buyer-idp.quote-claim.test';
const ACP_BUYER_AUDIENCE = 'https://agent.quote-claim.test/acp';
const GRANT_ISSUER = 'https://grants.quote-claim.test';
const GRANT_AUDIENCE = 'https://agent.quote-claim.test/pay';
const address = (country) => ({ name: 'Buyer One', address_line1: '1 Example Road', city: 'Exampleton', postal_code: '00001', country });

/** The key pairs this run verifies with: the ACP buyer credential, and the payment grants. */
async function mintKeys() {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const buyerPair = await generateKeyPair('ES256', { extractable: true });
  const buyerPub = await exportJWK(buyerPair.publicKey);
  Object.assign(buyerPub, { kid: 'buyer-k1', alg: 'ES256' });
  const buyerToken = await new SignJWT({ email: 'buyer@example.test', email_verified: true })
    .setProtectedHeader({ alg: 'ES256', kid: 'buyer-k1' })
    .setIssuer(ACP_BUYER_ISSUER).setAudience(ACP_BUYER_AUDIENCE).setSubject('buyer-0001')
    .setIssuedAt().setExpirationTime('2h').sign(buyerPair.privateKey);
  const grantPair = await generateKeyPair('ES256', { extractable: true });
  const grantPub = await exportJWK(grantPair.publicKey);
  Object.assign(grantPub, { kid: 'grant-k1', alg: 'ES256' });
  /** A buyer's signed payment grant: up to `maxAmount` (minor units) of `currency`, to this seller, for this checkout. */
  const mintGrant = ({ sessionId, currency, maxAmount }) => new SignJWT({ max_amount: maxAmount, currency, merchant_id: IDS.SELLER, checkout_session_id: sessionId })
    .setProtectedHeader({ alg: 'ES256', kid: 'grant-k1' })
    .setIssuer(GRANT_ISSUER).setAudience(GRANT_AUDIENCE)
    .setIssuedAt().setExpirationTime('2h').sign(grantPair.privateKey);
  return { buyerJwks: { keys: [buyerPub] }, buyerToken, grantJwks: { keys: [grantPub] }, mintGrant };
}

// ---- the backend's answers to POST /agent/v2/orders, in its own wire shape ----------------------------------------
//
// THE BACKEND'S ERROR ENVELOPE. A route raises an HTTP error with a `detail` (an object, usually naming its code
// in `error`, or a plain string). Before it leaves the backend, every JSON error of status 400 or more is re-wrapped:
//
//   { status: 'error',
//     error: { code, message, details, documentation_url },
//     metadata: { timestamp, request_id },
//     detail }                                   <- the route's own `detail`, unchanged
//
//   - `error.code` is derived from the STATUS alone (STATUS_CODE below; any other status gets the 500 code).
//   - `error.details` is the route's `detail` when that is an object, `{ error: <the string> }` when it is a string.
//   - `error.message` is `detail.error` when the object names one, the string when `detail` is a string, and
//     otherwise the status code's default message.
//   - a 422 (request validation, `detail` a list) is answered as a 400 with `details.validation_errors`.
//   - response headers (a busy 503's Retry-After) are kept.
//
// So the code a route chose is in `error.details.error`, and EVERY error carries some `error.code`. `backendError`
// builds exactly that; a test pins it against bodies written out by hand. The timestamp, the request id and the
// documentation link are placeholders.
const STATUS_CODE = Object.freeze({
  400: ['INVALID_REQUEST', 'Invalid request format or parameters'],
  401: ['UNAUTHORIZED', 'Authentication required'],
  403: ['FORBIDDEN', 'You don\'t have permission to access this resource'],
  404: ['PRODUCT_NOT_FOUND', 'Product not found'],
  409: ['CONFLICT', 'Request conflicts with the current state of the resource'],
  429: ['RATE_LIMIT_EXCEEDED', 'Too many requests, please try again later'],
  500: ['INTERNAL_SERVER_ERROR', 'An unexpected error occurred'],
  502: ['EXTERNAL_SERVICE_ERROR', 'External service request failed'],
  503: ['EXTERNAL_SERVICE_ERROR', 'External service request failed'],
});
const ENVELOPE_PLACEHOLDERS = Object.freeze({ documentation_url: 'https://docs.backend.quote-claim.test/errors', timestamp: '2026-01-01T00:00:00.000000Z', request_id: null });
const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
/** The backend's wire answer for a route error: `{ status, body }`. */
function backendError(status, detail) {
  const wrap = (code, message, details) => ({
    status: 'error',
    error: { code, message, details, documentation_url: ENVELOPE_PLACEHOLDERS.documentation_url },
    metadata: { timestamp: ENVELOPE_PLACEHOLDERS.timestamp, request_id: ENVELOPE_PLACEHOLDERS.request_id },
    detail,
  });
  if (status === 422) {
    const errors = (Array.isArray(detail) ? detail : []).filter(isObject).map((e) => ({ field: (e.loc || []).map(String).join(' -> '), message: e.msg ?? 'Invalid value', type: e.type ?? 'validation_error' }));
    return { status: 400, body: wrap(STATUS_CODE[400][0], 'Request validation failed', { validation_errors: errors }) };
  }
  const [code, defaultMessage] = STATUS_CODE[status] || STATUS_CODE[500];
  if (isObject(detail)) return { status, body: wrap(code, typeof detail.error === 'string' ? detail.error : defaultMessage, detail) };
  if (typeof detail === 'string') return { status, body: wrap(code, detail, { error: detail }) };
  return { status, body: wrap(code, defaultMessage, detail == null ? {} : { raw: detail }) };
}
/** A scripted answer in the backend's envelope. `landed`: the backend wrote the order before it answered this. */
const fromBackend = (status, detail, { landed = false, headers } = {}) => ({ kind: 'reply', landed, ...backendError(status, detail), ...(headers ? { headers } : {}) });

// THE ROUTE ERRORS OF THE BACKEND'S ORDER-CREATE PATH, with the status and `detail` each raise site writes.
// `BEFORE_ANY_ORDER`: raised only in the request's prologue, before the backend first tries to write the order.
const BEFORE_ANY_ORDER = Object.freeze({
  partnerAssertionRejected: [409, { error: 'PARTNER_ASSERTION_REJECTED', reason: 'stale', message: 'The partner assertion on this request was refused; it was not made as any partner.' }],
  quoteNotFound: [404, { error: 'QUOTE_NOT_FOUND', message: 'Quote not found' }],
  invalidQuote: [400, { error: 'INVALID_QUOTE', message: 'quote snapshot does not contain orderable items' }],
  invalidBuyer: [400, { error: 'INVALID_BUYER_CONTEXT', message: 'buyer_context.customer_email is required for order creation' }],
  quoteRequiredBeforePurchase: [400, { error: 'QUOTE_REQUIRED_BEFORE_PURCHASE', message: 'placeholder' }],
  unsupportedCommercePath: [409, { error: 'UNSUPPORTED_COMMERCE_PATH', message: 'placeholder' }],
  quoteMerchantMismatch: [400, { error: 'QUOTE_MERCHANT_MISMATCH', message: 'placeholder' }],
  preflightFailed: [409, { error: 'PREFLIGHT_FAILED', message: 'placeholder' }],
  variantRequired: [400, { error: 'VARIANT_REQUIRED', message: 'placeholder' }],
});
// Everything else the path answers: from its write step (which can run twice in one request), after the order
// was written, or with nothing but the status to go by.
const NOT_PROVABLY_BEFORE = Object.freeze({
  // The database was busy. Retry-After is the backend's own header.
  busy: [503, { error: 'TEMPORARY_UNAVAILABLE', message: 'Temporary database busy. Please retry shortly.' }, { 'Retry-After': '1' }],
  quoteConsumed: [409, { error: 'QUOTE_CONSUMED', message: 'Quote already consumed', details: { order_id: 'ord_placeholder' } }],
  quoteExpired: [409, { error: 'QUOTE_EXPIRED', message: 'Quote expired', details: null }],
  quoteMismatch: [409, { error: 'QUOTE_MISMATCH', message: 'placeholder', debug_id: 'placeholder' }],
  // Out of stock, as this path says it: a 400 whose detail names no code.
  insufficientInventory: [400, { message: 'Insufficient inventory', items: [] }],
  merchantNotAccepting: [403, { error: 'MERCHANT_NOT_ACCEPTING_ORDERS', message: 'placeholder' }],
  checkoutQuoteRequired: [400, { error: 'CHECKOUT_QUOTE_REQUIRED', message: 'placeholder' }],
  notAuthorized: [403, 'Not authorized for this merchant'],
  merchantNotFound: [404, 'Merchant not found'],
  validationFailed: [422, [{ loc: ['body', 'quote_id'], msg: 'Field required', type: 'missing' }]],
  internalError: [500, 'Order creation internal error: placeholder'],
  // Answered after the order exists, by construction.
  badGatewayFromBackend: [502, 'Created order could not be reloaded'],
});
const scripted = (table) => Object.fromEntries(Object.entries(table).map(([name, [status, detail, headers]]) => [name, (opts = {}) => fromBackend(status, detail, { ...opts, headers })]));

const ANSWERS = Object.freeze({
  ...scripted(BEFORE_ANY_ORDER),
  ...scripted(NOT_PROVABLY_BEFORE),
  // What stands in front of the backend: a status and a page, not the backend's envelope.
  badGateway: () => ({ kind: 'reply', status: 502, body: '<html><body>502 Bad Gateway</body></html>', headers: { 'content-type': 'text/html' } }),
  gatewayTimeout: () => ({ kind: 'reply', status: 504, body: '<html><body>504 Gateway Timeout</body></html>', headers: { 'content-type': 'text/html' } }),
  platformUnavailable: () => ({ kind: 'reply', status: 503, body: 'Service Unavailable', headers: { 'content-type': 'text/plain' } }),
  // No answer at all. `landed`: the backend made the order before the answer was lost.
  timeout: ({ landed = false } = {}) => ({ kind: 'error', landed, error: { code: 'ECONNABORTED', message: 'timeout of 60000ms exceeded' } }),
  connectionLost: ({ landed = false } = {}) => ({ kind: 'error', landed, error: { code: 'ECONNRESET', message: 'socket hang up' } }),
  connectionRefused: () => ({ kind: 'error', landed: false, error: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 192.0.2.1:443' } }),
  // The order is made. `overrides` changes what the backend says it made (its total, its currency).
  created: (overrides = {}) => ({ kind: 'created', overrides }),
  // The backend holds the request: `reached` resolves when it has it, and it answers `then` after `release()`.
  held: (then) => {
    let release;
    let arrive;
    const reached = new Promise((r) => { arrive = r; });
    const opened = new Promise((r) => { release = r; });
    return { kind: 'held', then, reached, release, arrive, opened };
  },
});

/**
 * Boot the gateway app from `root` (this repo by default) and answer its backend. Sets the process env: call once
 * per process, before anything else loads the server.
 * @param {{ root?:string, port?:number, env?:Record<string,string|undefined>, keys:Awaited<ReturnType<typeof mintKeys>> }} o
 */
function bootDoor({ root = path.resolve(__dirname, '../..'), port = 5611, env = {}, keys } = {}) {
  const PORT = String(port);
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT,
    AGENT_CHECKOUT_STRICT: '1',
    AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT: '1',
    AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED: '1',
    AGENT_CHECKOUT_HOSTED_LINK_ENABLED: '1',
    AGENT_CHECKOUT_ACP_REST_ENABLED: '1',
    ACP_SIGNING_SECRET: ACP_SECRET,
    IDENTITY_ISSUERS_JSON: JSON.stringify([{ iss: ACP_BUYER_ISSUER, aud: ACP_BUYER_AUDIENCE, jwks: keys.buyerJwks, algs: ['ES256'] }]),
    PAYMENT_ISSUERS_JSON: JSON.stringify([{ iss: GRANT_ISSUER, aud: GRANT_AUDIENCE, jwks: keys.grantJwks, algs: ['ES256'] }]),
    PIVOTA_API_BASE: BACKEND_BASE,
    PIVOTA_API_KEY: 'test-token',
    PIVOTA_OPS_ADMIN_TOKEN: 'test-ops-token',
    CONFIRMATION_SECRET: 'strict-confirmation-secret-0123456789',
    PAYMENT_WEBHOOK_SECRET: 'strict-webhook-secret-0123456789',
    COMMERCE_READ_CACHE_ENABLED: '0',
  });
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'DATABASE_URL',
    'MCP_OAUTH_ENABLED', 'REAP_AGENTIC_LANE_ENABLED', 'ACP_SPT_GATEWAY_HANDOFF_ENABLED', 'ORCHESTRATED_PURCHASE_TOOL_ENABLED',
    'AGENT_CHECKOUT_MCP_ENABLE_AP2_MANDATE', 'CHECKOUT_CANCEL_UPSTREAM_ENABLED', 'PARTNER_IDENTITY_FORWARDING_ENABLED',
    'AGENT_CHECKOUT_UPSTREAM_TIMEOUT_MS', 'AGENT_CHECKOUT_PAYMENT_ISSUERS_JSON', 'PIVOTA_PAYMENT_ISSUERS_JSON',
    'PRICE_VERIFICATION_LOG']) delete process.env[k];
  for (const suffix of ['ENABLED', 'DELAY_MS', 'INTERVAL_MS']) delete process.env[`COMMERCE_MCP_HEARTBEAT_${suffix}`];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null || v === '') delete process.env[k];
    else process.env[k] = String(v);
  }

  const fromRoot = (p) => require(path.join(root, p));
  fromRoot('src/logger').level = 'silent';

  const upstream = []; // every request the backend received, in order
  const orders = []; // every order the backend made
  const orderScript = []; // the answers to the next POST /agent/v2/orders, in order; none left = the order is made
  const quotes = new Map(); // backend quote id -> { currency, totalMinor }
  const major = (minor) => (minor / 100).toFixed(2);
  let quoteSeq = 0;

  nock(BACKEND_BASE).persist()
    .post('/agent/shop/v1/invoke')
    .reply((_uri, body) => {
      const operation = body && body.operation;
      const product = (body && body.payload && body.payload.product) || {};
      upstream.push({ path: '/agent/shop/v1/invoke', body });
      if (operation === 'get_product_detail' && product.merchant_id === IDS.SELLER && [IDS.SOURCE, IDS.PRODUCT].includes(product.product_id)) {
        return [200, { status: 'success', product: {
          product_id: product.product_id, merchant_id: IDS.SELLER, title: 'Day Lotion', brand: 'Shop A', price: 18, in_stock: true,
          pivota_signature_id: IDS.PRODUCT, variants: [{ variant_id: IDS.VARIANT, sku_id: IDS.VARIANT, title: 'Default', price: 18 }],
        } }];
      }
      return [404, { detail: 'NOT_FOUND' }];
    });
  nock(BACKEND_BASE).persist()
    .post('/agent/v2/quotes/preview')
    .reply((_uri, body) => {
      upstream.push({ path: '/agent/v2/quotes/preview', body });
      const refs = body && Array.isArray(body.offer_refs) ? body.offer_refs : [];
      const shipTo = body && body.buyer_context && body.buyer_context.shipping_address;
      const country = shipTo && typeof shipTo.country === 'string' ? shipTo.country : 'none';
      if (!Object.prototype.hasOwnProperty.call(PRICED_IN, country)) return [422, { detail: { error: 'MARKET_NOT_PRICED' } }];
      const currency = PRICED_IN[country];
      const totalMinor = refs.reduce((n, ref) => n + UNIT_MINOR * Number(ref.quantity), 0);
      quoteSeq += 1;
      const quoteId = `q_backend_${String(quoteSeq).padStart(4, '0')}`;
      quotes.set(quoteId, { currency, totalMinor });
      return [200, {
        quote_id: quoteId, currency,
        pricing: { subtotal: major(totalMinor), shipping_fee: '0.00', tax: '0.00', total: major(totalMinor) },
        line_items: refs.map((ref) => ({ product_id: ref.product_id, variant_id: ref.variant_id, quantity: ref.quantity, unit_price_effective: major(UNIT_MINOR) })),
        expires_at: '2099-01-01T00:00:00Z',
      }];
    });
  // The order. One scripted answer per request; with none scripted the backend makes the order from its own quote.
  const makeOrder = (body, overrides = {}) => {
    const quote = quotes.get(body && body.quote_id) || { currency: null, totalMinor: null };
    const order = { order_id: `ord_${String(orders.length + 1).padStart(4, '0')}`, quote_id: body && body.quote_id, currency: quote.currency, total: quote.totalMinor == null ? null : major(quote.totalMinor), ...overrides };
    orders.push(order);
    return { status: 'success', order: { order_id: order.order_id, state: 'awaiting_checkout' }, total: order.total, currency: order.currency };
  };
  nock(BACKEND_BASE).persist()
    .post('/agent/v2/orders')
    .reply(function reply(_uri, body, callback) {
      upstream.push({ path: '/agent/v2/orders', body, idempotencyKeyHeader: this.req.headers['idempotency-key'] });
      const answer = (step) => {
        if (step.kind === 'created') return callback(null, [200, makeOrder(body, step.overrides)]);
        if (step.kind === 'error') {
          if (step.landed) makeOrder(body);
          return callback(Object.assign(new Error(step.error.message), { code: step.error.code }));
        }
        if (step.landed) makeOrder(body);
        return callback(null, [step.status, step.body, step.headers || {}]);
      };
      const next = orderScript.shift() || ANSWERS.created();
      if (next.kind !== 'held') return answer(next);
      next.arrive();
      next.opened.then(() => answer(next.then));
      return undefined;
    });
  // The hosted payment page for an order (the charge of a complete, and the payment link).
  nock(BACKEND_BASE).persist()
    .post('/agent/v2/payments/checkout-sessions')
    .reply((_uri, body) => {
      upstream.push({ path: '/agent/v2/payments/checkout-sessions', body });
      const id = `cs_${body && body.order_id}`;
      return [200, { status: 'success', checkout_session: { checkout_session_id: id, hosted_url: `https://pay.quote-claim.test/c/${id}` } }];
    });
  nock(BACKEND_BASE).persist()
    .post(() => true)
    .reply((uri, body) => { upstream.push({ path: uri, body }); return [404, { detail: 'NOT_FOUND' }]; });
  nock(BACKEND_BASE).persist()
    .get(() => true)
    .reply((uri) => { upstream.push({ path: uri }); return [404, { detail: 'NOT_FOUND' }]; });

  const app = fromRoot('src/server');

  // ONE request = one fresh connection to the app's own listening server, closed after the answer.
  function send(method, doorPath, payloadText, headers) {
    const payload = payloadText === undefined ? null : Buffer.from(payloadText, 'utf8');
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: Number(PORT), method, path: doorPath, agent: false,
        headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), connection: 'close', ...headers },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { parsed = null; }
          resolve({ status: res.statusCode, text, body: parsed });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(payload || undefined);
    });
  }
  async function observed(fn) {
    const before = upstream.length;
    const resp = await fn();
    return { resp, upstream: upstream.slice(before) };
  }
  /** tools/call on `/mcp`. `raw` is the response body as the door sent it, byte for byte. */
  async function call(name, args, { buyer = BUYER } = {}) {
    const { resp, upstream: sent } = await observed(() => send('POST', '/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), buyer || {}));
    const result = resp.body && resp.body.result;
    const text = result && Array.isArray(result.content) && result.content[0] ? result.content[0].text : null;
    let value = null;
    try { value = JSON.parse(text); } catch { value = null; }
    return { http: resp.status, isError: Boolean(result && result.isError), value, raw: resp.text, upstream: sent };
  }
  /** A signed ACP REST request with the buyer's credential. `key`: the Idempotency-Key header. */
  async function acp(method, subPath, bodyObj, { key } = {}) {
    const rawBody = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    const ts = String(Date.now());
    const headers = {
      signature: crypto.createHmac('sha256', ACP_SECRET).update(`${ts}.${rawBody}`).digest('hex'),
      timestamp: ts,
      'x-buyer-authorization': `Bearer ${keys.buyerToken}`,
      ...(key !== undefined ? { 'idempotency-key': key } : {}),
    };
    const { resp, upstream: sent } = await observed(() => send(method, `/acp${subPath}`, bodyObj === undefined ? undefined : rawBody, headers));
    return { http: resp.status, raw: resp.text, body: resp.body, upstream: sent };
  }
  let server = null;
  const listen = () => new Promise((resolve) => { server = app.listen(Number(PORT), '127.0.0.1', () => resolve()); });
  const close = async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    nock.cleanAll();
  };
  return { app, call, acp, listen, close, upstream, orders, orderScript, root };
}

module.exports = { IDS, PRICED_IN, UNIT_MINOR, BACKEND_BASE, BUYER, ANSWERS, BEFORE_ANY_ORDER, NOT_PROVABLY_BEFORE, backendError, address, mintKeys, bootDoor };
