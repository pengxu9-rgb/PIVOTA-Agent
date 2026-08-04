// Production composition root — the ONE place the protocol edge meets the real backend, real JWKS, and real
// per-buyer identity. It wires the injected seams every adapter expects into a running ACP REST adapter (and,
// when an MCP-surface factory is injected, the MCP commerce surface) over a single kernel/executor, reusing
// the existing production primitives:
//
//   merchant backend   : createHttpBackendUpstream → POST {base}/agent/shop/v1/invoke (the probed contract)
//   money normalization: wrapUpstream  (major-decimal → minor-int, nested order_id, payment_action → redirect…)
//   payment authz       : createPaymentAuthorizationVerifier + createSignedGrantVerifier / createAp2MandateVerifier
//   per-buyer identity   : createUserTokenVerifier (jose, pinned JWKS) → user_ref
//
// Lives in safety-kernel (which owns jose + the kernel/executor/adapters/verifiers). The MCP commerce surface
// is in mcp-server (jose-free by design), so it is INJECTED via `createMcpSurface(executor)` rather than
// imported here — that keeps safety-kernel self-contained and never importing mcp-server.
//
// FAIL-CLOSED CONFIG (the whole point): in strict mode (AGENT_CHECKOUT_STRICT=1) every security-critical seam
// is REQUIRED at boot — no insecure default silently ships. A misconfigured money path must not start.

import { SafetyKernel } from '../kernel.js';
import { InMemoryKvStore } from '../stores.js';
import { wrapUpstream } from '../upstreamAdapter.js';
import { PivotaCommerceError } from '../errors.js';
import { createCanonicalExecutor } from './canonicalExecutor.js';

// Read-only ops — the lanes where a bare 404 means "no such product" rather than a missing backend route.
// Mirrors the read() calls in canonicalExecutor.js and COMMERCE_KERNEL_READ_OPS in
// src/services/commerceKernelErrorMapping.js (where it moved out of src/server.js).
const BACKEND_READ_OPS = new Set(['get_product_detail', 'find_products', 'find_products_multi']);
import { createPaymentAuthorizationVerifier } from './paymentAuthorizationVerifier.js';
import { createSignedGrantVerifier, createAp2MandateVerifier } from './protocolPaymentVerifiers.js';
import { createAcpRestAdapter } from './acpRestAdapter.js';
import { createAcpRouteHandlers } from './acpRestRoutes.js';
import { buildUcpProfile, createUcpRouteHandlers } from './ucpProfile.js';
import { createUserTokenVerifier } from '../identity/userTokenVerifier.js';
import { createPaymentWebhookHandler } from '../webhookHandler.js';
import { reconcilePendingOrders } from '../reconcile.js';
import { createStripeWebhookHandler, createAdyenWebhookHandler } from '../pspWebhooks.js';

const INVOKE_PATH = '/agent/shop/v1/invoke';
const MIN_SECRET_LEN = 16;
const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';

export class WiringConfigError extends Error {
  constructor(message) { super(message); this.name = 'WiringConfigError'; }
}

/**
 * Build a kernel-upstream over the real merchant backend. POSTs the probed operation-invoke contract:
 * `POST {baseUrl}/agent/shop/v1/invoke` with `{ operation, payload }` and a Bearer token; forwards the
 * kernel's Idempotency-Key. Returns the RAW backend body (the kernel-upstream wrap normalizes money shapes;
 * read ops pass through). Never logs the auth token.
 * @param {{ baseUrl:string, authToken:string, fetchImpl?:Function, invokePath?:string, timeoutMs?:number }} cfg
 */
export function createHttpBackendUpstream(cfg = {}) {
  const { baseUrl, authToken, fetchImpl = globalThis.fetch, invokePath = INVOKE_PATH, timeoutMs = 20000, allowInsecureHttp = false } = cfg;
  if (!nonEmpty(baseUrl)) throw new WiringConfigError('backend upstream requires baseUrl');
  if (!nonEmpty(authToken)) throw new WiringConfigError('backend upstream requires authToken');
  if (typeof fetchImpl !== 'function') throw new WiringConfigError('no fetch implementation (Node 18+ or pass fetchImpl)');
  // URL-parse the base (Codex P1): reject a malformed/credential/fragment URL and enforce https so the merchant
  // Bearer token + money-path responses are never sent over plaintext. allowInsecureHttp permits http ONLY for a
  // LOOPBACK host (localhost/127.0.0.1/::1) — never an arbitrary remote http host (Codex round-2: that would
  // ship the token plaintext to a real merchant). It is also forbidden in strict mode (enforced by the caller).
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new WiringConfigError(`backend baseUrl is not a valid URL`); }
  if (parsed.protocol !== 'https:') {
    const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
    if (!(allowInsecureHttp && parsed.protocol === 'http:' && loopback)) {
      throw new WiringConfigError('backend baseUrl must be https (allowInsecureHttp permits http only for a loopback host)');
    }
  }
  if (parsed.username || parsed.password || parsed.hash) throw new WiringConfigError('backend baseUrl must not contain credentials or a fragment');
  // Build deliberately from origin + the path segments (base pathname prefix + invokePath), dropping any query.
  const basePath = parsed.pathname.replace(/\/+$/, '');
  const url = `${parsed.origin}${basePath}${invokePath}`;

  return async function backendUpstream(operation, payload, headers = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: /^Bearer\s+/i.test(authToken) ? authToken : `Bearer ${authToken}`,
          // forward the kernel's idempotency key so the backend dedupes too
          ...(nonEmpty(headers['Idempotency-Key']) ? { 'idempotency-key': headers['Idempotency-Key'] } : {}),
        },
        body: JSON.stringify({ operation, payload }),
        signal: ac.signal,
      });
    } catch (e) {
      // network/timeout — surface as the retriable kernel error (so adapters map it to merchant-unavailable,
      // not a generic 500), never a silent fallback. The cause name is non-sensitive.
      throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'backend_unreachable', cause: String(e?.name || 'error') });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // 404 on a READ op = the backend positively answered "nothing here" (e.g. PRODUCT_NOT_FOUND). That is
      // persistent and must not be advertised as a retriable outage. Restricted to reads because this same
      // upstream carries preview_quote / create_order / submit_payment, where a 404 is far more likely to be a
      // missing or mid-deploy route than a statement about the product — calling that NO_MERCHANT_OFFER would
      // tell a checkout agent not to retry a transient blip. Kept in step with
      // throwCommerceKernelUpstreamError in src/server.js.
      //
      // DELIBERATELY NOT MIRRORED HERE: the UNKNOWN_PRODUCT_ID arm that throwCommerceKernelUpstreamError
      // grew for the `MISSING_MERCHANT_CONTEXT` / HTTP 400 lane. That arm keys on the upstream error CODE,
      // and this function throws before it parses the response body, so it cannot see one. Widening it to a
      // bare 400 would be wrong: a 400 on a read op is just as likely a malformed request from our own
      // caller. It also cannot arise on this path — that code comes from the gateway's own get_pdp_v2, which
      // only the src/server.js wiring calls. The two stay in step on the 404 lane, which is the only lane
      // both can observe.
      if (res.status === 404 && BACKEND_READ_OPS.has(String(operation || '').trim())) {
        throw new PivotaCommerceError('NO_MERCHANT_OFFER', { reason: 'backend_not_found', status: res.status });
      }
      throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'backend_http_error', status: res.status });
    }
    let body;
    try { body = await res.json(); } catch { body = null; }
    return body; // empty/non-JSON 200 → null → wrapUpstream/kernel validation fails closed (not a valid quote)
  };
}

/**
 * The composition root.
 * @param {{
 *   merchantId: string,                       // merchant-of-record this deployment serves (payment grants must match)
 *   confirmationSecret?: string,              // kernel confirmation-token secret (env CONFIRMATION_SECRET)
 *   backend?: { baseUrl, authToken, fetchImpl?, invokePath?, timeoutMs? } | ((op,payload,headers)=>Promise),
 *   paymentIssuers: Array<object>,            // issuer registry for grant/mandate JWS (pinned JWKS, asymmetric algs)
 *   enableAp2?: boolean,                       // turn on ap2_mandate (requires verifyCheckoutHash)
 *   verifyCheckoutHash?: Function,            // AP2 TCB: prove checkout_hash vs merchant Checkout JWT → { checkout_session_id }
 *   expectedVct?: string,                     // AP2 mandate vct
 *   identityIssuers: Array<object>,           // issuer registry for the per-buyer identity token (jose)
 *   identityMaxTokenAge?: string|number,
 *   acpSigningSecret?: string,                // ACP request-signing shared secret (env ACP_SIGNING_SECRET)
 *   acpPublicFeed?: boolean,
 *   paymentWebhookSecret?: string,            // PSP webhook HMAC secret (env PAYMENT_WEBHOOK_SECRET); REQUIRED in
 *                                             //   strict unless syncChargesOnly — async charges finalize via webhook
 *   webhookSignatureHeader?: string,          // default 'x-pivota-webhook-signature'
 *   stripeWebhookSecret?: string,             // Stripe endpoint signing secret (whsec_…) → wired.stripeWebhook
 *   stripeMapEvent?: (event)=>object,         // override: Stripe event → { order_id, payment_id, status }
 *   adyenHmacKey?: string,                    // Adyen HMAC key (hex) → wired.adyenWebhook
 *   adyenBasicAuth?: {username,password},     // Adyen endpoint Basic Auth (in addition to the per-item HMAC)
 *   adyenMapItem?: (item)=>object,            // override: Adyen NotificationRequestItem → { order_id, payment_id, status }
 *   parsePaymentEvent?: (json)=>object,       // (normalized webhook) PSP event → {order_id,payment_id,status}. order_id MUST
 *                                             //   be the KERNEL order id (from create_order), NOT an ACP session /
 *                                             //   PSP-checkout-session id — else the webhook 404s and never finalizes.
 *   syncChargesOnly?: boolean,                // explicit audited opt-out (must be === true): the PSP only ever
 *                                             //   returns synchronous 'succeeded' (no requires_action) → no webhook
 *   listPendingOrders?: ()=>Promise<Array>,   // reconcile backstop: list charge_pending orders (store-specific)
 *   queryPaymentStatus?: (order)=>Promise<string|null|{status,payment_id?}>,  // AUTHORITATIVE PSP status (scalar
 *                                             //   status string, or {status, payment_id?}; reconcile never charges)
 *   reconcileMaxAgeMs?: number,
 *   extractBuyerToken?: (req) => string|undefined,  // how the per-buyer credential arrives on an ACP request
 *   getProducts?: (query) => Promise<Array>,  // ACP feed source (default: backend find_products)
 *   acpBasePath?: string,                     // route prefix for returned acpRoutes (default '')
 *   ucpBaseUrl?: string,                      // when set, build returned ucpProfile/ucpRoutes
 *   ucpRestBasePath?: string,
 *   ucpMcpEndpoint?: string,
 *   ucpPaymentHandlers?: Array<object>,
 *   ucpSigningKeys?: Array<object>,
 *   ucpCapabilities?: string[],
 *   ucpVersion?: string,
 *   sessionStore?: object,                    // durable KV (durable===true, get/set/putIfAbsent); REQUIRED durable in strict
 *   storeFactory?: (ns:string)=>object,       // kernel durable store seam; REQUIRED durable in strict
 *   allowEphemeralState?: boolean,            // explicit audited opt-out of durable-state requirement (single-instance/dev)
 *   createMcpSurface?: (executor) => object,  // inject mcp-server's createCommerceToolSurface to also build the MCP door
 *   strict?: boolean,                         // default AGENT_CHECKOUT_STRICT==='1'; when true ALL seams required
 *   log?: object, now?: ()=>number,           // now is for deterministic TESTS only — forbidden in strict
 * }} config
 */
export function composeProductionCommerce(config = {}) {
  const strict = config.strict ?? (process.env.AGENT_CHECKOUT_STRICT === '1');
  const log = config.log || console;
  const now = config.now || (() => Date.now());
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(msg); };

  // --- merchant / secrets ---
  if (!nonEmpty(config.merchantId)) errs.push('merchantId is required');
  const confirmationSecret = config.confirmationSecret ?? process.env.CONFIRMATION_SECRET;
  need(nonEmpty(confirmationSecret) && confirmationSecret.length >= MIN_SECRET_LEN, `confirmationSecret (>=${MIN_SECRET_LEN} chars) is required`);
  const acpSigningSecret = config.acpSigningSecret ?? process.env.ACP_SIGNING_SECRET;

  // --- backend upstream ---
  let backendUpstream;
  if (typeof config.backend === 'function') {
    backendUpstream = config.backend;
  } else if (config.backend && typeof config.backend === 'object') {
    backendUpstream = createHttpBackendUpstream(config.backend);
  } else if (strict) {
    errs.push('backend (a function or { baseUrl, authToken }) is required in strict mode');
  }

  // --- payment authz (a charge cannot be authorized without a real verifier) ---
  need(Array.isArray(config.paymentIssuers) && config.paymentIssuers.length > 0, 'paymentIssuers (pinned-JWKS issuer registry) is required');
  if (config.enableAp2 && typeof config.verifyCheckoutHash !== 'function') {
    errs.push('enableAp2 requires verifyCheckoutHash (the AP2 checkout-binding TCB function)');
  }

  // --- per-buyer identity ---
  need(Array.isArray(config.identityIssuers) && config.identityIssuers.length > 0, 'identityIssuers (per-buyer token issuer registry) is required');

  // --- ACP transport: a strong signing secret (Codex P1: a short/weak one is brute-forceable offline,
  //     letting an attacker forge platform-authenticated ACP requests). Require >= MIN_SECRET_LEN in strict. ---
  if (strict) need(nonEmpty(acpSigningSecret) && acpSigningSecret.length >= MIN_SECRET_LEN, `acpSigningSecret (>=${MIN_SECRET_LEN} chars) is required in strict mode`);

  // --- payment webhook: the live backend is a checkout-session / client-confirmation model — submitPayment
  //     can return charge_pending + requires_action, and completion arrives via a SIGNED webhook. Without it,
  //     paid orders never finalize (stuck charge_pending). Require a strong webhook secret in strict, unless the
  //     operator EXPLICITLY asserts the PSP only ever returns synchronous 'succeeded' (syncChargesOnly). ---
  const paymentWebhookSecret = config.paymentWebhookSecret ?? process.env.PAYMENT_WEBHOOK_SECRET;
  // Codex P0: the opt-out must be an EXACT boolean true — a truthy value (e.g. the string "false" from env
  // parsing) must NOT silently disable the webhook requirement and strand async charges.
  const syncChargesOnly = config.syncChargesOnly === true;
  // Codex P2: strict needs AT LEAST ONE async-completion path — the normalized webhook OR a PSP-native one
  // (Stripe/Adyen). A Stripe-native deployment must not be forced to also set the normalized secret.
  const hasCompletionPath = (nonEmpty(paymentWebhookSecret) && paymentWebhookSecret.length >= MIN_SECRET_LEN)
    || nonEmpty(config.stripeWebhookSecret) || nonEmpty(config.adyenHmacKey);
  if (strict && !syncChargesOnly) {
    need(hasCompletionPath, `an async-completion path is required in strict mode — paymentWebhookSecret (>=${MIN_SECRET_LEN} chars), stripeWebhookSecret, or adyenHmacKey (or set syncChargesOnly:true for an audited synchronous-only PSP)`);
  }

  // --- durable state (Codex P0): a strict multi-instance deploy MUST NOT run on per-process in-memory state —
  //     quote/order/idempotency/confirmation/charge-lock + ACP session state would not be shared, breaking
  //     charge-once/idempotency across instances. Require DURABLE stores — verified by the `durable` MARKER, not
  //     just shape (an InMemoryKvStore also has putIfAbsent; only a real backend like PostgresKvStore is marked
  //     durable). Unless the operator EXPLICITLY opts into ephemeral state (single-instance/dev). ---
  if (strict && !config.allowEphemeralState) {
    const factoryDurable = typeof config.storeFactory === 'function' && isDurable(safeProbe(config.storeFactory));
    need(factoryDurable, 'a DURABLE storeFactory is required in strict mode (an in-memory store is rejected; or set allowEphemeralState for an audited single-instance/dev run)');
    need(isDurable(config.sessionStore), 'a DURABLE sessionStore (durable===true, get/set/putIfAbsent) is required in strict mode (an in-memory store is rejected; or set allowEphemeralState)');
  }
  // http to the backend is forbidden in strict regardless of allowInsecureHttp (Codex round-2: it would ship
  // the merchant Bearer token plaintext to a real host).
  if (strict && config.backend && typeof config.backend === 'object' && config.backend.allowInsecureHttp) {
    errs.push('allowInsecureHttp is forbidden in strict mode (backend must be https)');
  }

  // --- clock (Codex P2): a custom `now` diverges from jose's wall-clock signature/exp checks, breaking the
  //     "one binding clock" contract. It exists only for deterministic tests — forbid it in strict (prod uses
  //     Date.now() for the kernel/binding AND jose, so they always agree). ---
  if (strict && typeof config.now === 'function') errs.push('a custom now() is not allowed in strict mode (it would diverge from jose wall-clock verification)');

  if (errs.length) throw new WiringConfigError(`production wiring misconfigured (fail-closed):\n- ${errs.join('\n- ')}`);

  // ---- build (constructors below throw on bad issuer/JWKS/alg config → fail closed at boot) ----------------

  // Money path: wrap the raw backend so the kernel sees normalized minor-unit shapes; requireBackendAmount on
  // the real path (a missing backend amount disables the units cross-check → must fail closed).
  const kernelUpstream = backendUpstream ? wrapUpstream(backendUpstream) : (async () => { throw err('MERCHANT_UNAVAILABLE', 'no backend configured'); });
  const kernel = new SafetyKernel({
    upstream: kernelUpstream, secret: confirmationSecret, log, now,
    storeFactory: config.storeFactory || null,
    requireBackendAmount: Boolean(backendUpstream),
  });

  // Reads (discovery) go straight to the backend (no money normalization).
  const merchantRead = backendUpstream
    ? (op, payload) => backendUpstream(op, payload)
    : (async () => { throw err('MERCHANT_UNAVAILABLE', 'no backend configured'); });

  // Payment-authorization verifier: signed-grant for ACP delegated tokens + UCP handlers; AP2 mandate optional.
  const grantVerifier = createSignedGrantVerifier({ issuers: config.paymentIssuers });
  const methods = { acp_delegated_token: grantVerifier, ucp_handler: grantVerifier };
  if (config.enableAp2) {
    methods.ap2_mandate = createAp2MandateVerifier({ issuers: config.paymentIssuers, verifyCheckoutHash: config.verifyCheckoutHash, expectedVct: config.expectedVct });
  }
  const verifyPaymentAuthorization = createPaymentAuthorizationVerifier({ merchantId: config.merchantId, methods, now });

  const executor = createCanonicalExecutor({ kernel, upstream: merchantRead, verifyPaymentAuthorization });

  // Per-buyer identity: verify a credential → user_ref. Used by BOTH doors (never trust a model/body identity).
  const verifyUserToken = createUserTokenVerifier({ issuers: config.identityIssuers, maxTokenAge: config.identityMaxTokenAge });

  // ACP: extract the buyer credential from the request (deployment-specific transport), verify, → user_ref.
  const extractBuyerToken = typeof config.extractBuyerToken === 'function'
    ? config.extractBuyerToken
    : (req) => bearerFrom(req?.headers?.['x-buyer-authorization'] ?? req?.headers?.['X-Buyer-Authorization']);
  const resolveUserRef = async (req) => {
    const token = extractBuyerToken(req);
    if (!nonEmpty(token)) return undefined; // adapter fails closed (USER_AUTH_REQUIRED) for a user-scoped op
    try {
      // Return the buyer-identity OBJECT, not the bare user_ref: the ACP door needs the ATTESTED email so a
      // caller-asserted `buyer.email` can never override it. user_ref derivation is untouched (iss|sub).
      const { user_ref, attested_email, attested_name } = await verifyUserToken(token);
      return { user_ref, customer_email: attested_email, customer_name: attested_name };
    } catch (e) { log.warn?.('acp_buyer_token_invalid', { code: e?.code }); return undefined; }
  };

  // MCP: identity from the server-verified session context (the OAuth/session layer attaches claims/user_ref).
  const resolveSessionIdentity = (extra) => {
    const auth = extra?.authInfo ?? extra?.sessionContext ?? {};
    const out = {};
    if (nonEmpty(auth.user_ref)) out.user_ref = auth.user_ref;
    else if (auth.claims && typeof auth.claims === 'object') out.claims = auth.claims;
    if (nonEmpty(auth.acp_session_id)) out.acp_session_id = auth.acp_session_id;
    if (nonEmpty(auth.agent_id)) out.agent_id = auth.agent_id;
    return out;
  };

  // Product feed source for the ACP adapter (discovery via the backend).
  const getProducts = typeof config.getProducts === 'function'
    ? config.getProducts
    : async (query) => {
        const raw = await merchantRead('find_products', query || {});
        return Array.isArray(raw?.products) ? raw.products : (Array.isArray(raw) ? raw : []);
      };

  const sessionStore = config.sessionStore || new InMemoryKvStore({ now });
  if (strict && !config.sessionStore) log.warn?.('acp_session_store_in_memory', { note: 'use a durable store in production (multi-instance safety)' });

  const acp = nonEmpty(acpSigningSecret)
    ? createAcpRestAdapter({ executor, sessionStore, signingSecret: acpSigningSecret, resolveUserRef, getProducts, publicFeed: Boolean(config.acpPublicFeed), now })
    : null;
  const acpRoutes = acp ? createAcpRouteHandlers(acp, { basePath: config.acpBasePath || '' }) : null;

  // The MCP door is built only if the surface factory is injected (mcp-server is jose-free; it can't be
  // imported here without pulling jose into it).
  const mcp = typeof config.createMcpSurface === 'function' ? config.createMcpSurface(executor) : null;

  const ucpProfile = nonEmpty(config.ucpBaseUrl)
    ? buildUcpProfile({
        baseUrl: config.ucpBaseUrl,
        restBasePath: config.ucpRestBasePath || config.acpBasePath || '/ucp',
        mcpEndpoint: config.ucpMcpEndpoint,
        paymentHandlers: config.ucpPaymentHandlers,
        signingKeys: config.ucpSigningKeys,
        capabilities: config.ucpCapabilities,
        ucpVersion: config.ucpVersion,
      })
    : null;
  const ucpRoutes = ucpProfile ? createUcpRouteHandlers(ucpProfile) : null;

  // Payment webhook — bound to THIS kernel (shares the durable order store), so an async charge's completion
  // event finalizes charge_pending → paid here. Signature is verified over the raw body BEFORE parse. Mount it
  // on a route with a raw-body parser: `app.post(path, rawBodyParser, (req,res) => paymentWebhook(req).then(...))`.
  const paymentWebhook = nonEmpty(paymentWebhookSecret)
    ? createPaymentWebhookHandler({ kernel, secret: paymentWebhookSecret, signatureHeader: config.webhookSignatureHeader, parseEvent: config.parsePaymentEvent, log })
    : null;

  // PSP-native webhooks — ingest RAW Stripe/Adyen webhooks (their signature schemes differ from the normalized
  // one above). Bound to THIS kernel. Built only when the PSP's secret/key is configured. Mount each on a
  // raw-body route. (syncChargesOnly's strict requirement is satisfied by ANY completion path; if you use a
  // PSP-native webhook instead of the normalized one, set syncChargesOnly only when truly synchronous.)
  const stripeWebhook = nonEmpty(config.stripeWebhookSecret)
    ? createStripeWebhookHandler({ kernel, secret: config.stripeWebhookSecret, mapEvent: config.stripeMapEvent, now, log })
    : null;
  const adyenWebhook = nonEmpty(config.adyenHmacKey)
    ? createAdyenWebhookHandler({ kernel, hmacKey: config.adyenHmacKey, basicAuth: config.adyenBasicAuth, mapItem: config.adyenMapItem, log })
    : null;

  // Reconcile backstop — one-shot sweep of charge_pending orders against the AUTHORITATIVE PSP status (never
  // charges). Built only when both store-listing and an authoritative status query are supplied; run it on a
  // cron. Strongly recommended alongside the webhook for async charges.
  //
  // Codex P0: adapt queryPaymentStatus to reconcile's `queryStatus` contract, which consumes a SCALAR status
  // (string|null). queryPaymentStatus MAY return a scalar OR `{status, payment_id}`; we extract the scalar and,
  // when the PSP returns a payment_id, REQUIRE it to match the pending row's attempt (else return null → held
  // back) so a stale/foreign attempt can't resolve the order.
  const queryStatusAdapter = typeof config.queryPaymentStatus === 'function'
    ? async (order) => {
        const r = await config.queryPaymentStatus(order);
        if (r == null) return null;
        if (typeof r === 'string') return r;
        if (typeof r !== 'object') return null;
        // If the PSP ASSERTS an attempt id (the key is present, ANY type), it MUST be a non-empty string that
        // exactly matches the pending row's attempt — otherwise hold back (null). A present-but-non-string id
        // (e.g. 123 or {id:…}) must NOT skip the match and let a foreign/stale attempt resolve the order
        // (Codex round-2). reconcile already drops rows with no order.payment_id before this runs.
        if (Object.prototype.hasOwnProperty.call(r, 'payment_id')) {
          if (typeof r.payment_id !== 'string' || r.payment_id !== order.payment_id) return null;
        }
        return nonEmpty(r.status) ? r.status : null;
      }
    : null;
  const reconcile = (typeof config.listPendingOrders === 'function' && queryStatusAdapter)
    ? () => reconcilePendingOrders({ kernel, listPending: config.listPendingOrders, queryStatus: queryStatusAdapter, maxAgeMs: config.reconcileMaxAgeMs, now, log })
    : null;
  if (strict && !syncChargesOnly && !reconcile) {
    log.warn?.('reconcile_not_wired', { note: 'no reconcile sweeper (listPendingOrders + queryPaymentStatus) — webhook is the only completion path; a missed webhook leaves orders charge_pending' });
  }

  return {
    mcp, acp, acpRoutes, ucpProfile, ucpRoutes,
    executor, kernel, paymentWebhook, stripeWebhook, adyenWebhook, reconcile,
    resolveSessionIdentity, resolveUserRef, verifyUserToken,
  };
}

function bearerFrom(h) {
  if (!nonEmpty(h)) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : h.trim();
}
function err(code, reason) { return Object.assign(new Error(reason), { code, reason }); }
// A store is durable only if it advertises the marker — shape (putIfAbsent presence) is insufficient because
// the in-memory store implements the same seam interface.
function isDurable(store) { return Boolean(store) && store.durable === true; }
// Build one throwaway store from the factory to inspect its durability marker (construction only; no I/O).
function safeProbe(storeFactory) {
  try { return storeFactory('__durability_probe__'); } catch { return undefined; }
}
