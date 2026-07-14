'use strict';

/*
 * Money-safety tests for the DARK completion gate (src/services/ucpCompletionGate.js) — Part C of
 * docs/ucp_inchat_preview_build_2026-07-13.md.
 *
 * Two halves:
 *   (a) DEFENSE-IN-DEPTH: even with BOTH flags on and a FULLY-satisfied gate (token creds + allowlisted
 *       merchant + amount<=cap + valid mandate + kill-switch clear) that returns ALLOW, `complete_checkout`
 *       STILL throws at the buyer-agent client. A gate ALLOW enables NO completion code path.
 *   (b) FAIL-CLOSED MATRIX: default (all env unset) = DENY; each condition independently = DENY with the right
 *       reason; ALLOW only when ALL hold.
 * NO live network.
 */

const {
  evaluateCompletionEligibility,
  DECISION,
  DENY_REASON,
  validateBuyerMandate,
} = require('../src/services/ucpCompletionGate');
const {
  createUcpBuyerAgentClient,
  TRUST_TIER,
} = require('../src/services/ucpBuyerAgentClient');

// A shape-valid buyer mandate (types/shape only — NO signing, NO token; a carried token would be rejected).
const VALID_MANDATE = Object.freeze({
  cart_mandate: {
    type: 'cart_mandate',
    merchant_id: 'cosrx',
    cart_id: 'cart_abc',
    currency: 'USD',
    amount_minor: 1600,
    line_items: [{ variant_gid: 'gid://shopify/ProductVariant/111', quantity: 1, price_minor: 1600 }],
    created_at: '2026-07-13T00:00:00.000Z',
  },
  payment_mandate: {
    type: 'payment_mandate',
    merchant_id: 'cosrx',
    currency: 'USD',
    max_amount_minor: 2000,
    expires_at: '2026-07-13T01:00:00.000Z',
  },
});

// Env that satisfies every ENV-side condition for ALLOW (flag on, merchant allowlisted, cap set, kill clear).
const ALLOW_ENV = Object.freeze({
  UCP_INCHAT_COMPLETION_ENABLED: '1',
  UCP_INCHAT_COMPLETION_CANARY_MERCHANTS: 'cosrx',
  UCP_INCHAT_COMPLETION_AMOUNT_CAP_MINOR: '2000',
  // kill switch deliberately unset (clear)
});

// Input that satisfies every INPUT-side condition for ALLOW.
function allowInput(overrides = {}) {
  return {
    env: ALLOW_ENV,
    merchantId: 'cosrx',
    amountMinor: 1600,
    currency: 'USD',
    buyerMandate: VALID_MANDATE,
    tokenCredentialPresent: true,
    ...overrides,
  };
}

// A fetch that records every call (used to prove NO network reaches complete_checkout).
function recordingFetch() {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init });
    return { ok: true, status: 200, async text() { return '{}'; }, async json() { return {}; } };
  };
  f.calls = calls;
  return f;
}

describe('completion gate — full-ALLOW sanity', () => {
  test('with EVERY condition satisfied the gate returns ALLOW', () => {
    const res = evaluateCompletionEligibility(allowInput());
    expect(res.decision).toBe(DECISION.ALLOW);
    expect(res.allowed).toBe(true);
    expect(res.reasons).toEqual([]);
    expect(res.checks).toEqual({
      flag_on: true,
      kill_switch_clear: true,
      token_credential_present: true,
      merchant_on_canary_allowlist: true,
      amount_within_cap: true,
      buyer_mandate_valid: true,
    });
    // The audit record is shape-only and records the always-true no-completion / no-payment invariant.
    expect(res.audit.completion_performed).toBe(false);
    expect(res.audit.payment_performed).toBe(false);
  });
});

describe('DEFENSE IN DEPTH — a gate ALLOW enables NO completion path', () => {
  test('complete_checkout STILL throws at the client with both flags on + a full-ALLOW gate, and NO fetch fires', async () => {
    // Simulate production with BOTH flags flipped on AND real token credentials present.
    const env = {
      ...ALLOW_ENV,
      UCP_INCHAT_PREVIEW_ENABLED: '1',
      UCP_INCHAT_COMPLETION_ENABLED: '1',
    };
    // 1) The gate says ALLOW.
    const gate = evaluateCompletionEligibility(allowInput({ env }));
    expect(gate.decision).toBe(DECISION.ALLOW);

    // 2) A fully-credentialled TOKEN-tier client (the highest tier) still hard-blocks complete_checkout.
    const fetchImpl = recordingFetch();
    const client = createUcpBuyerAgentClient({ credential: 'real-jwt', fetchImpl });
    expect(client.tier).toBe(TRUST_TIER.TOKEN);

    // No completion method exists on the public surface.
    expect(client.completeCheckout).toBeUndefined();
    expect(client.complete_checkout).toBeUndefined();

    // Directly invoking the low-level callTool with the completion tool THROWS (the hard-block).
    await expect(
      client.callTool('https://cosrx.example.myshopify.com/ucp/mcp', 'complete_checkout', {}),
    ).rejects.toThrow(/hard-disabled/);

    // 3) The gate module itself carries no route to the client — it only computes a decision.
    const gateModule = require('../src/services/ucpCompletionGate');
    expect(gateModule.completeCheckout).toBeUndefined();
    expect(gateModule.callTool).toBeUndefined();
    expect(typeof gateModule.evaluateCompletionEligibility).toBe('function');

    // 4) Not a single network call was made anywhere in this ALLOW → refusal path.
    expect(fetchImpl.calls.length).toBe(0);
  });
});

describe('FAIL-CLOSED MATRIX', () => {
  test('DEFAULT (all env unset, no inputs) => DENY with every reason', () => {
    const res = evaluateCompletionEligibility(); // no args at all
    expect(res.decision).toBe(DECISION.DENY);
    expect(res.allowed).toBe(false);
    expect(res.reasons).toEqual(
      expect.arrayContaining([
        DENY_REASON.FLAG_DISABLED,
        DENY_REASON.NO_TOKEN_CREDENTIAL,
        DENY_REASON.MERCHANT_NOT_ON_CANARY_ALLOWLIST,
        DENY_REASON.AMOUNT_EXCEEDS_CAP,
        DENY_REASON.INVALID_BUYER_MANDATE,
      ]),
    );
  });

  // Each row flips exactly ONE condition off the full-ALLOW baseline and expects DENY + a specific reason.
  const cases = [
    {
      name: 'flag off',
      input: () => allowInput({ env: { ...ALLOW_ENV, UCP_INCHAT_COMPLETION_ENABLED: '0' } }),
      reason: DENY_REASON.FLAG_DISABLED,
    },
    {
      name: 'no token credential',
      input: () => allowInput({ tokenCredentialPresent: false }),
      reason: DENY_REASON.NO_TOKEN_CREDENTIAL,
    },
    {
      name: 'merchant not on allowlist',
      input: () => allowInput({ merchantId: 'not-a-canary-merchant' }),
      reason: DENY_REASON.MERCHANT_NOT_ON_CANARY_ALLOWLIST,
    },
    {
      name: 'amount over cap',
      input: () => allowInput({ amountMinor: 999999 }),
      reason: DENY_REASON.AMOUNT_EXCEEDS_CAP,
    },
    {
      name: 'amount == 0',
      input: () => allowInput({ amountMinor: 0 }),
      reason: DENY_REASON.AMOUNT_EXCEEDS_CAP,
    },
    {
      name: 'missing mandate',
      input: () => allowInput({ buyerMandate: undefined }),
      reason: DENY_REASON.INVALID_BUYER_MANDATE,
    },
    {
      name: 'invalid mandate (payment_mandate carries a raw token)',
      input: () => allowInput({
        buyerMandate: {
          ...VALID_MANDATE,
          payment_mandate: { ...VALID_MANDATE.payment_mandate, token: 'tok_should_be_rejected' },
        },
      }),
      reason: DENY_REASON.INVALID_BUYER_MANDATE,
    },
    {
      name: 'kill-switch tripped',
      input: () => allowInput({ env: { ...ALLOW_ENV, UCP_INCHAT_COMPLETION_KILL_SWITCH: '1' } }),
      reason: DENY_REASON.KILL_SWITCH_TRIPPED,
    },
  ];

  test.each(cases)('$name => DENY with $reason', ({ input, reason }) => {
    const res = evaluateCompletionEligibility(input());
    expect(res.decision).toBe(DECISION.DENY);
    expect(res.allowed).toBe(false);
    expect(res.reasons).toContain(reason);
  });

  test('ALLOW only when ALL conditions hold simultaneously', () => {
    expect(evaluateCompletionEligibility(allowInput()).decision).toBe(DECISION.ALLOW);
  });

  test('a carried payment token is rejected by the mandate shape validator (defense in depth)', () => {
    const withToken = {
      ...VALID_MANDATE,
      payment_mandate: { ...VALID_MANDATE.payment_mandate, payment_token: 'spt_xxx' },
    };
    const { valid, problems } = validateBuyerMandate(withToken);
    expect(valid).toBe(false);
    expect(problems).toContain('payment_mandate_must_not_carry_token');
  });
});
