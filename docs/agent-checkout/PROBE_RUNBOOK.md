# Wire-format probe — complete run procedure

Follow this top to bottom. It confirms the money-unit conventions the Safety Kernel depends on, plus the
two backend facts (per-order PSP idempotency, webhook details) needed to finish the wire-in. Total time
~10 min. Phases escalate in risk; you can stop after any phase and still send useful results.

---

## 0. Prerequisites (gather these first)

| Need | How to get it / notes |
|---|---|
| **Node 18+** | `node --version` (the script uses built-in `fetch`). |
| **`PROBE_BASE`** | The deployed gateway base URL that serves `POST /agent/shop/v1/invoke` (the same origin your web/agent clients call). No trailing `/agent/...` — just the origin, e.g. `https://agent.pivota.cc`. |
| **`PROBE_KEY`** | A credential the gateway accepts for an agent/shopping request — the same token a real client sends. |
| **Auth header** | Default is `Authorization: Bearer <PROBE_KEY>`. If the gateway authenticates with `X-API-Key` (or another header), set `PROBE_AUTH_HEADER` accordingly (see 1b). |
| **A test item** | Prefer one priced with **cents** (e.g. **$0.99**, not a round $10) so minor/major is unambiguous. If you know it, set `PROBE_PRODUCT_ID` + `PROBE_MERCHANT_ID`. |
| **Stripe access** | Dashboard access to read the charge. **Strongly prefer the backend in Stripe TEST mode** (test keys + card `4242 4242 4242 4242`). Live mode = real money + ~$0.50 minimum + you must refund. |

> If you have a **staging/test deployment** with Stripe test keys, point `PROBE_BASE` at it and do the full
> run there with zero money risk. Use prod only if there's no test path.

---

## 1. Set up the environment

### 1a. Default (Bearer auth)
```bash
export PROBE_BASE="https://<your-gateway-origin>"
export PROBE_KEY="<agent/session token>"
# optional pins (recommended): a cents-priced item
export PROBE_PRODUCT_ID="<product_id>"      # optional
export PROBE_MERCHANT_ID="<merchant_id>"    # optional
export PROBE_QUERY="<search term for a cheap item>"   # used only if you don't pin a product
export PROBE_CURRENCY="USD"
```

### 1b. If the gateway uses an API-key header instead of Bearer
```bash
export PROBE_AUTH_HEADER="X-API-Key"   # the header name your gateway expects
export PROBE_KEY="<the api key value>" # sent verbatim as that header
```

### 1c. Sanity-check WITHOUT touching the network (prints the exact requests)
```bash
node scripts/probe_wire_format.mjs --dry-run --create-order --charge
```
Confirm the printed bodies look right. No network call is made. (Your key is never printed.)

### 1d. Optional: scoped TEST-PSP bypass for Phase 3
For the unblocked Phase-3 probe on a backend with the PR #738 bypass enabled, route `create_order` to
Stripe test PSP surfaces:
```bash
export PROBE_PSP="stripe"
export PROBE_ALLOW_TEST_PSP=1
```
This adds `order.preferred_psp: "stripe"` and
`order.metadata.allow_test_psp_surfaces: true` to the `create_order` request. The backend still must have
`ALLOW_TEST_PSP_PROBE=1` and the merchant allowlisted.

---

## 2. Phase 1 — read-only (zero writes, zero charge)

```bash
node scripts/probe_wire_format.mjs
```
Runs `find_products` + `preview_quote`. **Capture from the output:**
- `Which backend serves prod?` (v2 / unknown)
- `Step2 pricing.total` value + type + classification (expected: a major-unit **decimal string** like `"0.99"`)
- the `Reference order-total … trusted = true/false` line. **If `trusted = false`**, the chosen item's
  total isn't a clean decimal — re-run pinned to a cents-priced item before trusting any verdict.

✅ Proceed only if Phase 1 returned a `quote_id` and a sane `pricing.total`.

---

## 3. Phase 2 — add create_order (a backend WRITE, still no charge)  ← the key units answer

```bash
node scripts/probe_wire_format.mjs --create-order
```
Adds `create_order`. **Capture:**
- `Step3 amounts.total` value + type + **classification** — this is the decisive one:
  - `MINOR` → matches the kernel's assumption ✅
  - `MAJOR` → the kernel's units cross-check must be flipped ⚠️ (tell me)
  - `INCONSISTENT` / `UNRELIABLE` → don't enable pay; send me the raw numbers
- `Step3 amounts.currency` — present? case? (we require it present; lowercase is fine)
- the final `VERDICT` + `What this means for our code` line.

This phase leaves an **unpaid order** on the backend (normal abandoned-cart cruft; no money moved).

---

## 4. Phase 3 — add the charge (PREFER STRIPE TEST MODE)

> Only do this once Phase 2 has a trustworthy verdict and the kernel parsing matches that verdict. As of
> the 2026-06-06 production no-charge probe, live `create_order` was `MAJOR confirmed for create_order`,
> so `submit_payment` must stay disabled until the manual canary below proves PSP forwarding and replay
> behavior. This phase moves **real money** unless the backend/PSP is in test mode.

```bash
export PROBE_ALLOW_CHARGE=1
node scripts/probe_wire_format.mjs --create-order --charge
# It prints a loud warning and waits for you to type exactly:  yes
```
The script sends `submit_payment` with `expected_amount` in **minor units** and prints
`payment_intent_id` / `checkout_session_id`. It does **not** call Stripe. **Capture:**
- `Step4 payment_status`, `confirmation_owner`, `requires_client_confirmation`
- the `payment_intent_id` / `checkout_session_id`

If `payment_status` is `requires_action` / `requires_client_confirmation`, complete the confirmation in the
returned redirect/checkout surface using the **test card `4242 4242 4242 4242`** (any future expiry, any
CVC) to drive the charge to completion.

### 4b. Stripe dashboard — the ground truth
Open Stripe → Payments → find that `payment_intent_id`. **Record:**
- **Amount charged** and **currency**.
- Confirm it equals the intended item price (e.g. **$0.99**, NOT **$99.00**, NOT **$0.0099**).

### 4c. Clean up
- **Test mode:** nothing to do.
- **Live mode:** **refund** that PaymentIntent immediately from the dashboard.

### 4d. Credential and artifact hygiene
- Before sharing any probe artifact, run a redaction scan for PSP session ids, checkout URLs, API keys,
  bearer tokens, Shopify access tokens, admin order URLs, `client_secret`, card data, emails, and
  addresses.
- If any raw smoke bundle, dashboard screenshot, or JSON artifact containing Stripe test secrets or
  Shopify credentials was shared outside the local/operator workspace, rotate those credentials before
  treating the evidence packet as green.
- Shared evidence may include deployment ids, order ids, redacted PSP ids, statuses, amount, currency,
  and verdicts. It must not include raw keys, payment action URLs, `client_secret`, or bearer/API-key
  values.

---

## 5. Two backend facts to grab while you're in there (needed for the wire-in)

1. **Per-order PSP idempotency:** does the charge to Stripe carry an idempotency key derived from the
   **order** (so a retried `submit_payment` can't create a *second* PaymentIntent for the same order)?
   Check the backend's Stripe call / the PaymentIntent's idempotency behavior on a repeat submit.
2. **Webhook:** which webhook fires on async completion, what's its **signature header + signing secret**,
   and what **field correlates** the event to the order/payment (e.g. `payment_intent.id`, `metadata.order_id`)?

---

## 6. What to send back

Paste the **full script output** of Phases 1–3 (it's already redacted — no secrets), plus:
```
Backend version            = ____
Step2 pricing.total        = ____  (type, classification)
Step3 amounts.total        = ____  (type, classification)   <-- decisive
Step3 amounts.currency     = ____  (present? case?)
Phase-2 VERDICT            = ____
Step4 payment_status       = ____   payment_intent_id = ____
Stripe charged             = ____   currency = ____   (== intended? yes/no)
Refunded (if live)         = ____
Per-order PSP idempotency? = yes / no / unsure
Webhook: event + header + correlation field = ____
Replay created extra charge? = no / yes
Refund cap enforced?       = yes / no / n/a
Canonical status synced?   = yes / no
Redaction scan passed?     = yes / no
Credential rotation needed? = no / yes, completed / yes, pending
```

---

## Abort / safety conditions
- Any step returns a non-2xx → the script prints a redacted error and **stops**; send me that error.
- `trusted = false` or verdict `UNRELIABLE` → re-run pinned to a cents-priced item before concluding.
- Never paste raw API keys, card numbers, or `client_secret` values back (the script already redacts its own output).
- Never paste raw checkout-session JSON or merchant connector credentials. Redact first, then rotate if
  anything sensitive escaped the local/operator workspace.
- If you're unsure whether the backend is in Stripe test mode, **stop before Phase 3** and confirm — Phases 1–2 already answer the core units question with zero money risk.

## Run it from CI instead (no token pasted anywhere)
Phases 1–2 (read-only + create_order, **never** a charge) can run as a GitHub Actions job that reads the
credentials from repo secrets — so nobody pastes a token into a chat or a terminal.

1. Repo → **Settings → Secrets and variables → Actions** → add two secrets:
   - `PROBE_BASE` = the gateway origin (e.g. `https://agent.pivota.cc`)
   - `PROBE_KEY` = an agent/session credential the gateway accepts (Actions auto-masks it in logs)
2. Repo → **Actions** → **Agent Checkout Wire-Format Probe** → **Run workflow**. Optional inputs:
   `run_create_order` (default on), `product_id`/`merchant_id` (pin a cents-priced item), `currency`,
   `auth_header` (set `X-API-Key` if your gateway isn't Bearer).
3. Read the **VERDICT** in the run's **Summary**; the full redacted output is the `wire-format-probe-output`
   artifact. Workflow: `.github/workflows/agent-checkout-wire-format-probe.yml`. There is no charge input
   in this workflow.

The CI job **never** charges (it never passes `--charge` / sets `PROBE_ALLOW_CHARGE`). **Phase 3 (the
charge) + the Stripe dashboard check stay manual** — run them per Phase 3 above only when Phase 2 has a
trusted verdict and the deployed kernel parsing matches that verdict.

## Manual fallback
If you'd rather run by hand (or the script can't auth in your env), `PROBE_wire_format_confirmation.md` has
the equivalent `curl` for each step + the same decision rules.
```
