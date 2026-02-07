# Product Grounding / Resolver (Aurora Recos → PDP-openable `product_ref`)

This MVP adds a **merchant-agnostic** resolver endpoint so upstream recommenders (Glow Agent / DS / Aurora decision) can return a **grounded** `product_ref` that is guaranteed to be consumable by `get_pdp_v2`.

## Endpoint

`POST /agent/v1/products/resolve`

### Request

```json
{
  "query": "The Ordinary Niacinamide 10% + Zinc 1%",
  "lang": "en",
  "options": {
    "prefer_merchants": ["merch_efbc46b4619cfbdf"],
    "search_all_merchants": true,
    "allow_external_seed": false,
    "timeout_ms": 1500
  },
  "hints": {
    "category": "skincare",
    "actives": ["niacinamide", "zinc"]
  }
}
```

Notes:
- `prefer_merchants` is used as a strong preference signal (and first-pass recall via `products_cache` when available).
- `allow_external_seed=false` filters out `merchant_id=external_seed` / `source_type=external_seed` candidates by default.
- The resolver is **timeout-budgeted**; on timeout it returns `resolved=false` (no 5xx/Google fallback needed in UI).

### Response

```json
{
  "resolved": true,
  "product_ref": { "product_id": "…", "merchant_id": "…" },
  "confidence": 0.93,
  "reason": "token_overlap",
  "candidates": [
    { "product_ref": { "product_id": "…", "merchant_id": "…" }, "title": "…", "score": 0.93 }
  ],
  "normalized_query": "the ordinary niacinamide 10 percent plus zinc 1 percent",
  "metadata": {
    "timeout_ms": 1500,
    "latency_ms": 123,
    "sources": [{ "source": "products_cache|agent_search_*", "ok": true, "count": 12 }]
  }
}
```

If `resolved=false`, the contract guarantees:
- `product_ref=null`
- `candidates` may be empty or include low-confidence suggestions
- Caller/UI must treat it as **“PDP not openable”** and **must not** show `View details` / `Buy` CTA.

## Recommendation output contract (Glow Agent / DS / Aurora)

When emitting a commerce-capable recommendation card:

- Required (grounded):
  - `card.product_ref = { product_id, merchant_id }`
- Optional:
  - `card.product_name`, `card.brand`, `card.source_query`, `card.resolve_confidence`

If resolver returns `resolved=false`:
- Emit **text-only** advice (and optionally a “needs restock” hint).
- Do **not** provide `View details` / `Buy` CTA.
- Do **not** open Google as a fallback.

## Missing catalog closure (ops restock loop)

When `resolved=false`, the gateway emits a structured log/event:
- `event_name=missing_catalog_product`
- fields: `{ query, normalized_query, lang, hints, caller, session_id, reason, timestamp }`

Additionally, when Postgres is configured, it upserts an aggregated gap record into:
- `missing_catalog_products` (counted + last_seen)

### Export endpoint (admin-only)

`GET /api/admin/missing-catalog-products?sort=last_seen|count&limit=200&format=csv`

Headers:
- `X-ADMIN-KEY: $ADMIN_API_KEY`

## Acceptance (curl)

For each of the three products below:

1) Resolve:

```bash
curl -sS "$BASE/agent/v1/products/resolve" \
  -H 'Content-Type: application/json' \
  -d '{"query":"The Ordinary Niacinamide 10% + Zinc 1%","lang":"en","options":{"prefer_merchants":["merch_efbc46b4619cfbdf"],"timeout_ms":1500}}'
```

Expected:
- `resolved=true`
- `product_ref.merchant_id=merch_efbc46b4619cfbdf`

2) PDP:

```bash
curl -sS "$BASE/agent/shop/v1/invoke" \
  -H 'Content-Type: application/json' \
  --data '{"operation":"get_pdp_v2","payload":{"product_ref":{"product_id":"<from resolve>","merchant_id":"<from resolve>"},"include":["offers"],"options":{}}}'
```

Expected:
- `status=success`
- `modules[]` contains `type="offers"` with usable offers data for rendering `Buy` paths.

Products:
- The Ordinary Niacinamide 10% + Zinc 1%
- Winona Soothing Repair Serum
- IPSA Time Reset Aqua
