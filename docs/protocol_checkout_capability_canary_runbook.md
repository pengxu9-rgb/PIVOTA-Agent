# Runbook — Protocol-checkout capability-gate canary (Fix Plan A, option (ii))

**Goal:** prove ONE live protocol-lane transaction for a real, non-PSP, non-demo
merchant — first on staging, then prod — using the capability-based gate, and roll
back cleanly. Everything ships dark; this runbook is the ordered flip sequence.

**Cross-repo change this runbook exercises:**
- PIVOTA-Agent (Node gateway): serving/discovery gate + `AGENT_CHECKOUT_CAPABILITY_GATE`
  serving flag. Helper: `src/services/merchantTransactionCapabilitySql.js`.
- pivota-backend (Python): order-create PSP bypass + same-named flag. Gate:
  `services/merchant_capability_gate.py`; wired at
  `routes/order_routes.py::_resolve_active_order_psp`.

> ⚠️ **SECRET-ORDERING HAZARD (read first).** `safety-kernel/src/protocol/productionWiring.js`
> **THROWS at boot** if a required secret is missing while strict mode is on
> (`:161` confirmationSecret, `:185` acpSigningSecret, `:199` async-completion path).
> **Set ALL secrets in group C BELOW BEFORE you set `AGENT_CHECKOUT_STRICT=1`** in any
> environment, or the server fails closed (crash-loop). Never flip strict first.

---

## 0. Preconditions

- A real pilot merchant id (NOT `merch_efbc46b4619cfbdf` / `merch_bbd34645bc1950cc` —
  those are the same demo store duplicated; not proof of anything).
- The pilot merchant is protocol/checkout-capable (verified integration) but has NO
  `merchant_psps` row (that is the whole point).
- Staging + prod DB access via the operator (no values in this doc — names only).

---

## 1. Set secrets and door flags (staging first)

**Group C — secrets (set these FIRST):**
- `CONFIRMATION_SECRET`  (strong, ≥ min length)
- `ACP_SIGNING_SECRET`   (strong, ≥ min length)
- `PAYMENT_WEBHOOK_SECRET` (strong; OR a PSP-native `stripeWebhookSecret`/`adyenHmacKey`)
- `PAYMENT_ISSUERS_JSON` (pinned-JWKS payment-authorization issuer registry)

**Group A/B — doors (only AFTER group C is set):**
- `AGENT_CHECKOUT_STRICT=1`                       (master door)
- `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=1` (allows the charge; keep OFF in prod
  until the staging canary passes with the async-completion webhook verified)
- `AGENT_CHECKOUT_ACP_REST_ENABLED=1`            (ACP REST doors, if using ACP)
- `AGENT_CHECKOUT_UCP_DISCOVERY_ENABLED=1`       (UCP discovery, if using UCP)
- Leave `AGENT_CHECKOUT_MCP_ENABLE_AP2_MANDATE=0` (NOT wired — throws if on).

**Group E — the capability gate (BOTH repos, same name):**
- PIVOTA-Agent: `AGENT_CHECKOUT_CAPABILITY_GATE=1`  (serving/discovery admits the merchant)
- pivota-backend: `AGENT_CHECKOUT_CAPABILITY_GATE=1` (order-create bypass)
- pivota-backend canary scope (STRONGLY recommended for the first flip):
  `AGENT_CHECKOUT_CAPABILITY_GATE_MERCHANTS=<pilot_merchant_id>`
  → opens exactly ONE merchant; empty = global (do not use empty for the first flip).

All flags are documented with defaults/effects in `env.example` (Agent-checkout section).

---

## 2. Register the pilot merchant's protocol capability (dark)

The gate keys off a `pcs_merchant_capabilities` row. Populate it with the provided
dark script (dry-run by default):

```bash
# preview (no write)
python -m scripts.register_merchant_protocol_capability --merchant-id <pilot_merchant_id>

# write the row (staging)
python -m scripts.register_merchant_protocol_capability \
    --merchant-id <pilot_merchant_id> --apply \
    --shopify-api-version <api_version> --has-shopify-payments

# audit current rows
python -m scripts.register_merchant_protocol_capability --list
```

Verify:
```sql
SELECT merchant_id, has_shopify_payments, last_checked_at
FROM pcs_merchant_capabilities WHERE merchant_id = '<pilot_merchant_id>';
```

---

## 3. Probe sequence (staging)

Drive the protocol lane end-to-end. The order MUST carry the deferred/hosted-checkout
marker so the capability bypass applies (see
`routes/order_routes.py::_order_defers_payment_surface` —
`metadata.agent_v2.checkout_provider = "pivota_hosted_checkout"` or
`metadata.agent_v2.hosted_checkout = true`):

1. **preview_quote** — quote the pilot merchant's item; confirm it is now served
   (capability-gate serving change admits the non-PSP merchant).
2. **create_order** — create the order for the pilot merchant with the deferred marker.
   - Expected: order is created (no `400 "No active PSP configuration found"`), and
     lands with `psp_used = 'protocol_deferred'`. With the gate OFF this same call
     returns 400 — that is the control.
3. **submit_payment** — complete the charge through the protocol/ACP lane.
   - ⚠️ See "Remaining charge-path seam" below: the synchronous non-PSP charge is NOT
     yet wired. For the first canary, settle via the proven Tier-2 ACP capture lane
     (reuse the Shopify/Wix real-Stripe canary evidence/scripts) or the existing
     hosted-link surface — do NOT expect `create_payment_with_failover` to charge a
     merchant that has no `merchant_psps` row.

Reuse the existing strict-checkout canary shape:
`tests/strict_checkout_canary_script.test.js`.

---

## 4. Verification queries

```sql
-- The capability-gated order was created without a PSP row:
SELECT order_id, merchant_id, status, payment_status, psp_used, created_at
FROM orders
WHERE merchant_id = '<pilot_merchant_id>'
ORDER BY created_at DESC
LIMIT 5;
-- expect a fresh row with psp_used = 'protocol_deferred'

-- Confirm the merchant genuinely has no active PSP row (the whole point):
SELECT count(*) FROM merchant_psps
WHERE merchant_id = '<pilot_merchant_id>' AND status = 'active';
-- expect 0

-- Protocol-lane session receipts (ACP/UCP), if present in your env:
--   ucp_checkout_sessions is a session-state table; verify a completed row dated
--   2026-07 for the pilot. (Not defined in pivota-backend source — it is a
--   kernel/session store; confirm its presence per environment before relying on it.)
```

Acceptance: one completed protocol-lane transaction for the pilot (non-demo) merchant,
with a 2026-07 receipt and `orders.psp_used='protocol_deferred'` on the create leg.

---

## 5. Promote to prod

Only after staging acceptance AND the async-completion webhook path is verified:
1. Set group C secrets in prod (FIRST).
2. Set group A/B door flags; keep `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=0`
   until you are ready for the live charge, then flip it for the supervised canary.
3. Register the pilot `pcs_merchant_capabilities` row in prod (`--apply`).
4. Set `AGENT_CHECKOUT_CAPABILITY_GATE=1` + `AGENT_CHECKOUT_CAPABILITY_GATE_MERCHANTS=<pilot>`
   in BOTH repos.
5. Run the probe against prod with the pilot merchant, one transaction.

---

## 6. Rollback (immediate, safe)

The gate is fail-closed, so rollback is a flag flip — no deploy required:
1. `AGENT_CHECKOUT_CAPABILITY_GATE=0` in BOTH repos → serving reverts to
   byte-identical `psp_connected=true`, and order-create reverts to the exact 400.
2. (Optional) `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=0` to re-close the charge.
3. Leaving the `pcs_merchant_capabilities` row in place is harmless while the flag is
   off (the flag is the switch, not the row). Remove it only if you want a clean slate.

---

## Remaining charge-path seam (mapped, NOT yet wired)

The order-CREATE bypass is complete and safe. A fully synchronous non-PSP charge is
deliberately NOT wired — it is entangled with settlement and is out of safe scope for
this dark change. Precise seams a follow-up must address:

- `adapters/multi_psp_orchestrator.py:183-184` — `if not self.psp_configs: return
  False, ... "No PSP configured for merchant"`. A capability-gated charge would need a
  protocol-lane branch here (or upstream) that settles WITHOUT `merchant_psps`.
- `adapters/multi_psp_orchestrator.py:273-281` — the `enforce_live_readiness` per-PSP
  skip; a non-PSP protocol charge has no `merchant_psps.validation_status` to satisfy.
- `routes/order_routes.py` charge call at `~:4291` (`create_payment_with_failover`,
  `canonical_psp_required=True`) — only reached on the NON-deferred path; a synchronous
  capability-gated charge would route through here and hit the two blocks above.

For the canary, settle the deferred order via the proven Tier-2 ACP capture lane
(`services/tier2_acp_lane.py` + `services/agent_checkout_kill_switch.py`) or the
hosted-link surface, both of which already exist and were proven on real Stripe
(Shopify + Wix) per project history.
