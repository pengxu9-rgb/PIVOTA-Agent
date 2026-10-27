# Shared verified-price cache (Firestore)

Verified-price plan PR-3. Code: `src/services/priceCache.js` (cache, key, currency rule, L1, shared host backoff),
`src/services/priceCacheStore.js` (the `PriceCacheStore` interface and its Firestore implementation),
`src/services/priceHostBudget.js` (per-host merchant read budget).

## Flags (all default off, read per call)

| Flag | Values | Effect |
|---|---|---|
| `PRICE_CACHE_STORE` | `off` \| `firestore` | Which store. |
| `PRICE_CACHE_MODE` | `off` \| `write` \| `read` | `write`: every live reader records its verified answers and merchant 429/5xx backoffs; nothing reads the cache, every answer is byte-identical to off. `read`: as write, and the search `.json` overlay may serve a card from the cache (15 min window) as `recent`. |
| `PRICE_CACHE_FIRESTORE_DATABASE` | database id | Default `price-cache`. |
| `PRICE_HOST_BUDGET` | `off` \| `shadow` \| `on` | Per-host merchant read budget and the fleet's shared backoff. `shadow` logs `price_host_budget_shadow` once a minute with what `on` would refuse; `on` refuses reads (`host_budget` / `host_backoff`; the stored price stands). Separate from the cache flags because a refused read changes an answer. |
| `PRICE_HOST_BUDGET_INSTANCES` | integer, default 4 | Per-instance bucket = ceil(60 / instances) reads a minute per host; a quarter is kept for get_offers. |

`STORE` and `MODE` must both be on, or nothing is built: no Firestore client is loaded and no connection is opened.

## Data

- `verified_prices/{sha256(host|market|variant_id|currency)}`: `host, market, variant_id, currency, status
  (verified | variant_gone), amount, compare_at (decimal strings), available, handle, source (merchant_ucp |
  merchant_storefront | merchant_cart), writer (search | pdp | product | offers | cart), read_at, expire_at`.
  `expire_at` = `read_at` + 60 min (10 min for a `variant_gone` tombstone). TTL policy on `expire_at`.
- `host_backoff/{host}`: `backoff_until, backoff_ms, last_status, reason, set_at`. 60 s, doubling up to 10 min.
- Written only for a market the caller DECLARED, and only when the merchant's currency is that market's currency.

Writers: search `.json` overlay and UCP search read, get_product read, frontend PDP read (shadow and
`pdp_live_read`), get_offers read, cart mint (`GET_OFFERS_LIVE_CART=on`). Writes are batched (BulkWriter, about once a
second) and never on a response path. Reads are one `getAll` of at most 20 docs with a 150 ms timeout behind a 30 s
per-process L1; a failed read is a miss (`price_cache_read_failed`, at most one line a minute) and pauses store reads
for 5 s.

## Rollout

1. Firestore database, TTL policy on `verified_prices.expire_at`, and the gateway service account's
   `roles/datastore.user` on that database (done for prod).
2. Write mode (shadow fill; byte-identical answers):

   ```
   PRICE_CACHE_STORE=firestore
   PRICE_CACHE_MODE=write
   PRICE_CACHE_FIRESTORE_DATABASE=price-cache
   ```

   Watch for `price_cache_write_failed` (error reporting) and the doc count in the database.
3. `PRICE_HOST_BUDGET=shadow`, read `price_host_budget_shadow`, then `on`.
4. `PRICE_CACHE_MODE=read`.

Rollback at any step: unset the flag (or set it to `off`).
