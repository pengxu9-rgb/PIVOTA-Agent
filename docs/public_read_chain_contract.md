# The public read chain contract: `search_catalog` → `get_product`

The public MCP tier (`POST /public/mcp`, `mcp.pivota.cc`) exists so an agent can do two calls: search, then
fetch one of the results. That pair is the product. If an id from search cannot be fetched, the agent has
burned two calls for nothing — and every result it *shows* a user carries a `pivota_url` that renders a shell.

**The contract: an id returned by `search_catalog` must resolve in `get_product`, and its `pivota_url` must
render.**

## What was broken (measured on prod, 2026-07-25)

| measurement | result |
|---|---|
| public search results sampled (14 queries) | 99 |
| results whose id `get_product` refused | **22 (22%)** |
| distinct dead ids | 21 |
| dead ids also absent from `sitemap-products.xml` | **21 / 21** |
| dead ids whose PDP served a shell (no `ld+json`) | all sampled |
| `"serum"` — the flagship query — top 10 | **9 of 10 dead** |

Every failure returned:

```json
{"error": {"code": "MERCHANT_UNAVAILABLE",
           "message": "The merchant is temporarily unreachable. Please try again shortly."}}
```

Two independent defects, fixed independently.

## 1. The error was a lie

Nothing was temporarily unreachable. These rows have no content route at all and never will until an offer
is attached. `throwCommerceKernelUpstreamError` (`src/server.js`) collapsed *every* upstream failure that was
not `QUOTE_EXPIRED` / `PRICE_CHANGED` / `OUT_OF_STOCK` into `MERCHANT_UNAVAILABLE`, which the shared taxonomy
declares `retriable: true`. So a permanent data condition was served to agents as "retry shortly" — a retry
trap that burns agent budget — and to operators as an outage that was not happening.

Now: a `404` / `PRODUCT_NOT_FOUND` from a read lane maps to **`NO_MERCHANT_OFFER`**, `retriable: false`, with a
message that does not promise a retry. Every other upstream failure keeps its existing classification. The
same split is applied in `safety-kernel/src/protocol/productionWiring.js` so both upstream wirings agree.

The MCP error body now also carries `retriable`. A code alone is not actionable — an agent seeing an
unfamiliar code has no way to tell "back off" from "this will never work", so it retries.

## 2. Search advertised ids detail could not serve

`search_catalog` is served by the canonical index (`find_products_multi`); unscoped `get_product` resolves
through `get_pdp_v2`'s signature lane. The two disagreed about which rows exist.

The public read surface now filters search rows against the detail lane's **own** resolver
(`publicReadDetailResolves` in `src/server.js`) before projection. It deliberately does *not* re-derive a
predicate over `catalog_products` — `src/services/pdpRenderability.js` documents what re-derivation costs when
the twins drift.

### Two design rules

**Drop only what is provably dead.** This is the *opposite* asymmetry from `pdpRenderability`. There,
under-advertising costs a withheld sitemap URL, so unproven lanes fail closed. Here a false negative deletes a
product from search that `get_product` would have served, so unproven lanes fail **open**. Only two measured
cohorts are removed:

1. non-signature ids (`rejuran:…`) — the unscoped lane cannot resolve them at all (0 of 5 sampled did);
2. seed-routed rows with no acceptable seed on their content route — the same question
   `seedRouteResolvesSql` asks and the same precheck `get_pdp_v2` applies.

Rows on any other lane (shopify/wix, `url_audit`, `brand_authored`) are **kept**: 77 of 98 sampled ids resolve
fine, and borrowing `pdpRouteResolvable`'s non-seed arms wholesale would have gutted the catalog.

**Backfill, don't shrink.** Both post-hoc filters drop rows after the upstream already trimmed to the
requested page size, so filtering alone would shrink the page. `"serum"` holds 9 dead rows in its top 10 but
**11 resolvable rows in its top 20** — the dead rows are concentrated at the top of the ranking. The surface
now asks upstream for the projector's ceiling (`MAX_SEARCH_RESULTS`) and lets the projector slice back to the
caller's `page_size`, turning drops into backfill. `"serum"` returns ~10 real results instead of 1 real + 9
dead.

## Defense in depth

The filter removes the systematic cohorts; the honest error covers the residual. Both are needed — the
catalog can change between the search call and the fetch, and `get_product` accepts arbitrary ids.

## Flags

| env | default | effect |
|---|---|---|
| `PUBLIC_READ_CHAIN_FILTER_ENABLED` | on | `0`/`false`/`off`/`no` disables the search-side filter |

The filter is **fail-open**: any resolver error, timeout, or missing `DATABASE_URL` keeps the row and logs it.
A blank public search is a worse failure than a dead id, and a dead id now returns an honest, terminal error.

## Verifying

`pivota-protocol`'s `conformance/check.py` asserts `search -> get_product chain resolves` against
`products[0]`. Before this change that was red on prod (for `"serum"`, `products[0]` was a dead Guerlain row).

```bash
python3 conformance/check.py
```

## Coverage

- `mcp-server/test/publicReadChainContract.test.js` — filtering, backfill, over-fetch, opt-in behaviour
- `mcp-server/test/noMerchantOfferError.test.js` — the taxonomy split and the `retriable` field
- `tests/public_read_chain_seed_routed_probe.node.test.cjs` — pins the seed-routed probe, and fails loudly if
  `MERCHANT_SYNCED_LANE_RENDERABLE` flips (which would otherwise silently delete every shopify row from search)
