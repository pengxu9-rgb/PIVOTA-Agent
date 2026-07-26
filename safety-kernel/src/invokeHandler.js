// Wave 1.5 — Kernel↔adapter integration: mount the Safety Kernel BEHIND the canonical
// `POST /agent/shop/v1/invoke` path. This is the piece that turns the kernel's enforcement
// from "a library that exists" into "the request actually flows through it".
//
// Wiring (the live src/server.js dispatch should call this for the agent-commerce surface;
// see docs/agent-checkout/C3-reconciliation.md — we do NOT edit the WIP server.js here):
//
//   import { createInvokeHandler } from 'pivota-safety-kernel/invokeHandler';
//   const handler = createInvokeHandler({ kernel, upstream });   // kernel = new SafetyKernel(...)
//   app.post('/agent/shop/v1/invoke', async (req, res) => {
//     const ctx = await deriveCtx(req);                          // { user_ref, acp_session_id } from OAuth (X2)
//     const out = await handler.handle(req.body.operation, req.body.payload, ctx);
//     res.status(out.ok ? 200 : 422).json(out);
//   });

import { SafetyKernel, PivotaCommerceError, classifyPaymentStatus, IDEMPOTENT_REPLAY_MARKER } from './kernel.js';
import { validateCanonical, WRITE_OPERATIONS } from './contractValidation.js';
import { redact } from './redact.js';

// Codex P3-2: after-sales IS a kernel money-path op (routes through kernel.requestAfterSales).
const KERNEL_MONEY_OPS = new Set(['preview_quote', 'create_order', 'submit_payment', 'request_after_sales']);

// Codex P0-2: the default route must NOT forward arbitrary unknown operations. Only these
// explicitly-known READ/discovery ops pass straight through; anything else (incl. legacy money ops
// like confirm_payment) is REFUSED so it cannot bypass the kernel's quote/amount/confirmation checks.
const PASSTHROUGH_READ_OPS = new Set([
  'find_products', 'find_products_multi', 'get_discovery_feed', 'get_product_entity_index_feed',
  'get_product_detail', 'get_pdp', 'get_pdp_v2', 'offers.resolve', 'resolve_product_candidates',
  'resolve_product_group', 'find_similar_products', 'products.recommendations', 'track_product_click',
  'get_order_status',
]);

// C6 + Codex P2-5: map every blocked money-path error code to (audit event, metric) so NO blocked
// attempt disappears from the audit trail.
export const ERROR_OBSERVABILITY = Object.freeze({
  PRICE_CHANGED: { event: 'price_changed_blocked', metric: 'price_lock_violation' },
  CONFIRMATION_REQUIRED: { event: 'confirmation_blocked', metric: 'confirmation_bypass' },
  CONFIRMATION_INVALID: { event: 'confirmation_blocked', metric: 'confirmation_bypass' },
  QUOTE_REQUIRED: { event: 'quote_violation_blocked', metric: 'quote_violation' },
  QUOTE_NOT_FOUND: { event: 'quote_violation_blocked', metric: 'quote_violation' },
  QUOTE_EXPIRED: { event: 'quote_violation_blocked', metric: 'quote_violation' },
  STATE_LINKAGE_MISMATCH: { event: 'linkage_blocked', metric: 'linkage_violation' },
  USER_AUTH_REQUIRED: { event: 'user_auth_blocked', metric: 'user_auth_required' },
  OPERATION_NOT_ALLOWED: { event: 'operation_blocked', metric: 'operation_not_allowed' },
  MERCHANT_UNAVAILABLE: { event: 'merchant_unavailable', metric: 'merchant_unavailable' },
  // Separate metric on purpose: this one is a catalog-coverage signal (ids advertised with nothing behind
  // them), not an availability signal. Folding it into merchant_unavailable is what hid the dead ids.
  NO_MERCHANT_OFFER: { event: 'no_merchant_offer', metric: 'no_merchant_offer' },
  IDEMPOTENCY_CONFLICT: { event: 'idempotency_conflict_blocked', metric: 'idempotency_conflict' },
});

/**
 * @param {{ kernel: SafetyKernel, upstream: (op:string, payload:object, headers?:object)=>Promise<any>,
 *           log?: {info:Function,warn:Function,error:Function}, afterSalesSupported?: Set<string>,
 *           audit?: import('./audit.js').AuditLog, metrics?: import('./audit.js').CommerceMetrics }} deps
 */
export function createInvokeHandler({ kernel, upstream, log = console, afterSalesSupported, audit, metrics }) {
  if (!(kernel instanceof SafetyKernel)) throw new Error('createInvokeHandler requires a SafetyKernel');
  if (typeof upstream !== 'function') throw new Error('createInvokeHandler requires an upstream() function');

  const emit = (event, ctx) => { try { audit?.record(event, ctx); } catch { /* audit must never break the flow */ } };
  const count = (name, by = 1) => { try { metrics?.inc(name, by); } catch { /* metrics non-fatal */ } };
  const emitReplay = (operation, payload, result, ctx) => {
    if (!result?.[IDEMPOTENT_REPLAY_MARKER]) return false;
    count('idempotent_replay');
    emit('idempotent_replay', {
      user_ref: ctx.user_ref,
      order_id: result.order_id || payload?.payment?.order_id || payload?.status?.order_id,
      quote_id: result.quote_id || payload?.order?.quote_id,
      idempotency_key: payload?.idempotency_key,
      currency: result.currency,
      operation,
    });
    return true;
  };

  /**
   * @param {string} operation
   * @param {object} payload  canonical payload (acp_state/ap2_state opaque)
   * @param {{user_ref?:string, acp_session_id?:string}} ctx  identity from the auth layer (X2)
   * @returns {Promise<{ok:true, data:any} | {ok:false, error:object}>}
   */
  async function handle(operation, payload, ctx = {}) {
    try {
      // 1) Strict canonical validation for money/identity-sensitive ops (C3). Reads pass through.
      validateCanonical(operation, payload, { afterSalesSupported });

      // 2) Route. Money-path ops go THROUGH the kernel (enforces INV-1..INV-5). Everything else
      //    is forwarded to upstream unchanged, preserving the existing discovery/status contract.
      switch (operation) {
        case 'preview_quote': {
          const q = await kernel.previewQuote(payload, ctx);
          count('quote_issued');
          emit('quote_issued', { user_ref: ctx.user_ref, quote_id: q.quote_id, currency: q.currency, operation });
          return ok(q);
        }
        case 'create_order': {
          const o = await kernel.createOrder(payload, ctx);
          if (emitReplay(operation, payload, o, ctx)) return ok(o);
          count('order_created');
          emit('order_created', { user_ref: ctx.user_ref, order_id: o.order_id, currency: o.currency, idempotency_key: payload?.idempotency_key, operation });
          return ok(o);
        }
        case 'submit_payment': {
          const pr = await kernel.submitPayment(payload, ctx);
          if (emitReplay(operation, payload, pr, ctx)) return ok(pr);
          const order_id = payload?.payment?.order_id;
          // Codex P2: audit by the SAME classification the kernel state machine uses (not exact-string),
          // so 'processing'/'pending' aren't mis-audited as failed and 'paid'/'captured' aren't missed.
          const cls = classifyPaymentStatus(pr.payment_status);
          const ev = cls === 'success' ? 'payment_succeeded' : cls === 'failure' ? 'payment_failed' : 'payment_requires_action';
          count(ev);
          emit(ev, { user_ref: ctx.user_ref, order_id, idempotency_key: payload?.idempotency_key, operation });
          return ok(pr);
        }
        case 'request_after_sales': {
          // Kernel-side now (Codex P1-4 closed): idempotent, ownership-enforced, action-gated.
          const r = await kernel.requestAfterSales(payload, ctx, afterSalesSupported ? { supportedActions: afterSalesSupported } : {});
          if (emitReplay(operation, payload, r, ctx)) return ok(r);
          count('after_sales_requested');
          emit('after_sales_requested', { user_ref: ctx.user_ref, order_id: payload?.status?.order_id, operation });
          return ok(r);
        }
        default:
          // Codex P0-2: fail closed. Only known read/discovery ops pass through; an unknown or
          // legacy-mutating op (e.g. confirm_payment) must NOT silently reach upstream and bypass
          // the kernel. It is refused so it cannot move money outside the safe path.
          if (!PASSTHROUGH_READ_OPS.has(operation)) {
            throw new PivotaCommerceError('OPERATION_NOT_ALLOWED', { reason: 'operation_not_routable_in_safe_path', operation });
          }
          return ok(await upstream(operation, payload));
      }
    } catch (err) {
      if (err instanceof PivotaCommerceError) {
        log.warn?.(redact({ operation, code: err.code, detail: err.detail || undefined }), 'commerce_error');
        // C6: blocked money-path attempts are first-class observability signals.
        const obs = ERROR_OBSERVABILITY[err.code];
        if (obs) {
          count(obs.metric);
          emit(obs.event, {
            user_ref: ctx.user_ref,
            order_id: payload?.payment?.order_id,
            operation,
            detail: redact({ code: err.code, ...(err.detail || {}) }),
          });
        }
        if (err.code === 'IDEMPOTENCY_CONFLICT') count('idempotency_conflict');
        const result = err.toResult();
        if (ctx?.diagnostics === true) {
          result.error.details = redact(err.detail || {});
        }
        return result;
      }
      // Never leak internals or sensitive payload to the caller/logs.
      log.error?.('invoke_unexpected_error', redact({ operation, message: err?.message }));
      return { ok: false, error: { code: 'INTERNAL', retriable: true, message: 'An unexpected error occurred.' } };
    }
  }

  return { handle, KERNEL_MONEY_OPS, WRITE_OPERATIONS };
}

function ok(data) {
  return { ok: true, data };
}
