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

### 1b. …and half of it was still lying (2026-07-27)

The fix above closed the **404** lane. Re-probed on prod 2026-07-27, the **400** lane was still open:

| `get_product(product_id)` | before | after |
|---|---|---|
| a gated but real sig | `NO_MERCHANT_OFFER`, `retriable:false` ✅ | unchanged |
| `sig_deadbeefdeadbeefdeadbeefdeadbeef` | `MERCHANT_UNAVAILABLE`, **`retriable:true`** | `UNKNOWN_PRODUCT_ID`, `retriable:false` |
| `rejuran:healer-turnover-ampoule` | `MERCHANT_UNAVAILABLE`, **`retriable:true`** | `UNKNOWN_PRODUCT_ID`, `retriable:false` |

Unscoped `get_product_detail` routes to this gateway's own `get_pdp_v2`, and an id that cannot be resolved to
a canonical identity comes back **HTTP 400 `MISSING_MERCHANT_CONTEXT`** — *"merchant_id is required when
canonical product identity cannot be resolved"*. A 400, not a 404, so it missed both arms and fell through to
the retriable default.

**`UNKNOWN_PRODUCT_ID` and not `NO_MERCHANT_OFFER`,** even though both are terminal with the same recovery.
`NO_MERCHANT_OFFER` says the product exists and only the offer is missing — an active lie about an id that
resolves to nothing — and it is metered as a catalog-**coverage** signal, i.e. gaps we own. Folding stale or
invented ids into that metric would make it unreadable the first time an agent starts guessing sigs.

**Two guards, both load-bearing.** The arm keys on the upstream *code* and is restricted to
`get_product_detail` — the one op where "the id resolved to nothing" is a sentence that can be true. Op-scoping
matters because `throwCommerceKernelUpstreamError` is shared with `preview_quote` / `create_order` /
`submit_payment`; code-matching matters because a bare 400 on a read op is just as likely a malformed
`page_size`. The decision now lives in `src/services/commerceKernelErrorMapping.js` so it is unit-testable
without booting the app, and `tests/commerce_kernel_error_mapping.node.test.cjs` pins that neither terminal
classification can reach a money op.

**One cell of the 404 lane moves.** `get_product_detail` + `MISSING_MERCHANT_CONTEXT` + HTTP 404 previously
reported `NO_MERCHANT_OFFER` and now reports `UNKNOWN_PRODUCT_ID` — the new arm is checked first, by design.
Same terminal semantics, same HTTP 404 out; it only routes that slice onto the metric that describes it. Every
other 404 cell is byte-identical (verified by diffing the old and new decision tables over 1,800 op × code ×
status combinations: 96 divergences, all of them this one condition).

Both terminal codes now also map to **404 on the ACP door** (`acpRestAdapter.STATUS_BY_CODE`). Neither had an
entry, so both fell to its `?? 400` default — telling an ACP client its *request* was malformed and pointing it
at fixing the payload rather than the id. `NO_MERCHANT_OFFER`'s omission dates from #1829; both are fixed
together so the door cannot answer two statuses for one class of fact.

`safety-kernel/src/protocol/productionWiring.js` deliberately does **not** mirror this arm: it throws before
parsing the response body, so it cannot see an upstream code, and widening it to a bare 400 would be wrong.
The two wirings stay in step on the 404 lane, which is the only lane both can observe.

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

A third fail-open case is subtle enough to be worth stating: `resolveCatalogProductRefFromPivotaSignature` has
fallback branches returning only `{merchant_id, product_id, platform, product_key}` — **no** `external_seed_*`
columns. Value-checking `external_seed_id` would read those as "no seed" and drop healthy seed-routed rows,
i.e. most of the catalog. The exact branch always *sets* the seed keys (even to `undefined`); the fallbacks
never set them. So the discriminator is key **presence**, not value: no seed keys ⇒ the resolver did not
answer the question ⇒ keep the row.

The whole decision lives in `src/services/publicReadChainResolvability.js` precisely because it is this
fiddly — it is unit-testable with no database.

**Backfill, don't shrink.** Both post-hoc filters drop rows after the upstream already trimmed to the
requested page size, so filtering alone would shrink the page. `"serum"` holds 9 dead rows in its top 10 but
**11 resolvable rows in its top 20** — the dead rows are concentrated at the top of the ranking. The surface
now asks upstream for the projector's ceiling (`MAX_SEARCH_RESULTS`) and lets the projector slice back to the
caller's `page_size`, turning drops into backfill. `"serum"` returns ~10 real results instead of 1 real + 9
dead.

### Two bounds worth knowing

**Over-fetch applies to the first page only.** `page` is expressed in units of `page_size`, so inflating
`page_size` while leaving `page` alone relocates the window — page 2 of size 10 (rows 11–20) would fetch page
2 of size 20 (rows 21–40) and skip ten products. Deeper pages pass the caller's args through untouched and may
return a short page.

**The filter probes at most `2 × MAX_SEARCH_RESULTS` rows per search.** The recall pipeline carries a wide
candidate pool (~50 rows) and only trims to the requested `page_size` while `FPM_ENFORCE_REQUESTED_PAGE_SIZE`
is on; the cap keeps an unauthenticated search from fanning out one resolver probe per pooled row if that flag
is ever flipped. Rows past the cap are **truncated, not passed through** — an unexamined row reaching the page
is the original bug.

### Known wart: `total` is an upper bound

`total` still reports the upstream (unfiltered) match count, so it over-counts *fetchable* products, and a
client paginating by `total / page_size` will hit short pages. Computing a true filtered total would mean
probing the whole candidate pool on every search. `returned` is the honest per-page count. Left as-is
deliberately rather than replaced with a fabricated number.

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

- `mcp-server/test/publicReadChainContract.test.js` — filtering, backfill, over-fetch, first-page-only
  pagination, the probe cap + truncation, opt-in behaviour
- `mcp-server/test/noMerchantOfferError.test.js` — the taxonomy split, the `retriable` field, and that a bare
  404 stays a retriable outage on `preview_quote` / `create_order` / `submit_payment`
- `tests/public_read_chain_resolvability.node.test.cjs` — the drop/keep decision with no DB, including the
  fallback-ref shape as an explicit regression against mass over-drop
- `tests/public_read_chain_seed_routed_probe.node.test.cjs` — pins the seed-routed probe, and fails loudly if
  `MERCHANT_SYNCED_LANE_RENDERABLE` flips (which would otherwise silently delete every shopify row from search)
