'use strict';

/*
 * ucpCompletionGate.js — DARK completion-gate scaffolding (Part C of
 * docs/ucp_inchat_preview_build_2026-07-13.md; Phase 3 of the parent scope doc).
 *
 * This is INTERFACES + a FAIL-CLOSED eligibility computation ONLY. It computes whether an in-chat completion
 * WOULD be eligible; it does NOT complete anything. There is deliberately NO code path from this module to
 * `complete_checkout` — the buyer-agent client physically hard-blocks that call (a `callTool` guard throws), and
 * that hard-block STANDS regardless of anything decided here. This module never imports the client.
 *
 * It mirrors the fail-closed spirit of the backend `evaluate_tier2_charge` (strict + allowlist + kill-switch):
 * the DEFAULT (all env unset, no inputs) returns DENY, and EACH missing/failing condition independently keeps
 * it at DENY. It flips to ALLOW only when ALL of these hold simultaneously:
 *   1. flag on ....................... UCP_INCHAT_COMPLETION_ENABLED is truthy
 *   2. token-tier credential present . a real Bearer/token-exchange credential is available
 *   3. canary allowlist .............. the merchant is on UCP_INCHAT_COMPLETION_CANARY_MERCHANTS
 *   4. amount <= cap ................. 0 < amount_minor <= UCP_INCHAT_COMPLETION_AMOUNT_CAP_MINOR
 *   5. valid buyer mandate ........... a shape-valid { cart_mandate, payment_mandate } object is present
 *   6. kill-switch clear ............. UCP_INCHAT_COMPLETION_KILL_SWITCH is NOT tripped
 *
 * HARD MONEY-SAFETY BOUNDS (non-negotiable):
 *   - Even a full ALLOW decision does NOT authorize or perform payment or completion. The bottom half (payment
 *     mandate signing, delegate_payment / Shared Payment Token / Google Pay, and the actual complete_checkout)
 *     is OUT OF SCOPE and NOT wired anywhere. The mandate model here is TYPES/SHAPE only — no signing, no token
 *     issuance, no crypto.
 *   - Credentials are never accepted or logged here; the gate only takes a boolean "token credential present".
 */

const FLAG_ENV = 'UCP_INCHAT_COMPLETION_ENABLED';
const KILL_SWITCH_ENV = 'UCP_INCHAT_COMPLETION_KILL_SWITCH';
const CANARY_ALLOWLIST_ENV = 'UCP_INCHAT_COMPLETION_CANARY_MERCHANTS';
const AMOUNT_CAP_ENV = 'UCP_INCHAT_COMPLETION_AMOUNT_CAP_MINOR';

// Denial reason codes (stable strings for logging/telemetry).
const DENY_REASON = Object.freeze({
  FLAG_DISABLED: 'flag_disabled',
  KILL_SWITCH_TRIPPED: 'kill_switch_tripped',
  NO_TOKEN_CREDENTIAL: 'no_token_tier_credential',
  MERCHANT_NOT_ON_CANARY_ALLOWLIST: 'merchant_not_on_canary_allowlist',
  AMOUNT_EXCEEDS_CAP: 'amount_exceeds_cap',
  INVALID_BUYER_MANDATE: 'invalid_buyer_mandate',
});

const DECISION = Object.freeze({ ALLOW: 'ALLOW', DENY: 'DENY' });

function firstNonEmptyString(...values) {
  for (const v of values) {
    const s = String(v == null ? '' : v).trim();
    if (s) return s;
  }
  return '';
}

function isPlainObject(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

function isFlagOn(value) {
  const raw = firstNonEmptyString(value).toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** Completion flag — DEFAULT OFF. */
function isCompletionEnabled(env = process.env) {
  return isFlagOn(env && env[FLAG_ENV]);
}

/** Master kill-switch — when truthy, completion is force-denied irrespective of every other condition. */
function isKillSwitchTripped(env = process.env) {
  return isFlagOn(env && env[KILL_SWITCH_ENV]);
}

/** Parse the per-merchant CANARY allowlist (comma/space-separated merchant identifiers). Empty by default. */
function parseCanaryAllowlist(env = process.env) {
  const raw = firstNonEmptyString(env && env[CANARY_ALLOWLIST_ENV]);
  if (!raw) return [];
  return raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Amount cap in MINOR units (integer cents). DEFAULT 0 => nothing passes (fail-closed): a positive amount is
 * required, so with no cap configured every amount is denied.
 */
function amountCapMinor(env = process.env) {
  const raw = firstNonEmptyString(env && env[AMOUNT_CAP_ENV]);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// ---- Buyer-consent / mandate DATA MODEL (shape-only; NO signing, NO tokens) -----------------------------
//
// Deliberately just the interface Phase 2 will fill. A future signed AP2-style mandate would add signature +
// key material; here we validate ONLY the presence/type of the descriptive fields. Nothing here mints, signs,
// or verifies anything.
//
// CartMandate: the buyer's authorization of WHAT they are buying (immutable snapshot of item + price + total).
//   { type:'cart_mandate', merchant_id, cart_id, currency, amount_minor, line_items:[{ variant_gid, quantity,
//     price_minor }], created_at }
// PaymentMandate: the buyer's authorization to PAY up to a bound (NO payment token here — that is the gated
//   bottom half). { type:'payment_mandate', merchant_id, currency, max_amount_minor, expires_at, handler_hint }
// AuditRecord: the tamper-evident-intent trail of the consent event (shape only). { type:'buyer_consent_audit',
//   mandate_ref, decision, reasons, evaluated_at, actor }

/** Validate a CartMandate SHAPE. Returns an array of problems (empty === shape-valid). No crypto. */
function validateCartMandate(m) {
  const problems = [];
  if (!isPlainObject(m)) return ['cart_mandate_not_object'];
  if (m.type !== 'cart_mandate') problems.push('cart_mandate_bad_type');
  if (!firstNonEmptyString(m.merchant_id)) problems.push('cart_mandate_missing_merchant_id');
  if (!firstNonEmptyString(m.currency)) problems.push('cart_mandate_missing_currency');
  if (!(Number.isFinite(m.amount_minor) && m.amount_minor > 0)) problems.push('cart_mandate_bad_amount_minor');
  if (!Array.isArray(m.line_items) || m.line_items.length === 0) problems.push('cart_mandate_missing_line_items');
  return problems;
}

/** Validate a PaymentMandate SHAPE. Returns an array of problems (empty === shape-valid). No token accepted. */
function validatePaymentMandate(m) {
  const problems = [];
  if (!isPlainObject(m)) return ['payment_mandate_not_object'];
  if (m.type !== 'payment_mandate') problems.push('payment_mandate_bad_type');
  if (!firstNonEmptyString(m.merchant_id)) problems.push('payment_mandate_missing_merchant_id');
  if (!firstNonEmptyString(m.currency)) problems.push('payment_mandate_missing_currency');
  if (!(Number.isFinite(m.max_amount_minor) && m.max_amount_minor > 0)) problems.push('payment_mandate_bad_max_amount_minor');
  // HARD BOUND: a raw payment token must NOT be carried in this model. If one is present, reject the shape.
  if (m.token !== undefined || m.credential !== undefined || m.payment_token !== undefined) {
    problems.push('payment_mandate_must_not_carry_token');
  }
  return problems;
}

/**
 * Validate a BuyerMandate SHAPE: { cart_mandate, payment_mandate }. Returns { valid, problems }. Shape only.
 */
function validateBuyerMandate(mandate) {
  if (!isPlainObject(mandate)) return { valid: false, problems: ['buyer_mandate_not_object'] };
  const problems = [
    ...validateCartMandate(mandate.cart_mandate),
    ...validatePaymentMandate(mandate.payment_mandate),
  ];
  return { valid: problems.length === 0, problems };
}

/**
 * Build a buyer-consent AUDIT RECORD (shape only — for the future Phase 2 trail). NOT persisted here (no DB
 * writes), NOT signed. Pure data.
 */
function buildAuditRecord({ mandate, decision, reasons, actor } = {}) {
  return {
    type: 'buyer_consent_audit',
    mandate_ref: (isPlainObject(mandate) && isPlainObject(mandate.cart_mandate))
      ? firstNonEmptyString(mandate.cart_mandate.cart_id) || null
      : null,
    decision: decision || DECISION.DENY,
    reasons: Array.isArray(reasons) ? reasons.slice() : [],
    evaluated_at: new Date().toISOString(),
    actor: firstNonEmptyString(actor) || 'pivota_buyer_agent',
    // Explicit, always-true invariant recorded in the trail: this gate never completed or paid.
    completion_performed: false,
    payment_performed: false,
  };
}

/**
 * FAIL-CLOSED completion eligibility. Computes a decision ONLY; performs no completion/payment/network call.
 * DEFAULT (no args) => DENY with every reason. Each condition independently forces DENY.
 *
 * @param {{
 *   merchantId?: string,
 *   amountMinor?: number,               // order total in MINOR units (integer cents)
 *   currency?: string,
 *   buyerMandate?: object,              // { cart_mandate, payment_mandate } (shape-only)
 *   tokenCredentialPresent?: boolean,   // caller passes client.describeTier().has_token_tier_credential
 *   env?: object,                       // defaults to process.env
 * }} [input]
 * @returns {{ decision:'ALLOW'|'DENY', allowed:boolean, reasons:string[], checks:object, audit:object }}
 */
function evaluateCompletionEligibility(input = {}) {
  const env = isPlainObject(input.env) ? input.env : process.env;
  const reasons = [];

  const flagOn = isCompletionEnabled(env);
  if (!flagOn) reasons.push(DENY_REASON.FLAG_DISABLED);

  const killTripped = isKillSwitchTripped(env);
  if (killTripped) reasons.push(DENY_REASON.KILL_SWITCH_TRIPPED);

  const tokenPresent = input.tokenCredentialPresent === true;
  if (!tokenPresent) reasons.push(DENY_REASON.NO_TOKEN_CREDENTIAL);

  const allowlist = parseCanaryAllowlist(env);
  const merchantId = firstNonEmptyString(input.merchantId);
  const merchantAllowed = Boolean(merchantId) && allowlist.includes(merchantId);
  if (!merchantAllowed) reasons.push(DENY_REASON.MERCHANT_NOT_ON_CANARY_ALLOWLIST);

  const cap = amountCapMinor(env);
  const amount = Number(input.amountMinor);
  const amountOk = Number.isFinite(amount) && amount > 0 && cap > 0 && amount <= cap;
  if (!amountOk) reasons.push(DENY_REASON.AMOUNT_EXCEEDS_CAP);

  const mandateResult = validateBuyerMandate(input.buyerMandate);
  if (!mandateResult.valid) reasons.push(DENY_REASON.INVALID_BUYER_MANDATE);

  const decision = reasons.length === 0 ? DECISION.ALLOW : DECISION.DENY;
  const checks = {
    flag_on: flagOn,
    kill_switch_clear: !killTripped,
    token_credential_present: tokenPresent,
    merchant_on_canary_allowlist: merchantAllowed,
    amount_within_cap: amountOk,
    buyer_mandate_valid: mandateResult.valid,
  };
  const audit = buildAuditRecord({ mandate: input.buyerMandate, decision, reasons, actor: input.actor });
  return { decision, allowed: decision === DECISION.ALLOW, reasons, checks, audit };
}

module.exports = {
  evaluateCompletionEligibility,
  isCompletionEnabled,
  isKillSwitchTripped,
  parseCanaryAllowlist,
  amountCapMinor,
  validateCartMandate,
  validatePaymentMandate,
  validateBuyerMandate,
  buildAuditRecord,
  DECISION,
  DENY_REASON,
  FLAG_ENV,
  KILL_SWITCH_ENV,
  CANARY_ALLOWLIST_ENV,
  AMOUNT_CAP_ENV,
};
