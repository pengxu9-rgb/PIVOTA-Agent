'use strict';

// THE ACP REST DOOR, OVER REAL HTTP, WITH A PRICER THAT ANSWERS IN THE SELLER'S OWN CURRENCY. Used by
// tests/acp_market_currency_door.node.test.cjs, and by a private differential harness that boots it over two trees
// (`root`) and compares answers and outbound traffic.
//
// REAL: the gateway app listening on a loopback port, its ACP routes and their switches, the adapter (signature
// check, buyer token verifier, intake), the canonical executor, the kernel and its transport to the backend, and the
// delegated-token completion lane (create order, then charge).
//
// STUBBED: the BACKEND, a second loopback HTTP server that records every request it receives. It behaves as the
// real pricing engine does in the two ways this door's market rule depends on:
//   - a quote is in the currency of the SELLER (one per placeholder merchant below), whatever market the request
//     names: the market in the request changes nothing;
//   - an order needs a shipping address, from the order request or from the quote it was priced with; without one
//     it is refused (400 INVALID_BUYER_CONTEXT).
// Every name is a placeholder.

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');

// One placeholder seller per currency: the currency its store is priced in.
const SELLERS = Object.freeze({ merch_priced_usd: 'USD', merch_priced_sgd: 'SGD', merch_priced_gbp: 'GBP' });
const SELLER_OF = Object.freeze({ USD: 'merch_priced_usd', SGD: 'merch_priced_sgd', GBP: 'merch_priced_gbp' });
const UNIT_MINOR = 1800;
const ACP_SECRET = 'acp-signing-secret-0123456789abc';
const BUYER_ISSUER = 'https://buyer-idp.acp-market.test';
const BUYER_AUDIENCE = 'https://agent.acp-market.test/acp';
const DELEGATED_TOKEN = 'spt_test0000000000000000001';

/** A buyer credential and the key set that verifies it. Minted by the caller so two trees can share one. */
async function mintBuyerKeys() {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const pub = await exportJWK(publicKey);
  pub.kid = 'buyer-k1';
  pub.alg = 'ES256';
  const token = await new SignJWT({ email: 'buyer@example.test', email_verified: true })
    .setProtectedHeader({ alg: 'ES256', kid: 'buyer-k1' })
    .setIssuer(BUYER_ISSUER)
    .setAudience(BUYER_AUDIENCE)
    .setSubject('buyer-0001')
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(privateKey);
  return { jwks: { keys: [pub] }, token };
}

/**
 * Boot the gateway app from `root` (this repo by default) against the stub backend. Sets the process env: call once
 * per process, before anything else loads the server. `env` is applied last (a value of undefined removes the key),
 * so a caller can boot with the ACP door off.
 */
function bootAcpMarketDoor({ root = path.resolve(__dirname, '../..'), port, backendPort, env = {}, buyerKeys } = {}) {
  if (!Number.isInteger(port) || !Number.isInteger(backendPort)) throw new Error('bootAcpMarketDoor needs a port and a backendPort');
  const BACKEND = `http://127.0.0.1:${backendPort}`;
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT: String(port),
    AGENT_CHECKOUT_STRICT: '1',
    AGENT_CHECKOUT_ALLOW_IN_MEMORY_STRICT: '1',
    AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED: '1',
    AGENT_CHECKOUT_ACP_REST_ENABLED: '1',
    ACP_SPT_GATEWAY_HANDOFF_ENABLED: '1',
    ACP_SIGNING_SECRET: ACP_SECRET,
    IDENTITY_ISSUERS_JSON: JSON.stringify([{ iss: BUYER_ISSUER, aud: BUYER_AUDIENCE, jwks: buyerKeys.jwks, algs: ['ES256'] }]),
    PIVOTA_API_BASE: BACKEND,
    PIVOTA_API_KEY: 'test-token',
    CONFIRMATION_SECRET: 'strict-confirmation-secret-0123456789',
    PAYMENT_WEBHOOK_SECRET: 'strict-webhook-secret-0123456789',
    COMMERCE_READ_CACHE_ENABLED: '0',
  });
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'DATABASE_URL',
    'AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED', 'AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET',
    'AGENT_CHECKOUT_UCP_ESCALATION_ENABLED', 'CHECKOUT_CANCEL_UPSTREAM_ENABLED']) delete process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null || v === '') delete process.env[k];
    else process.env[k] = String(v);
  }

  // ---- the backend -----------------------------------------------------------------------------------------
  const calls = []; // every request the gateway sent the backend, in order: { path, body }
  const quotes = new Map();
  let seq = 0;
  const major = (minor) => (minor / 100).toFixed(2);
  function answer(url, body) {
    if (url.startsWith('/agent/v2/quotes/preview')) {
      const currency = SELLERS[body && body.merchant_id];
      if (!currency) return [422, { detail: { code: 'MERCHANT_NOT_CONNECTED' } }];
      const refs = Array.isArray(body.offer_refs) ? body.offer_refs : [];
      const subtotal = refs.reduce((n, ref) => n + UNIT_MINOR * Number(ref.quantity), 0);
      seq += 1;
      const quote_id = `q_${String(seq).padStart(4, '0')}`;
      quotes.set(quote_id, { currency, total: subtotal, shipping_address: (body.buyer_context && body.buyer_context.shipping_address) || null });
      return [200, {
        quote_id, currency,
        pricing: { subtotal: major(subtotal), shipping_fee: '0.00', tax: '0.00', total: major(subtotal) },
        line_items: refs.map((ref) => ({ product_id: ref.product_id, variant_id: ref.variant_id, quantity: ref.quantity, unit_price_effective: major(UNIT_MINOR) })),
        expires_at: '2099-01-01T00:00:00Z',
      }];
    }
    if (url.startsWith('/agent/v2/orders')) {
      const quote = quotes.get(body && body.quote_id);
      if (!quote) return [409, { detail: { error: 'QUOTE_NOT_FOUND' } }];
      const address = (body.buyer_context && body.buyer_context.shipping_address) || quote.shipping_address;
      if (!address) return [400, { detail: { error: 'INVALID_BUYER_CONTEXT', message: 'buyer_context.shipping_address is required for order creation' } }];
      seq += 1;
      return [200, { order: { order_id: `ord_${String(seq).padStart(4, '0')}` }, total: major(quote.total), currency: quote.currency }];
    }
    if (url.startsWith('/agent/v1/payments')) {
      seq += 1;
      return [200, { payment_id: `pay_${String(seq).padStart(4, '0')}`, payment_status: 'succeeded' }];
    }
    return [404, { detail: 'NOT_FOUND' }];
  }
  const backend = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw || 'null'); } catch { body = raw; }
      calls.push({ path: req.url, body });
      const [status, out] = answer(req.url, body || {});
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });

  const fromRoot = (p) => require(path.join(root, p));
  fromRoot('src/logger').level = 'silent';
  const app = fromRoot('src/server');

  function send(method, urlPath, payloadText, headers) {
    const payload = payloadText === undefined ? null : Buffer.from(payloadText, 'utf8');
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method, path: urlPath, agent: false,
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

  let keySeq = 0;
  /**
   * One signed ACP REST request, and what the gateway asked the backend while answering it. `key`: the
   * Idempotency-Key (a fresh one when omitted on a POST).
   */
  async function acp(method, subPath, bodyObj, { key } = {}) {
    const rawBody = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    const ts = String(Date.now());
    keySeq += 1;
    const headers = {
      signature: crypto.createHmac('sha256', ACP_SECRET).update(`${ts}.${rawBody}`).digest('hex'),
      timestamp: ts,
      'x-buyer-authorization': `Bearer ${buyerKeys.token}`,
      ...(method === 'POST' ? { 'idempotency-key': key === undefined ? `idem-acp-market-${String(keySeq).padStart(5, '0')}` : key } : {}),
    };
    const before = calls.length;
    const resp = await send(method, `/acp${subPath}`, bodyObj === undefined ? undefined : rawBody, headers);
    const sent = calls.slice(before);
    return {
      http: resp.status, raw: resp.text, body: resp.body, backend: sent,
      quotes: sent.filter((c) => c.path.startsWith('/agent/v2/quotes/preview')).map((c) => c.body),
      orders: sent.filter((c) => c.path.startsWith('/agent/v2/orders')).map((c) => c.body),
      payments: sent.filter((c) => c.path.startsWith('/agent/v1/payments')).map((c) => c.body),
    };
  }

  let server = null;
  const listen = async () => {
    await new Promise((resolve) => backend.listen(backendPort, '127.0.0.1', resolve));
    await new Promise((resolve) => { server = app.listen(port, '127.0.0.1', resolve); });
  };
  const close = async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => backend.close(resolve));
  };
  return { app, acp, calls, listen, close, root };
}

/** A complete fulfillment address in `country` (as sent: any spelling), or no address member when it is undefined. */
const addressIn = (country) => (country === undefined ? {} : {
  fulfillment_address: { name: 'Example Buyer', address_line1: '1 Example Street', city: 'Springfield', postal_code: '00000', country },
});
/** An ACP create/update body: one line from the seller priced in `sellerCurrency`, shipped to `country` (or nowhere). */
const cart = (sellerCurrency, country, quantity = 1) => ({
  merchant_id: SELLER_OF[sellerCurrency],
  items: [{ product_id: 'p-0001', variant_id: 'v-0001', quantity }],
  ...addressIn(country),
});
/** An ACP complete body paying with a delegated token, with a shipping address in `country` when one is given. */
const completion = (country) => ({ payment_data: { token: DELEGATED_TOKEN }, ...addressIn(country) });
/** The market a quote request carried to the pricing engine, or null. */
const quoteMarket = (quoteBody) => (quoteBody && quoteBody.request_context && Object.prototype.hasOwnProperty.call(quoteBody.request_context, 'country') ? quoteBody.request_context.country : null);

module.exports = { SELLERS, SELLER_OF, UNIT_MINOR, DELEGATED_TOKEN, mintBuyerKeys, bootAcpMarketDoor, addressIn, cart, completion, quoteMarket };
