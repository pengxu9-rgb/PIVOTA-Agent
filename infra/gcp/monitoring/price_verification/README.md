# price_verification_served: reading the metrics

Source: one `price_verification_served` log line per priced agent answer (src/observability/priceVerificationLog.js),
written only while `PRICE_VERIFICATION_LOG` is on. The three metrics here are created by hand
(`gcloud logging metrics create ... --config-from-file=<file>`, see each file's header).

Coverage = sum(`price_prices_verified`) / sum(`price_prices_served`), per surface and door.

## What each status means

Every price the door serves to the agent is exactly one of these:

- **live**: the merchant's own storefront answered within ~30 s of this request (plus the lookup time).
  It may have answered during the request, or up to ~30 s before it: the live readers coalesce identical
  lookups for 30 s, and a coalesced answer is stamped as the reader settles. Only a `verified` live read counts.
  A skipped, timed-out, failed or not-UCP read is stamped too, and dates nothing.
- **recent**: the merchant answered before this request, within the surface window:
  - search and recommend_products: 15 min
  - get_product and the PDP: 10 min
  - get_offers: 0 (so never recent)

  A read-cache replay is never live: at best it is recent.
- **stored**: everything else. That covers Pivota's catalog copy, an older merchant answer, and an answer with
  no time. It includes a price the answer flags for verification (`commerce_verification.required`,
  `price_trusted: false`) on a door that still quotes it (/mcp, invoke, REST), unless the merchant answered it.

What a door counts is what it serves:
- /mcp, invoke and REST count the native answer.
- /ucp/mcp counts only the rows the UCP shaper publishes.
- /public/mcp counts only the rows its projection serves with a price.

## Trial windows after turning the flag on

- **Exclude the first 60 min after the flip** (`PUBLIC_READ_CACHE_STALE_MS`, default 60 min). The public tier
  computes its facts with the answer and caches them with it. So for up to that long, a public replay of an entry
  stored while the flag was off writes no line, and public totals are low.
- The commerce doors (/mcp, /ucp/mcp) count their replays at once.

## skipped_reason

- **search:**
  - `lane_not_overlaid`: the answer carries no overlay outcome; the lane never calls the overlay.
  - `overlay_not_observed`: the answer carries an outcome, but this request recorded no overlay call. For
    example a background revalidation, or a loopback that found no open door.
  - `flag_off` (SERVE_LIVE_MERCHANT_PRICE), `page_gt_1`, `budget_constraint`.
  - `mcp_read_cache_replay`.
- **PDP:** `pdp_overlay_not_enforced`, `no_cached_merchant_answer`.
