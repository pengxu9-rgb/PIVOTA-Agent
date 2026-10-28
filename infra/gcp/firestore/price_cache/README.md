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
| `PRICE_CACHE_FIRESTORE_PROJECT` | GCP project id | **Required.** The project that holds the database. Never inferred: unset with the flags on, no store is built and `price_cache_config_failed` is logged once. |
| `PRICE_HOST_BUDGET` | `off` \| `shadow` \| `on` | Per-host merchant read budget and the fleet's shared backoff. `shadow` logs `price_host_budget_shadow` once a minute with what `on` would refuse; `on` refuses reads (`host_budget` / `host_backoff`; the stored price stands). Separate from the cache flags because a refused read changes an answer. |
| `PRICE_HOST_BUDGET_INSTANCES` | integer, default 4 | Per-instance bucket = ceil(60 / instances) reads a minute per host; a quarter is kept for get_offers. |

`STORE` and `MODE` must both be on, or nothing is built: no Firestore client is loaded and no connection is opened.

**The gateway's `GOOGLE_CLOUD_PROJECT` is the Vertex/Gemini billing project, not the cache's.** A Firestore client given
no project takes `GOOGLE_CLOUD_PROJECT`, so the cache always passes `PRICE_CACHE_FIRESTORE_PROJECT` explicitly. The
first write-mode flip (2026-10-27) had no such variable: every call addressed the Vertex project and was refused with
`PERMISSION_DENIED` (code 7). No answer changed, because a failed cache call is a miss.

## Data

- `verified_prices/{sha256(host|market|variant_id|currency)}`: `host, market, variant_id, currency, status
  (verified | variant_gone), amount, compare_at (decimal strings), available, handle, source (merchant_ucp |
  merchant_storefront | merchant_cart), writer (search | pdp | product | offers | cart), read_at, expire_at`.
  `expire_at` = `read_at` + 60 min (10 min for a `variant_gone` tombstone). TTL policy on `expire_at`.
- `host_backoff/{host}`: `backoff_until, backoff_ms, last_status, reason, set_at`. 60 s, doubling up to 10 min.
- Written only for a market the caller DECLARED, and only when the merchant's currency is that market's currency.

Writers: search `.json` overlay and UCP search read, get_product read, frontend PDP read (shadow and
`pdp_live_read`), get_offers read, cart mint (`GET_OFFERS_LIVE_CART=on`). Writes are batched (BulkWriter, about once a
second) and never on a response path. With the cache on, the boot loads the client and makes one read before the
server listens. Reads are one `getAll` of at most 20 docs with a 150 ms timeout behind a 30 s
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
   PRICE_CACHE_FIRESTORE_PROJECT=<the project that holds the price-cache database>
   ```

   Watch:
   - `price_cache_warm` at boot (one per instance; `price_cache_warm_failed` when the first read did not answer in 5 s);
   - `price_cache_write_failed` (warning; `code: flush_timeout` means Firestore did not answer a flush within 10 s);
   - `price_cache_store_stats` (at most one a minute while anything moved: written / failed / dropped /
     flush_timeouts / resets / abandoned / reenabled / probes / clients_built / pending / inflight / live_clients, and `disabled: true`
     once disabled);
   - `price_cache_store_reset` / `price_cache_store_disabled` (warnings; see below);
   - the doc count in the database.
3. `PRICE_HOST_BUDGET=shadow`, read `price_host_budget_shadow`, then `on`.
4. `PRICE_CACHE_MODE=read`. Before it, settle:
   - the write skip's edge: an instance skips re-writing an answer it saw itself within 5 min, even when another
     instance has since written a different one (`UNCHANGED_REWRITE_MS`, src/services/priceCache.js);
   - plain `set` across instances (no `read_at` precondition).

`price_cache_store_reset` (warning): three flushes in a row timed out, so the BulkWriter and the client were rebuilt and
their unsettled writes counted as `abandoned` (a hung connection; the cache keeps writing on a new channel). A dropped
client is never terminated (terminating one whose read the library is still retrying crashes the process).

`price_cache_store_disabled` (warning, `reason: no_write_succeeded`): five resets with no write landing in between
(Firestore refused or unreachable). The library keeps every dropped client alive while it retries, so the store stops
rebuilding and DISABLES itself: writes are dropped and counted (`price_cache_store_stats` keeps running,
with `disabled: true`), reads are misses, answers are what they would be with the cache off. It comes back by itself:
- **proof of life**: a write from a dropped client finally lands (the library kept retrying it), so Firestore answers;
  the store re-enables at once (`price_cache_store_enabled`, `reason: write_landed`) and builds one fresh client. This
  cannot fire while Firestore refuses, and fires within a retry or two of recovery;
- **slow probe**, for a hung connection whose writes never land: one fresh client after 30 min, then 1 h, 2 h, 4 h
  (cap), at most 6 per process (`reason: probe`); a probe that still fails disables again after one reset.
A deploy or instance restart also re-enables it.

**Client budget** (`price_cache_store_disabled`, `reason: client_budget`, once per process): at most **20 live
clients**, meaning the one in use plus every dropped client with a write or read still unsettled on it. The library keeps
such a client alive while it retries; once all its operations have settled (landed or failed) it is free and stops
counting. Without a budget, a *flapping* Firestore (down for 5 resets, up just long enough for one late write to land)
would come back and strand more clients every cycle, without bound (controller r6). At the budget the store is
disabled **until the instance restarts**: nothing that lands and no probe brings it back. A refused-forever outage
needs at most 5 + 6 probes = 11. The stats line carries `live_clients` (now) and `clients_built` (lifetime).

A slow-but-alive Firestore (a batch takes longer than the 10 s flush deadline) resets every ~30 s and its late writes
are reported as `abandoned` although they land. Because they land, the reset cap's count restarts, and each dropped
client is freed as its writes settle, so neither the reset cap nor the client budget disables it. Read `abandoned` as
"not confirmed in time", not "lost".

Rollback at any step: unset the flag (or set it to `off`).
