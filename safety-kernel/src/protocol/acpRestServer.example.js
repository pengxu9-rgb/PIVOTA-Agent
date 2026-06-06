// EXAMPLE wire-in (not run by default) — mounting the ACP REST adapter on an Express-style router.
//
// The CRITICAL detail is the RAW BODY: signature verification hashes the exact bytes ACP signed, so capture
// `rawBody` BEFORE JSON parsing (express.json({ verify }) or a raw body middleware). Re-serializing the parsed
// body can change bytes (key order, whitespace) and break the signature.
//
//   const adapter = composeAcpRest({ kernelUpstream, merchantRead, verifyPaymentAuthorization,
//                                    signingSecret, resolveUserRef, getProducts, secret });
//   mountAcpRest(app, adapter);

import { SafetyKernel } from '../kernel.js';
import { InMemoryKvStore } from '../stores.js';
import { createCanonicalExecutor } from './canonicalExecutor.js';
import { createAcpRestAdapter } from './acpRestAdapter.js';

/**
 * Compose the adapter end to end. Injected seams:
 *  - kernelUpstream(op, payload): preview_quote / create_order / submit_payment (your connector/gateway).
 *  - merchantRead(op, payload): find_products / get_product_detail (executor reads — only needed if you also
 *    expose discovery tools; the ACP feed uses getProducts directly).
 *  - verifyPaymentAuthorization(authz, bound): verify the ACP delegated token / `payment_data` against the
 *    authoritative order amount/currency/buyer; MUST throw or return a matching positive attestation.
 *  - resolveUserRef(req): the VERIFIED buyer (from a buyer credential the platform presents) — never the body.
 *  - getProducts(query): product feed source.
 *  - signingSecret: the ACP request-signing shared secret.
 *  - secret: the kernel confirmation secret.
 *  - sessionStore: durable in prod (Postgres/Redis KV); InMemory by default here.
 */
export function composeAcpRest({ kernelUpstream, merchantRead, verifyPaymentAuthorization, resolveUserRef, getProducts, mapFeedItem, signingSecret, secret, sessionStore, log = console }) {
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret, log });
  const executor = createCanonicalExecutor({ kernel, upstream: merchantRead, verifyPaymentAuthorization });
  return createAcpRestAdapter({
    executor,
    sessionStore: sessionStore || new InMemoryKvStore({}),
    signingSecret, resolveUserRef, getProducts, mapFeedItem,
  });
}

/** Mount on an Express app. Requires raw-body capture for signature verification (see note above). */
export function mountAcpRest(app, adapter) {
  // express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }) must be installed.
  const norm = (req) => ({ headers: req.headers, rawBody: req.rawBody, body: req.body, params: req.params });
  const send = (res, out) => res.status(out.status).json(out.body);

  app.post('/checkout_sessions', async (req, res) => send(res, await adapter.createCheckoutSession(norm(req))));
  app.post('/checkout_sessions/:checkout_session_id/complete', async (req, res) => send(res, await adapter.completeCheckoutSession(norm(req))));
  app.post('/checkout_sessions/:checkout_session_id/cancel', async (req, res) => send(res, await adapter.cancelCheckoutSession(norm(req))));
  app.post('/checkout_sessions/:checkout_session_id', async (req, res) => send(res, await adapter.updateCheckoutSession(norm(req))));
  app.get('/checkout_sessions/:checkout_session_id', async (req, res) => send(res, await adapter.getCheckoutSession(norm(req))));
  app.get('/feed', async (req, res) => send(res, await adapter.productFeed(norm(req))));
}
