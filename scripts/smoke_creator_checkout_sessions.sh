#!/usr/bin/env bash
set -euo pipefail

# Smoke test for the creator compatibility checkout-sessions endpoint.
#
# Usage:
#   BASE_URL=http://localhost:3000 \
#   AUTH_TOKEN=... \
#   bash scripts/smoke_creator_checkout_sessions.sh
#
# Optional:
#   PATHNAME=/creator-agent/checkout-sessions
#   EXPECT_MODE=ucp|legacy_token
#   CHECK_MULTI_MERCHANT=1|0

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
if [[ "${SKIP_DOTENV:-0}" != "1" && -f "${REPO_DIR}/.env" ]]; then
  set -a
  . "${REPO_DIR}/.env"
  set +a
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

BASE_URL="${BASE_URL:-http://localhost:3000}"
PATHNAME="${PATHNAME:-/creator-agent/checkout-sessions}"
AUTH_TOKEN="${AUTH_TOKEN:-${LOOK_REPLICATOR_API_KEY:-}}"
EXPECT_MODE="${EXPECT_MODE:-ucp}"
CHECK_MULTI_MERCHANT="${CHECK_MULTI_MERCHANT:-1}"

RETURN_URL="${RETURN_URL:-https://creator.pivota.cc/result/ucp-smoke}"
MARKET="${MARKET:-US}"
PRODUCT_ID="${PRODUCT_ID:-creator_ucp_smoke_prod_1}"
MERCHANT_ID="${MERCHANT_ID:-creator_ucp_smoke_merch_1}"
QTY="${QTY:-1}"

MULTI_PRODUCT_ID_1="${MULTI_PRODUCT_ID_1:-creator_multi_prod_1}"
MULTI_PRODUCT_ID_2="${MULTI_PRODUCT_ID_2:-creator_multi_prod_2}"
MULTI_MERCHANT_ID_1="${MULTI_MERCHANT_ID_1:-creator_multi_merch_1}"
MULTI_MERCHANT_ID_2="${MULTI_MERCHANT_ID_2:-creator_multi_merch_2}"

export EXPECT_MODE RETURN_URL MARKET PRODUCT_ID MERCHANT_ID QTY
export MULTI_PRODUCT_ID_1 MULTI_PRODUCT_ID_2 MULTI_MERCHANT_ID_1 MULTI_MERCHANT_ID_2

if [[ -z "${AUTH_TOKEN}" ]]; then
  echo "ERROR: set AUTH_TOKEN (or LOOK_REPLICATOR_API_KEY in the shell)" >&2
  exit 2
fi

echo "== 0) creator checkout compatibility target =="
echo "base_url=${BASE_URL}"
echo "pathname=${PATHNAME}"
echo "expect_mode=${EXPECT_MODE}"

SINGLE_PAYLOAD="$(python3 - <<'PY'
import json, os
print(json.dumps({
    "market": os.environ["MARKET"],
    "items": [
        {
            "skuId": os.environ["PRODUCT_ID"],
            "qty": int(os.environ["QTY"]),
            "merchantId": os.environ["MERCHANT_ID"],
        }
    ],
    "returnUrl": os.environ["RETURN_URL"],
}))
PY
)"

echo "== 1) single-merchant creator checkout =="
SINGLE_RESP="$(curl -fsS -X POST "${BASE_URL}${PATHNAME}" \
  -H "authorization: Bearer ${AUTH_TOKEN}" \
  -H 'content-type: application/json' \
  --data-binary "${SINGLE_PAYLOAD}")"
printf '%s\n' "${SINGLE_RESP}"

SINGLE_FILE="${TMP_DIR}/single_response.json"
printf '%s' "${SINGLE_RESP}" > "${SINGLE_FILE}"
python3 - "${SINGLE_FILE}" <<'PY'
import json, os, sys
with open(sys.argv[1], "rb") as f:
    body = json.load(f)
mode = os.environ["EXPECT_MODE"]
checkout_url = body.get("checkoutUrl") or ""
if mode == "ucp":
    assert "ucp_checkout_session_id=" in checkout_url, body
    assert "/order?items=" not in checkout_url, body
    assert not body.get("checkoutToken"), body
    assert body.get("checkoutSessionId"), body
    print("✓ creator single-merchant path returns UCP session url")
elif mode == "legacy_token":
    assert "checkout_token=" in checkout_url, body
    assert body.get("checkoutToken"), body
    print("✓ creator single-merchant path returns legacy checkout token fallback")
else:
    raise SystemExit(f"unsupported EXPECT_MODE={mode}")
PY

if [[ "${CHECK_MULTI_MERCHANT}" == "1" ]]; then
  echo "== 2) multi-merchant creator checkout =="
  MULTI_PAYLOAD="$(python3 - <<'PY'
import json, os
print(json.dumps({
    "market": os.environ["MARKET"],
    "items": [
        {
            "skuId": os.environ["MULTI_PRODUCT_ID_1"],
            "qty": 1,
            "merchantId": os.environ["MULTI_MERCHANT_ID_1"],
        },
        {
            "skuId": os.environ["MULTI_PRODUCT_ID_2"],
            "qty": 1,
            "merchantId": os.environ["MULTI_MERCHANT_ID_2"],
        },
    ],
    "returnUrl": os.environ["RETURN_URL"],
}))
PY
)"

  MULTI_RESP="$(curl -fsS -X POST "${BASE_URL}${PATHNAME}" \
    -H "authorization: Bearer ${AUTH_TOKEN}" \
    -H 'content-type: application/json' \
    --data-binary "${MULTI_PAYLOAD}")"
  printf '%s\n' "${MULTI_RESP}"

  MULTI_FILE="${TMP_DIR}/multi_response.json"
  printf '%s' "${MULTI_RESP}" > "${MULTI_FILE}"
  python3 - "${MULTI_FILE}" <<'PY'
import json, os, sys
with open(sys.argv[1], "rb") as f:
    body = json.load(f)
urls = body.get("checkoutUrls") or []
assert isinstance(urls, list) and len(urls) == 2, body
if os.environ["EXPECT_MODE"] == "ucp":
    assert all("ucp_checkout_session_id=" in (it.get("checkoutUrl") or "") for it in urls), body
    assert all("/order?items=" not in (it.get("checkoutUrl") or "") for it in urls), body
else:
    assert all("checkout_token=" in (it.get("checkoutUrl") or "") for it in urls), body
print("✓ creator multi-merchant path splits into checkoutUrls[]")
PY
fi
