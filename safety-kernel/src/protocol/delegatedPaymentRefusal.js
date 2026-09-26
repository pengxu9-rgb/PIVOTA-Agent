// THE single source of truth for Pivota's refusal of DELEGATED PAYMENT VAULTING — ACP
// `POST /agentic_commerce/delegate_payment`, canonical op `exchange_payment_token`, UCP `payment.token_exchange`.
//
// WHY THIS IS PERMANENT, NOT "NOT YET" (ACP 2026-04-17 / OpenAI Delegated Payment Spec):
// `delegate_payment` receives RAW CARDHOLDER DATA — the FPAN in `payment_method.card_number_type`/`number` plus
// the `cvc` — and vaults it. The spec scopes that endpoint to a PSP or a PCI-DSS **Level 1** merchant operating
// its own vault. Pivota is a commerce index / protocol edge: never the payment vault, never the merchant of
// record (see the `provider` block of /.well-known/ucp), and must never enter cardholder-data scope. No flag,
// no enrollment and no future release changes that, so the refusal is a permanent architectural fact and is
// stated as one. The endpoint belongs to the MERCHANT'S PSP.
//
// WHAT THE CALLER SHOULD DO INSTEAD: the supported delegated-payment rail is Stripe SharedPaymentToken — the
// platform vaults the buyer's card with Stripe, the MERCHANT'S OWN Stripe account receives the `spt_`, and the
// charge runs on the merchant's key. Pivota never vaults, stores or relays cardholder data on that path either.
// Payment authorization reaches Pivota only INLINE at the complete door (`payment_data`), never via a
// Pivota-hosted vault/exchange endpoint.
//
// THE BODY IS RADIOACTIVE. Every consumer of this module refuses on the ROUTE ALONE: no body parse, no
// signature verification (the HMAC is computed over the raw bytes — reading them to authenticate would be
// reading cardholder data), no echo of any request field, no logging. That property is what makes it safe for
// this refusal to answer unconditionally, and it is asserted by test.

/** Stable, specific reason code. Replaces the old, wrong `token_exchange_verified_at_complete`. */
export const DELEGATED_PAYMENT_REFUSAL_REASON = 'delegated_payment_vaulting_not_supported';

/**
 * Structured refusal detail. Facts about PIVOTA and the protocol only — it is a constant, so it can never
 * carry a byte of the request that triggered it.
 */
export const DELEGATED_PAYMENT_REFUSAL_DETAIL = Object.freeze({
  reason: DELEGATED_PAYMENT_REFUSAL_REASON,
  // Not a kill-switch, not a rollout stage: this door never opens.
  permanent: true,
  role: 'commerce_index_passthrough',
  merchant_of_record: false,
  payment_vault: false,
  pci_dss_level_1: false,
  cardholder_data_scope: false,
  // Whose endpoint this actually is, per the spec.
  endpoint_owner: 'merchant_psp',
  // The supported delegated-payment rail, and who receives the token on it.
  delegated_payment_rail: 'stripe_shared_payment_token',
  delegated_payment_rail_recipient: 'merchant_stripe_account',
  // Where a payment authorization is presented to Pivota instead (inline, never exchanged here).
  present_authorization_at: 'POST /checkout_sessions/{checkout_session_id}/complete',
  present_authorization_field: 'payment_data',
});

/** Curated, caller-facing message. Says what is refused, why permanently, and what to do instead. */
export const DELEGATED_PAYMENT_REFUSAL_MESSAGE = [
  'Pivota does not implement delegated payment vaulting, and never will.',
  'Pivota is a commerce index / protocol edge — never the payment vault and never the merchant of record — so it',
  'stays outside cardholder-data scope by design. POST /agentic_commerce/delegate_payment receives raw cardholder',
  "data and belongs to the merchant's PSP (the spec scopes it to a PSP or a PCI-DSS Level 1 merchant running its",
  'own vault).',
  'The supported delegated-payment rail is Stripe SharedPaymentToken: the platform vaults the card with Stripe,',
  "the merchant's own Stripe account receives the shared payment token, and the charge runs on the merchant's key.",
  'Pivota never vaults, stores or relays cardholder data.',
  'A payment authorization is presented to Pivota inline as `payment_data` on',
  'POST /checkout_sessions/{checkout_session_id}/complete — there is no Pivota-hosted token-exchange endpoint.',
].join(' ');

/**
 * HTTP status for the ACP door. 501 Not Implemented is the honest answer for a capability this server does not
 * implement and will not implement — deliberately NOT 4xx (the caller's request is not malformed; there is
 * nothing to fix in it) and deliberately NOT 503 (nothing is temporarily down, so nothing should be retried).
 */
export const DELEGATED_PAYMENT_REFUSAL_HTTP_STATUS = 501;

/**
 * The ACP error envelope for this refusal. Shape matches every other error this adapter emits
 * (`{ type, code, message }`, see acpRestAdapter's guard()) so ACP clients parse it with the code path they
 * already have; `code` stays the contract-stable `OPERATION_NOT_ALLOWED`, and the specific, actionable fact
 * lives in `message` + the additive `detail`.
 *
 * Returns a FRESHLY BUILT object each call so a caller mutating the response can never corrupt the constant.
 */
export function delegatedPaymentRefusalAcpResponse() {
  return {
    status: DELEGATED_PAYMENT_REFUSAL_HTTP_STATUS,
    body: {
      type: 'error',
      code: 'OPERATION_NOT_ALLOWED',
      message: DELEGATED_PAYMENT_REFUSAL_MESSAGE,
      detail: { ...DELEGATED_PAYMENT_REFUSAL_DETAIL },
    },
  };
}

/**
 * Detail payload for the kernel-side PivotaCommerceError. `message` is included so the curated text becomes the
 * error's `.message` (PivotaCommerceError does `detail.message || catalog.userMessage`) and therefore reaches
 * the /invoke error body, which surfaces `error.message`.
 */
export function delegatedPaymentRefusalDetail(op) {
  return { op, ...DELEGATED_PAYMENT_REFUSAL_DETAIL, message: DELEGATED_PAYMENT_REFUSAL_MESSAGE };
}
