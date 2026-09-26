# MCP charge canary — run procedure (the gate before prod pay)

Goal: prove the **MCP** charge path (`/mcp` `complete_checkout_session`) charges correctly **in Stripe TEST
mode** — confirming B1 (minor-unit wire), B3 (replay = no second charge), B4 (webhook → paid) — so the
operator can then flip `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=1` on prod with evidence behind it.

Canary tool: [`scripts/probe_pure_mcp_paid_canary.mjs`](../../scripts/probe_pure_mcp_paid_canary.mjs). It drives
`/mcp` initialize → tools/list → `create_checkout_session` (signed buyer JWT) → `complete_checkout_session`
(signed payment grant). No direct REST invoke.

## Prereqs (two things outside this repo)

1. **Backend test-PSP unblock** (pivota-backend / infra): set `ALLOW_TEST_PSP_PROBE=1`, **allowlist merchant**
   `merch_efbc46b4619cfbdf`, and **run Stripe processor validation** for it. Without this the live route returns
   `409 PREFERRED_PSP_UNAVAILABLE` ("configured for test, not live" / "validation has not been run").
2. **Gateway issuer config** for the canary's signed identity + payment grant (below).

## Step 1 — generate the canary keypairs (done by `gen_mcp_canary_keys.mjs`)

```bash
node scripts/gen_mcp_canary_keys.mjs
```

This writes the **private** JWKs to `tmp/canary-keys/` (gitignored — keep secret, never paste) and prints:
- the **public** issuer objects to append to the gateway's `IDENTITY_ISSUERS_JSON` and `PAYMENT_ISSUERS_JSON`
  (additive — keep the existing real OAuth issuers);
- the `export MCP_IDENTITY_* / MCP_PAYMENT_*` env block for the canary.

The keypairs are verified to sign + verify the canary's exact claim shapes (identity `{acp_session_id}`; grant
`{allowance:{max_amount,currency,merchant_id,checkout_session_id,user_ref}}`). Override iss/aud/sub/merchant via
`CANARY_IDENTITY_ISS/AUD/SUB`, `CANARY_PAYMENT_ISS/AUD`, `PROBE_MERCHANT_ID` if needed; the `aud` values must
match the gateway issuer registry.

## Step 2 — set gateway config (operator deploy)

- Append the two printed issuer objects to `IDENTITY_ISSUERS_JSON` / `PAYMENT_ISSUERS_JSON` on the gateway.
- Ensure the **payment verifier `MERCHANT_ID`** = `merch_efbc46b4619cfbdf` (the grant's `allowance.merchant_id`).
- Keep `AGENT_CHECKOUT_STRICT=1`, `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=0` (the canary uses the
  test-PSP route; the prod kill-switch stays off until this canary is green).

## Step 3 — run the canary (Stripe TEST mode)

```bash
# from gen_mcp_canary_keys.mjs output:
export MCP_IDENTITY_PRIVATE_JWK="$(cat tmp/canary-keys/identity.private.jwk.json)"
export MCP_IDENTITY_ISS='https://canary.pivota.cc/identity' MCP_IDENTITY_AUD='https://agent.pivota.cc/mcp' MCP_IDENTITY_SUB='canary-buyer-001'
export MCP_PAYMENT_PRIVATE_JWK="$(cat tmp/canary-keys/payment.private.jwk.json)"
export MCP_PAYMENT_ISS='https://canary.pivota.cc/payments' MCP_PAYMENT_AUD='https://agent.pivota.cc/mcp'

export PROBE_BASE='https://agent.pivota.cc' PROBE_KEY='<agent credential>'
export PROBE_MERCHANT_ID='merch_efbc46b4619cfbdf' PROBE_PRODUCT_ID='10064562258217' PROBE_CURRENCY='USD'
export PROBE_PSP='stripe' PROBE_ALLOW_TEST_PSP=1
export PROBE_CUSTOMER_EMAIL='<buyer email>' PROBE_SHIPPING_NAME='<name>' PROBE_SHIPPING_ADDRESS_LINE1='<addr>' \
       PROBE_SHIPPING_CITY='<city>' PROBE_SHIPPING_STATE='<st>' PROBE_SHIPPING_POSTAL_CODE='<zip>' PROBE_SHIPPING_COUNTRY='US'

# 3a. no-charge first (identity + quote only, zero money):
node scripts/probe_pure_mcp_paid_canary.mjs --json

# 3b. the TEST charge (B1):
export MCP_PAID_ALLOW_CHARGE=1 MCP_PAID_CHARGE_CONFIRM=yes MCP_PAID_PSP_MODE=test
node scripts/probe_pure_mcp_paid_canary.mjs --json --charge

# 3c. replay — same idempotency key, must NOT create a second charge (B3):
node scripts/probe_pure_mcp_paid_canary.mjs --json --charge --replay
```

## Step 4 — complete + verify the charge (B4)

```bash
STRIPE_SECRET_KEY=sk_test_... PAYMENT_INTENT_ID=pi_... node scripts/b4_complete_charge.mjs   # refuses non-test keys
ORDER_ID=ORD_... node scripts/b4_verify.mjs                                                   # status-only → expect paid
```
Open Stripe (test) → confirm the PaymentIntent **amount + currency == the locked order** (e.g. 2824 USD, not
$28.24 charged as $2824).

## Step 5 — evidence packet → validate → flip the flag

```bash
cp docs/agent-checkout/paid-canary-evidence.template.json paid-canary-evidence.json   # fill the <FILL_...> values
node scripts/validate_paid_canary_evidence.mjs --input paid-canary-evidence.json --json   # must print ok:true
```

When the validator is green AND the other "Not Green For Production Pay" gates in
[`STRICT_PROD_PLATFORM_SMOKE_EVIDENCE_20260608.md`](./STRICT_PROD_PLATFORM_SMOKE_EVIDENCE_20260608.md) are
cleared (refund cap/replay, observability export zero double-charge/bypass, PSP-native-vs-normalized webhook
decision), the operator flips on prod — low-traffic merchant first, watching charge-once:

```
AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=1
```

**Rollback (instant, no deploy):** set it back to `0` (or `AGENT_CHECKOUT_STRICT=0`).

## Safety notes
- Use Stripe **TEST** mode for the canary (`MCP_PAID_PSP_MODE=test`). Live charging requires
  `MCP_PAID_LIVE_ACK=live-charge-approved` and moves real money — do not use it for the canary.
- Private JWKs live only in `tmp/canary-keys/` (gitignored). Never commit or paste them. Rotate the canary
  issuers out of the gateway registry after go-live if they were only for the canary.
- The canary's own output is self-redacting; still run a redaction scan before sharing any artifact.
