# Olive Young affiliate-feed lane — runbook (Fix Plan D · T4)

**Status:** scaffolding built + fixture-tested; **BLOCKED on affiliate credentials** (not yet provisioned). No live data ingested. Crawling Olive Young is banned by their ToS and is **out of scope** — the only compliant OY path is the affiliate-network product feed (DECIDED 2026-07-12).

## What exists now
| Piece | Path |
| --- | --- |
| Feed-format adapter seam | `src/services/oliveYoungAffiliateFeed.js` |
| Discovery script (fixture + live) | `scripts/discover-oliveyoung-affiliate-offers.cjs` |
| Sample feed fixture | `fixtures/oliveyoung/affiliate_feed_sample.json` |
| Tests (fixture-driven) | `tests/oliveyoung_affiliate_feed.test.js` |

The lane mirrors the Ulta pair, so once seeds land in `external_product_seeds` they flow through the **same** resolve-first matcher (`src/services/retailerOfferIdentity.js`) that folds retailer offers onto existing D2C products by `brandCore + strict titleCore`.

## Run it
```bash
# Dev / test — no credentials, uses the committed fixture:
node ./scripts/discover-oliveyoung-affiliate-offers.cjs --fixture \
  --manifest-out data/oliveyoung/manifest.json --out reports/oy_discover.json

# Live — requires credentials (see below). Without them it FAILS GRACEFULLY
# (empty manifest, feed_status=missing_affiliate_credentials, exit 0). Never crawls.
OY_AFFILIATE_NETWORK=impact \
OY_AFFILIATE_FEED_URL='https://<network-feed-endpoint>/oliveyoung.json' \
OY_AFFILIATE_API_KEY='<token>' \
node ./scripts/discover-oliveyoung-affiliate-offers.cjs --market US \
  --brands 'COSRX,Beauty of Joseon,Anua,SKIN1004,Round Lab,Medicube'
```
Then insert the manifest seed rows into `external_product_seeds` (existing intake path)
and mirror them with the retailer sync — the resolve-first step reuses matched D2C
`content_key`/product group; fuzzy candidates go to `retailer_offer_identity_review`.

## Credentials required (to be provisioned by the operator)
The lane needs an affiliate program that exposes a **product datafeed** for the OY
Global advertiser. Set as backend env vars (never committed):

| Env var | Meaning |
| --- | --- |
| `OY_AFFILIATE_NETWORK` | network slug, e.g. `impact`, `cj`, `rakuten`, `partnerize` |
| `OY_AFFILIATE_FEED_URL` | authenticated product-datafeed endpoint for the OY advertiser |
| `OY_AFFILIATE_API_KEY` (or `OY_AFFILIATE_TOKEN`) | bearer token / feed key |
| `OY_AFFILIATE_TIMEOUT_MS` | optional fetch timeout (default 60000) |

`hasAffiliateCredentials()` requires all three of network + feed URL + key before the
script will touch the network.

## Feed-format assumptions (adapter contract)
The adapter (`normalizeFeedRecord`) accepts a per-product record and reads these
fields, tolerating the common aliases across networks (Impact/CJ/Rakuten/Partnerize)
and a raw OY export:

- **identity:** `product_id | sku | id | prdtNo | gtin`
- **brand:** `brand | brand_name | manufacturer`
- **title:** `product_name | name | title | product_title`
- **price:** `price | sale_price | current_price | retail_price | pricing.amount`
- **currency:** `currency | price_currency | pricing.currency`
- **availability:** `availability | stock_status | in_stock | stock`
- **product URL:** `product_url | url | link | landing_page_url | buy_url`
- **affiliate deeplink (preferred destination):** `deeplink | tracking_url | aff_url | click_url | affiliate_url`
- **image:** `image_url | image | image_link | thumbnail`
- **category:** `category | category_path | product_type | google_product_category`

Top-level feed shapes handled: a JSON array, or `{products|items|offers|data|results:[...]}`.
CSV/XML adapters can be registered later without changing callers (`parseFeed` seam).

Only offers with a real OY host / affiliate deeplink **and** a positive price **and** a
valid ISO currency are ingested (`isSafeOYOffer`). Nothing is fabricated.

## Decision gate — OY feed vs Amazon PA-API fallback
Per the plan, OY affiliate feed is the primary path, with **Amazon PA-API + the
existing Ulta lane** as the fallback if the OY program cannot deliver a usable
product feed for the target brands.

**We could not verify the OY program live (no credentials, and crawling is banned).**
When credentials are provisioned, evaluate:

1. Does the OY Global advertiser expose a **product-level datafeed** (not just
   deeplink/coupon tools) covering the target K-beauty brands (COSRX, Beauty of
   Joseon, Anua, SKIN1004, Round Lab, TIRTIR, Medicube)?
   - **Yes →** run this lane; the seeds collapse onto D2C products automatically.
   - **No (deeplink-only / no catalog feed) →** do **not** substitute crawling.
     Fall back to `docs/amazon_paapi_3p_ingest_scope.md` (Amazon PA-API `GetItems`
     / `SearchItems` for the same head brands) to prove multi-retailer, and record
     the OY feed gap. The Ulta lane already proves the multi-retailer pattern
     (ulta.com carries 39 brands / 448 offers today).

Amazon PA-API prerequisites (from the scope doc): an Associates account in good
standing with qualifying sales, then `PAAPI_ACCESS_KEY` / `PAAPI_SECRET_KEY` /
`PAAPI_PARTNER_TAG`. That lane is a separate build; this runbook only wires OY.
