// Server mount — the single entry point that assembles the Commerce Safety Kernel for the live
// gateway. The live src/server.js imports this dynamically on the strict checkout route:
//
//   const { createCommerceMount } = require('pivota-safety-kernel/mount'); // via ESM interop / import
//   const commerce = await createCommerceMount({ upstream, db });          // db optional → in-memory
//
//   app.post('/agent/shop/v1/invoke', express.json(), async (req, res) => {
//     if (!commerce.handles(req.body?.operation)) return next();           // non-commerce ops untouched
//     const ctx = commerce.identityFromRequest(req);                       // { user_ref, acp_session_id }
//     const out = await commerce.handle(req.body.operation, req.body.payload, ctx);
//     res.status(out.ok ? 200 : 422).json(out);
//   });
//
// Gated by AGENT_CHECKOUT_STRICT: when off, `handles()` returns false for everything so the existing
// pass-through path is fully unchanged (see docs/agent-checkout/C3-reconciliation.md).

import { SafetyKernel } from './kernel.js';
import { createInvokeHandler } from './invokeHandler.js';
import { AuditLog, CommerceMetrics } from './audit.js';
import { InMemoryKvStore } from './stores.js';
import { PostgresKvStore } from './stores/postgresKvStore.js';
import { wrapUpstream } from './upstreamAdapter.js';

// The money-path operations the kernel owns. Everything else stays on the legacy pass-through.
export const COMMERCE_OPERATIONS = new Set([
  'preview_quote', 'create_order', 'submit_payment', 'request_after_sales',
]);

/**
 * @param {{
 *   upstream: (op:string, payload:object, headers?:object) => Promise<any>,
 *   db?: { query: Function },          // present => durable Postgres stores; absent => in-memory
 *   secret?: string,                   // confirmation-token signing secret (env CONFIRMATION_SECRET)
 *   strict?: boolean,                  // override AGENT_CHECKOUT_STRICT
 *   now?: () => number,
 *   auditSink?: (entry:object) => void,// e.g. push to the gateway-governance raw-log path
 *   log?: object,
 * }} opts
 */
export function createCommerceMount(opts = {}) {
  const {
    upstream,
    db = null,
    secret = process.env.CONFIRMATION_SECRET,
    strict = process.env.AGENT_CHECKOUT_STRICT === '1',
    now = () => Date.now(),
    auditSink,
    namespacePrefix = '', // prefix every kernel store namespace (e.g. for isolated validation runs)
    // PRODUCTION must set this true: wraps `upstream` with the real-backend normalization adapter so
    // the kernel receives `locked_totals`/`merchant_of_record`/top-level `order_id` from the real
    // `pricing`/nested shapes, AND the submit_payment checkout-session shape (payment_action →
    // redirect_url/client_secret, payment_intent_id → payment_id). Default false preserves the
    // stub-shaped upstream used by tests. Pay also needs the webhook route wired to
    // kernel.onPaymentWebhook — see docs/agent-checkout/payment-flow-remodel.md.
    normalizeRealUpstream = false,
    log = console,
  } = opts;

  if (typeof upstream !== 'function') throw new Error('createCommerceMount requires an upstream() function');
  if (strict && (!secret || secret.length < 16)) {
    throw new Error('createCommerceMount requires a strong CONFIRMATION_SECRET in strict mode');
  }

  const kernelUpstream = normalizeRealUpstream ? wrapUpstream(upstream) : upstream;

  const makeStore = (namespace) =>
    db ? new PostgresKvStore({ db, namespace: `${namespacePrefix}${namespace}`, now }) : new InMemoryKvStore({ now });

  const audit = new AuditLog({ now, sink: auditSink });
  const metrics = new CommerceMetrics();

  // The kernel consumes this store factory for quote, idempotency, confirmation, order, and quote-claim
  // registries. With db present, strict checkout state is shared across gateway instances.
  // The kernel + handler use the (optionally normalized) upstream so money ops see real-backend shapes.
  // On the real-backend path (normalizeRealUpstream), require create_order to surface an amount so a
  // backend schema regression can't silently disable the units cross-check (Codex).
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: secret || 'dev-insecure-secret-please-set', log, now, storeFactory: makeStore, requireBackendAmount: normalizeRealUpstream });
  const handler = createInvokeHandler({ kernel, upstream: kernelUpstream, audit, metrics, log });

  return {
    kernel,
    handler,
    audit,
    metrics,
    strict,
    durable: Boolean(db),

    /** Does the safe path own this operation? In non-strict mode, always false (legacy untouched). */
    handles(operation) {
      return strict && COMMERCE_OPERATIONS.has(operation);
    },

    /** Resolve trusted identity from the request's verified auth context (NOT the body). */
    identityFromRequest(req) {
      const auth = req?.auth ?? req?.authInfo ?? req?.session ?? {};
      return {
        user_ref: typeof auth.user_ref === 'string' ? auth.user_ref : undefined,
        acp_session_id: auth.acp_session_id,
        agent_id: auth.agent_id,
        claims: auth.claims,
      };
    },

    handle(operation, payload, ctx) {
      return handler.handle(operation, payload, ctx);
    },

    /** Mint a confirmation token after the user acts on the quote/confirmation UI (host-only). */
    async mintConfirmation(binding, ctx) {
      return kernel.mintConfirmation(binding, ctx);
    },

    readiness() {
      return metrics.snapshot();
    },
  };
}
