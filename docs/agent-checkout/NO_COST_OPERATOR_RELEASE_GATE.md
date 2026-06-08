# No-Cost Operator Release Gate

This replaces paid GitHub Actions as the backend checkout-payment-safety release proof. It does not
replace the manual Stripe test-mode paid canary, webhook/status proof, refund cap/replay proof, or
observability export gate. Production `submit_payment` stays disabled until those later gates pass.

## Rule

Use a clean temporary backend worktree pinned to the backend release SHA. Do not use the dirty local
`pivota-backend` checkout as production evidence.

## Backend Local Gate

From `/Users/pengchydan/dev/pivota-backend`:

```bash
export BACKEND_RELEASE_SHA="$(git rev-parse origin/main)"
export GATE_DIR="/private/tmp/pivota-backend-release-gate-$BACKEND_RELEASE_SHA"
git worktree add --detach "$GATE_DIR" "$BACKEND_RELEASE_SHA"
cd "$GATE_DIR"

test "$(git rev-parse HEAD)" = "$BACKEND_RELEASE_SHA"
test -z "$(git status --porcelain)"

python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt -r requirements-dev.txt

export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"
export PYTHONDONTWRITEBYTECODE=1
export PYTEST_ADDOPTS="-p no:cacheprovider"

EXPECTED_REPO_NAME=pivota-backend \
ALLOWED_BRANCH_REGEX="^main$" \
GITHUB_REF_NAME=main \
GITHUB_EVENT_NAME=workflow_dispatch \
bash scripts/verify_release_source.sh
```

Run the exact checkout-payment-safety lane:

```bash
pytest -q \
  tests/test_agent_external_platform_checkout.py \
  tests/test_order_routes_platform_checkout_fallback.py \
  tests/test_agent_payment_sdk_existing_surface.py \
  tests/test_agent_confirm_payment_contract.py \
  tests/test_order_payment_verification.py \
  tests/test_payment_execution_routes.py \
  tests/test_order_routes_psp_resolution.py \
  tests/test_psp_payment_finalizer.py \
  tests/test_stripe_webhook_contract.py \
  tests/test_adyen_webhook_contract.py \
  tests/test_checkout_webhook_contract.py \
  tests/test_stripe_payment_element_runtime.py \
  tests/test_stripe_idempotency_keys.py \
  tests/test_merchant_payment_initiation_service.py \
  tests/test_multi_psp_orchestrator_preferred_subset.py
```

Run the aftercare gate:

```bash
PIVOTA_BACKEND_REPO="$PWD" bash scripts/run_payment_aftercare_gate.sh
```

## Gateway Local Gate

From a clean PIVOTA-Agent worktree pinned to the gateway release SHA:

```bash
node .github/scripts/check-agent-checkout-rollout-gates.mjs

cd safety-kernel && node --test
cd ../mcp-server && node --test
cd ../connectors && node --test test/connector.test.js
cd ..

node --test \
  tests/find_products_search_route_entry.node.test.cjs \
  tests/integration/safety_kernel_mount.node.test.cjs

AURORA_BFF_USE_MOCK=true \
API_MODE=REAL \
PIVOTA_API_BASE=http://pivota.test \
PIVOTA_API_KEY=test-token \
npx jest --watchman=false --runInBand --runTestsByPath \
  tests/shopping_agent_strict_find_products_multi.test.js \
  tests/integration/invoke.find_products_multi_strict_surface.test.js \
  tests/celestial_commerce_gateway_invocation_contracts.test.js \
  tests/celestial_commerce_gateway_ingress_invocation.test.js \
  tests/celestial_commerce_gateway_boundary.test.js \
  tests/agent_checkout_audit_export_assert_script.test.js \
  tests/b4_verify_script.test.js \
  tests/operator_release_evidence_script.test.js \
  tests/paid_canary_evidence_script.test.js \
  tests/platform_smoke_evidence_script.test.js \
  tests/remote_mcp_smoke_script.test.js \
  tests/strict_checkout_canary_script.test.js
```

## Evidence Packet

Create a JSON packet and validate it locally:

```bash
node scripts/validate_operator_release_evidence.mjs --input operator-release-evidence.json --json
```

Minimum evidence shape:

```json
{
  "operator": {
    "approver": "ops-redacted"
  },
  "production_pay_authorized": false,
  "environment": {
    "gateway_full_sha": "2bea62395fff745514c4effa8e4faf998179f327",
    "gateway_deployment_id": "d893f24a-5041-4c14-a96e-a305352f8a7f",
    "backend_full_sha": "694e883c50b523502b6cb0f36c353bd5b17a0bda",
    "backend_deployment_id": "backend-deploy-redacted"
  },
  "production_flags": {
    "AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED": "0",
    "AGENT_CHECKOUT_ALLOW_TEST_IDENTITY": "0",
    "AGENT_CHECKOUT_TEST_IDENTITY_WINDOW": "0"
  },
  "backend_gate": {
    "clean_worktree": true,
    "release_source_sha": "694e883c50b523502b6cb0f36c353bd5b17a0bda",
    "commands": [
      "pytest -q tests/test_agent_external_platform_checkout.py ... tests/test_multi_psp_orchestrator_preferred_subset.py",
      "PIVOTA_BACKEND_REPO=\"$PWD\" bash scripts/run_payment_aftercare_gate.sh"
    ],
    "checkout_payment_safety": {
      "passed": true,
      "pass_count": 147
    },
    "payment_aftercare": {
      "passed": true,
      "pass_count": 76
    }
  },
  "gateway_gate": {
    "clean_worktree": true,
    "release_source_sha": "2bea62395fff745514c4effa8e4faf998179f327",
    "rollout_guard_passed": true,
    "money_path_local_passed": true
  },
  "github_actions": {
    "used_as_release_gate": false,
    "billing_blocked": true,
    "blocked_run_id": "27122065333"
  },
  "no_money_ops": {
    "submit_payment_enabled": false,
    "paid_charge_attempted": false
  },
  "redaction": {
    "scan_passed": true
  },
  "credential_hygiene": {
    "rotation_needed": false
  }
}
```

The validator rejects raw API keys, bearer tokens, PSP client secrets, JWTs, email addresses, and
PAN-like card numbers. Keep dashboard references redacted in shared evidence.

## What This Unlocks

When this operator gate passes, the release candidate may proceed to the manual Stripe test-mode paid
canary. It is still not production-paid ready.

The paid canary must still prove:

- locked quote amount and PSP dashboard amount/currency match;
- same idempotency key creates zero extra PSP charges;
- signed webhook is observed and status-only `scripts/b4_verify.mjs` reaches paid;
- refund cap and refund replay are green;
- gateway-governance raw logs show redacted quote/order/payment/refund events and zero double-charge,
  price-lock, and confirmation-bypass signals.
