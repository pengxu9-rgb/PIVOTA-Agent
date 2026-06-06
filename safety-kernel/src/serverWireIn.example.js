// REFERENCE wire-in example (NOT imported by anything; not executed in CI). Shows exactly how the live
// gateway (src/server.js) assembles the Commerce Safety Kernel: the mount behind the invoke endpoint,
// the signed payment-webhook route, and the reconciliation cron. Copy the relevant blocks into the real
// server; nothing here edits the in-flight src/server.js. Everything is gated by AGENT_CHECKOUT_STRICT,
// so with the flag OFF the existing behavior is byte-for-byte unchanged.
//
// This file was hardened after a Codex adversarial review — every CAUTION below marks a defect that a
// naive wire-in would introduce (see docs/agent-checkout/REVIEW_by_codex_of_AssembledAndWireIn.md).
//
// Prereqs (ops): apply migration 050; set AGENT_CHECKOUT_STRICT=1, CONFIRMATION_SECRET,
// PAYMENT_WEBHOOK_SECRET; provide a PSP `queryStatus` client; ensure the upstream charge carries a
// per-ORDER PSP idempotency key (see payment-flow-remodel.md P1-3 before enabling pay).

import { createCommerceMount } from './mount.js';
import { createPaymentWebhookHandler } from './webhookHandler.js';
import { reconcilePendingOrders, makeInMemoryListPending } from './reconcile.js';

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// 1) The raw upstream: how the kernel reaches the REAL Pivota backend. This is the existing forwarder
//    the node gateway already uses to call {PIVOTA_API_BASE}/agent/v1/*. The mount wraps it with the
//    normalization adapter (normalizeRealUpstream) so the kernel sees the shapes it expects.
function makeRawUpstream({ apiBase, agentKey, fetchImpl = globalThis.fetch }) {
  return async (operation, payload, headers = {}) => {
    // Map operation → the real upstream route (see docs/pivota-api-mapping.md), POST the body, return
    // the parsed JSON. (Sketch — reuse the gateway's existing routing/forwarding here.)
    const res = await fetchImpl(`${apiBase}/agent/v1/${operation}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agentKey}`, ...headers },
      body: JSON.stringify(payload),
    });
    return res.json();
  };
}

// 2) Build the mount ONCE at startup.
export function buildCommerce({ db, apiBase = process.env.PIVOTA_API_BASE, agentKey = process.env.PIVOTA_API_KEY, governanceLog } = {}) {
  const commerce = createCommerceMount({
    upstream: makeRawUpstream({ apiBase, agentKey }),
    db,                                            // pass the repo's pg pool wrapper (src/db) → durable stores
    secret: process.env.CONFIRMATION_SECRET,
    // strict defaults to AGENT_CHECKOUT_STRICT === '1'
    normalizeRealUpstream: true,                   // PRODUCTION: map real backend shapes → kernel shapes
    auditSink: (entry) => governanceLog?.write(entry), // feed the gateway-governance raw-log path
  });
  return commerce;
}

// 3) Identity: derive the TRUSTED ctx from the request's VERIFIED auth ONLY.
//
// CAUTION (Codex P1): NEVER source any identity field from the request body. user_ref AND acp_session_id
// must come from the auth/session layer (OAuth introspection / signed session), which the model/client
// cannot forge. If you fall back to req.body…acp_state.acp_session_id, an attacker chooses the ACP session
// recorded on quotes/orders and satisfies the kernel's session-linkage check with attacker-supplied state.
function deriveCtx(req) {
  const auth = req.auth ?? {};
  if (!auth.user_ref) return null; // unauthenticated → caller must 401 (see invoke handler)
  return { user_ref: auth.user_ref, acp_session_id: auth.acp_session_id };
}

// Map a kernel error code → HTTP status + a GENERIC body.
//
// CAUTION (Codex P2): do NOT return the raw kernel error code/422 for every failure. (a) It mis-signals
// auth/conflict failures; (b) it leaks order existence — an authenticated attacker can tell a missing
// order (QUOTE_NOT_FOUND) from someone else's order (STATE_LINKAGE_MISMATCH) and enumerate ids. Collapse
// both to an identical generic 404.
function httpForKernelError(code) {
  switch (code) {
    case 'USER_AUTH_REQUIRED': return { status: 401, body: { error: 'unauthenticated' } };
    case 'IDEMPOTENCY_CONFLICT': return { status: 409, body: { error: 'conflict' } };
    case 'PRICE_LOCK_MISMATCH':
    case 'AMOUNT_MISMATCH':
    case 'MOR_MISMATCH': return { status: 409, body: { error: 'conflict' } };
    // Missing order AND not-your-order MUST be indistinguishable to the client:
    case 'QUOTE_NOT_FOUND':
    case 'STATE_LINKAGE_MISMATCH': return { status: 404, body: { error: 'not_found' } };
    case 'ACTION_NOT_CONFIRMED':
    case 'CONFIRMATION_INVALID': return { status: 403, body: { error: 'forbidden' } };
    case 'MERCHANT_UNAVAILABLE': return { status: 503, body: { error: 'merchant_unavailable' } };
    default: return { status: 422, body: { error: 'unprocessable' } }; // malformed client payload
  }
}

// 4) Wire the invoke handler: route money ops through the kernel, leave everything else on the legacy path.
export function registerInvokeRoute(app, commerce) {
  // Add this BEFORE the legacy app.post('/agent/shop/v1/invoke', ...). Money ops respond here; everything
  // else calls next() and falls through to the existing handler (verified safe by Codex).
  app.post('/agent/shop/v1/invoke', async (req, res, next) => {
    const { operation, payload } = req.body || {};
    if (!commerce.handles(operation)) return next(); // strict-off or non-money op → existing behavior
    const ctx = deriveCtx(req);
    if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
    const out = await commerce.handle(operation, payload, ctx);
    if (out.ok) return res.status(200).json(out);
    const mapped = httpForKernelError(out.error?.code);
    return res.status(mapped.status).json(mapped.body); // generic body — no internal codes, no existence oracle
  });
}

// CONFIRMATION TOKEN — host-only, human-action gated. NOT a model-reachable route.
//
// CAUTION (Codex P0 / INV-3): do NOT expose mintConfirmation as a generic authenticated POST that takes an
// order_id. The confirmation token exists to prove the *human* acted on the confirmation card — if any
// authenticated caller (including the agent itself, running in the user's session) can mint it from just an
// order_id, the model self-authorizes its own charge and INV-3 is defeated. mintConfirmation MUST be invoked
// only by the trusted HOST/UI layer, AFTER the user clicks "confirm" on the rendered quote card, behind:
//   • route auth bound to the same session, NOT reachable by the model/tool surface;
//   • a one-time, server-issued UI challenge (CSRF / same-origin) tied to that specific card render;
//   • a check that the order is still in a confirmable state.
// FOLLOW-UP (kernel): the order record binds user_ref but not acp_session_id, so same-user cross-session
// minting is still possible — persist + enforce acp_session_id on the order before relying on this in prod.
export async function mintConfirmationForVerifiedUiAction({ commerce, order_id, ctx }) {
  // ctx MUST come from deriveCtx (verified auth), and the caller MUST have already verified the one-time
  // UI challenge for THIS order's card render. The kernel additionally enforces order ownership.
  return commerce.mintConfirmation({ order_id }, ctx);
}

// 5) Wire the payment-webhook route. The signature is over the RAW request bytes.
//
// CAUTION (Codex P1): a global express.json() (or any body parser matching this path) consumes the stream
// BEFORE you can read it, so req.rawBody is empty and EVERY legitimate PSP webhook fails signature
// verification → orders stuck charge_pending. And if someone "fixes" that by re-serializing req.body, the
// signature no longer matches the PSP's raw bytes. Correct pattern: register this route BEFORE any global
// JSON parser, with a route-scoped raw parser that preserves the exact Buffer.
export function registerWebhookRoute(app, commerce, { rawParser, parseEvent } = {}) {
  const onWebhook = createPaymentWebhookHandler({
    kernel: commerce.kernel,
    secret: process.env.PAYMENT_WEBHOOK_SECRET,
    parseEvent, // optional PSP-specific parser; defaults to a Stripe-like nested data.object parser
  });
  // e.g. rawParser = express.raw({ type: '*/*' }) — registered on THIS exact path, before any app.use(express.json()).
  app.post('/agent/shop/v1/payment-webhook', rawParser, async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : req.rawBody; // the exact bytes the PSP signed
    const out = await onWebhook({ headers: req.headers, rawBody });
    res.status(out.status).json(out.body);
  });
}

// 6) Schedule the reconciliation sweeper (resolves stuck charge_pending orders). Use a cron / interval.
//    queryStatus MUST return the AUTHORITATIVE terminal status, or null if still processing.
export function startReconcileCron({ commerce, db, pspClient, intervalMs = 5 * 60 * 1000 }) {
  const listPending = db ? makePostgresListPending(db) : makeInMemoryListPending(commerce.kernel._orderStore);
  return setInterval(() => {
    reconcilePendingOrders({
      kernel: commerce.kernel,
      listPending,
      // CAUTION (Codex P1): never call the PSP with a null id. The kernel writes charge_pending with
      // payment_id=null BEFORE the charge response; reconcile.js now HOLDS BACK such rows ('no_payment_id'),
      // but keep this guard too — getStatus(null) must never be issued. Resolving these needs an
      // authoritative ORDER-level lookup (per-order PSP idempotency/attempt ref), not a by-id query.
      queryStatus: (order) => (order.payment_id ? pspClient.getStatus(order.payment_id) : null),
    }).catch(() => { /* logged inside; never throw from the cron */ });
  }, intervalMs);
}

// Postgres-backed pending discovery (the production listPending). GUARDED numeric cast so one malformed
// JSONB charge_pending_at value can't abort the whole sweep (Codex P2) — a bad row yields NULL → the
// sweeper holds it back as 'no_timestamp' instead of stalling every pending order.
function makePostgresListPending(db) {
  return async () => {
    const { rows } = await db.query(
      `SELECT k AS order_id,
              v->>'payment_id' AS payment_id,
              CASE WHEN jsonb_typeof(v->'charge_pending_at') = 'number'
                   THEN (v->>'charge_pending_at')::numeric END AS charge_pending_at
       FROM commerce_kv WHERE ns = 'orders' AND v->>'status' = 'charge_pending'`, [],
    );
    return rows.map((r) => ({ order_id: r.order_id, payment_id: r.payment_id, charge_pending_at: r.charge_pending_at != null ? Number(r.charge_pending_at) : undefined }));
  };
}
