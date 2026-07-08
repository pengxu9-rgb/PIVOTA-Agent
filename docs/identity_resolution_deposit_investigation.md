# Why connected-merchant audits don't deposit — identity-resolution decision memo

*Status: investigation complete, build starting. 2026-06-30. All numbers verified against production.*

## TL;DR

The `citation_observations` matrix (the cross-seller asset behind the BD Channel
Graph and the get-cited proof loop) now populates correctly — but **only for the
`external_seed` catalog**. Every real connected merchant deposits **zero**
observations. The root cause is not the deposit code (which we fixed and validated
live: 0 → 35 rows on a seed run). It is that **connected-merchant products can't
clear the deposit gate, and the only things that would let them — a canonical
anchor for their brand — don't exist in the catalog.**

Four mechanisms could unlock connected merchants. All are real and correct. All are
throttled by the *same* root cause: **canonical-catalog coverage of the brands
merchants actually sell.**

| Track | Unlock today | Why so small |
|---|---|---|
| D2C `official_url` credit | **16 products** | base is mostly multi-brand retailers, not D2C brands |
| Canonical `content_key` match | **6 products** | few connected products match a *depositable* seed entity |
| Fuzzy-match-to-anchor | **~10 products** | only 3 of 16 connected brands have a depositable anchor |
| GTIN | **~0** | merchants don't supply barcodes; capture is wired, source is empty |

## Background: how the deposit gate works

- `citation_observations` (migration 157) is the normalized per-(content_key,
  provider, query, host) store. Observations **accrete on `content_key`** across
  sellers — `content_key = sha256(normalize_brand | normalize_title | gtin)` and is
  **deliberately non-unique** (migration 083) so the same product across sellers
  shares one key.
- An audit deposits observations for a product **only if it is "depositable"**:
  `resolve_deposit_content_key` (services/catalog_identity.py) authorizes on
  `gtin` | `identity_high_conf` (identity_confidence ≥ `CONTENT_KEY_DEPOSIT_MIN_CONFIDENCE`,
  default **0.85**) | `reviewed`.
- The 0.85 gate exists **because** `content_key` is non-unique: depositing on a weak
  identity would cross-contaminate the canonical entity's cross-seller observations.
  **Keeping this gate strict is correct** — do not lower it.

## What we already fixed and shipped (works in prod)

Two real bugs were making `citation_observations` empty across all 139 audits, both
in `_resolve_content_keys` (pivota-backend). Merged + deployed 2026-06-30
(backend PR #1081, frontend #72) and validated live on an `external_seed` run:
**0 → 35 observations, 3 products deposited on `identity_high_conf`**, Channel Graph
populated.

1. Resolved `product_keys` only from `brand_report.per_product` (always null in
   prod) → now also unions `authority_map.skus[].product_key`.
2. The gate only ever received `gtin` → now also passes `identity_confidence` from
   `catalog_row_trust`.

These fixes are correct and necessary. They light up the *index*. They do nothing
for connected merchants — which is what the rest of this memo is about.

## Why connected merchants are dark

The Node identity resolver (`PIVOTA-Agent/src/services/pdpIdentityGraph.js`) writes
`pdp_identity_listing` → propagated to `catalog_row_trust` → read by the deposit
gate. Findings:

1. **It was never run for connected merchants.** `pdp_identity_listing`: 5,835 rows
   for external_seed vs **3** for connected. The resolver is a manual admin endpoint
   (`POST /api/admin/pdp-identity/backfill`), no auto-trigger on connect/sync.
2. **Even after running it (we did — 1,540 connected products resolved): 0 reached
   0.85.** Max confidence = **0.68** (409 "approved" at 0.56–0.68, 1,133
   review_required at 0.36–0.62). They matched via `singleton_source_ref` /
   `soft_exact_cluster` (brand+title only) — **0 via GTIN, official_url, or canonical
   content_key**, the rules that lift confidence.
3. **external_seed clears 0.85 via `official_url`, not GTIN.** ~79% of its approvals
   are `official_url_*` rules (avg 0.88–0.95). GTIN barely appears — the seed catalog
   is itself ~0% GTIN. The signal connected products lack is a **product URL**:
   `extractOfficialUrl` reads `canonical_url`/`url`/`online_store_url`, none of which
   exist in the normalized `products_cache` payload, so `chooseSourceTier` also falls
   to `merchant` tier (0.42 base).

## The four tracks

### 1. D2C `official_url` credit (cheapest real win — building first)
Inject the merchant's **verified active storefront domain** (`merchant_stores`) as
the product's `official_url` on the resolver's internal-source path. The resolver's
existing logic does the rest, and its **brand-tier guard makes it self-limiting**:
brand-tier (0.6) is granted only when the storefront domain matches the product's
vendor. So a true D2C brand → 0.6 + 0.12 official_url + brand + title + axes ≈
**0.90 (depositable)**; a multi-brand retailer (domain ≠ vendor) stays ~0.80 and is
correctly *not* inflated. No GTIN, no threshold change, no contamination.
**Yield: 16 products today + every future D2C brand automatically.**

### 2. Canonical `content_key` match
Deposit a connected product when its `content_key` matches a depositable seed
entity, inheriting the anchor's confidence. **Yield: 6** (only 6 connected products
exact-match a *depositable* seed entity; 104 match *some* seed entity, but 98 of
those seeds are themselves below 0.85).

### 3. Fuzzy-match-to-anchor
Match a retailer listing onto an official_url-anchored canonical brand entity by
*fuzzy* title similarity (not exact hash), inheriting its `content_key`. **Three
layers:**
- **Matcher** (Node, ~600–800 LOC, mostly reuse): `normalizeTitleCore` /
  `extractSoftIdentity` / `extractVariantAxes` / `clusterIdentityListings` exist;
  net-new = an anchor candidate query + a fuzzy scorer (**no fuzzy distance exists
  anywhere today — it's all exact-token equality**) + threshold tuning. Marginal
  matches feed the existing review queue (`pdp_identity_review_queue` /
  `pdp_identity_override`).
- **`matched_content_key` inheritance → deposit gate** (net-new, spans repos):
  `matched_content_key` is a **Phase-1 stub, always NULL, and the deposit gate
  doesn't read it.** This is the load-bearing missing piece — without it the matcher
  deposits nothing.
- **Embeddings** (`embeddings.js` + pgvector + `products_cache_embeddings`) exist,
  unused — optional semantic ranking. No image hashing.

**Yield: ~10 products today** — gated by anchor coverage, not match quality.

### 4. GTIN (dead end from existing data; external enrichment flagged as future)
Barcode capture is **fully wired** (Shopify variant → `StandardProductVariant.barcode`
→ `products_cache` + `catalog_skus.barcode` → `make_content_key`), but the source is
empty: **0 of 5,229 connected SKUs, 10 of 12,687 seed SKUs** carry a barcode. A
re-fetch recovers nothing. The only path is **external GTIN enrichment** (look up by
brand+title against GS1/UPC/commerce-data providers) — which (a) inherits the
product-identification problem, (b) only covers the **branded head**, (c) is an
ongoing external dependency. *Flagged as a separate future task — an accelerant on
top of an anchored catalog, not a foundation.*

## The shared root cause

All four converge on **canonical-catalog coverage**: a connected product can only
deposit if a high-confidence canonical entity exists for it. The data:
**118 depositable brands in external_seed vs. 16 brands the connected merchants
sell — only 3 overlap** (kravebeauty, ownist, theordinary). The anchors for the
merchants' brands simply aren't in the catalog. The matcher/official_url/GTIN tracks
are all plumbing onto anchors that mostly don't exist yet.

**The real unlock is growing the anchored canonical catalog to cover the brands
merchants carry** — i.e. ingest products (incl. audited ones) as canonical *brand*
entities with the brand's `official_url` resolved. That is the durable foundation;
everything else attaches to it.

## Recommended build order

1. **D2C `official_url` fix** *(building now)* — contained, safe, real connected
   deposits (16 + all future D2C), and it proves the connected→deposit→Channel-Graph
   loop end-to-end on real merchant data.
2. **`matched_content_key` inheritance + deposit-gate read** — load-bearing plumbing
   that immediately lets canonical matches (track 2) deposit and is the prerequisite
   for the fuzzy matcher.
3. **Anchor-catalog coverage** — the larger investment that determines total payoff;
   grow the canonical catalog for the brands merchants sell. NOT a new crawler (one
   exists) and NOT "ingest audited products" (blocked — see addendum); it's
   **automating the existing Path-C enrichment pipeline**. Scoped in the addendum below.
4. **Fuzzy-match-to-anchor matcher** — attaches retailer listings to the grown
   catalog.
5. *(future)* **External GTIN enrichment** for the branded head — accelerant.

**Do not** lower the 0.85 deposit threshold (corrupts the cross-seller matrix) or
build the fuzzy matcher in isolation (only ~10 products until the catalog grows).

## Data appendix (prod, 2026-06-30, via DATABASE_PUBLIC_URL)

- citation_observations: 0 across 139 audits → 35 after the deposit fix (seed run 9834f6be).
- pdp_identity_listing: external_seed 5,835 / connected 3 (then 1,540 after our backfill).
- connected resolved confidence: max 0.68; 409 approved (0.56–0.68), 1,133 review_required; **0 ≥ 0.85**.
- GTIN/barcode: connected SKUs 0/5,229; seed SKUs 10/12,687; canonical_variants 0/2,363.
- external_seed depositable: 5,448 products / 118 brands; cross-seller content_key clusters: 374/6,095 (mostly identical-title dropship).
- connected base: 6 merchants, 1,545 products, 16 brands; D2C (domain≈vendor) = 16 products; brand overlap with depositable seed = 3.

---

## Addendum (2026-06-30) — Track #3 scoped: catalog coverage = AUTOMATE PATH C

**Correction:** earlier in this investigation a sub-agent reported "no crawler exists."
That was wrong. There is a rich crawl/onboard/enrich pipeline. Catalog growth must
NOT be a new crawler, and the "ingest audited products" idea (Path B) is blocked.

### What exists (the onboarding paths — `docs/PDP_ONBOARDING_PLAYBOOK.md`)

- **Path A** — internal merchant sync (Shopify/Wix Admin API → `catalog_products`). Integration side.
- **Path B** — external seed mirror: `external_product_seeds` (from scrapers/agents/codex) →
  `scripts/mirror_external_seeds_to_catalog_products.py` → `catalog_products(external_seed)`. 3,936 rows.
- **Path C** — catalog enrichment agent (the depositable-anchor engine; `pdp_scope=multi_merchant_canonical`,
  conf ≥0.9): candidate JSONL → `run_catalog_enrichment.py validate` (Gemini URL validation,
  `services/catalog_enrichment_agent/gemini_url_validator.py`) → `ingest`
  (`services/catalog_enrichment_agent/ingestion.py:ingest_validated_record`) → writes
  catalog_products + skus + offers + external_product_seeds together.
- Per-PDP fetch+extract: `services/external_offers_service._fetch_html` + `_extract_from_html`
  (httpx + JSON-LD/OpenGraph). Codex branch `codex/pdp-quality-source-backed-components-py` =
  source-backed PDP quality. **No in-code external-brand enumeration** (no products.json/sitemap
  crawl of un-integrated brands) and **no queue/scheduler** — Path C is run manually per category.

### The key insight (vindicates audit→catalog discovery)

A **Path-C candidate is product METADATA, not a crawled URL**:
`{brand, product_name, category_path, attribute_summary, expected_url_domains}`
(see `data/catalog_enrichment/*_pdp_candidates.jsonl`). The Gemini validator **resolves the
canonical PDP URL itself** from brand+product+domain-hints (slugified fallback) and **drops
candidates that don't resolve to a live PDP**. So:
- The audit's competitor **brand+product names** (`competitors_named`, `category_competitors`)
  map DIRECTLY to candidates. No precise brand→domain resolver needed — Gemini resolves the URL.
- The noisy-name concern dissolves: the **validator is the quality gate** that filters non-resolving
  junk. (Earlier "feed is too noisy / needs a resolver" conclusion was OVERSTATED.)

### Scope — automate Path C (≈1 week, high reuse)

REUSE entirely: `validate_candidate` / `_validate_with_concurrency` (Stage 2) +
`ingest_validated_record` (Stage 3) + the `derive_*` helpers + dedup shape.
NET-NEW (glue):
1. **Audit→candidate transform** — from a completed audit's `competitors_named`/`category_competitors`,
   emit candidate records (brand, product_name, category_path, expected_url_domains=brand domain or
   audit-cited host). Dedup + recurrence-prioritize (à la niche_recurrence). Small.
2. **Path-C runner orchestration** — a service/worker that runs validate→ingest over a candidate
   batch from the audit feed (today it's CLI files). Small.
3. **Dedup** vs existing index (brand+product / canonical_url already in external_seed). Small.
4. **Queue/batch + cost control** — 1 Gemini call/candidate; cap + prioritize recurring brands;
   curated brand lists are the clean primary feed, audit-discovery the secondary.

### Net

Catalog coverage is mostly BUILT (3 paths + validator + ingest + quality + playbook); the gap is
**orchestration over Path C**, not a crawler. Build order: automate Path C (curated feed first,
audit-discovery second) → it produces official_url'd ≥0.9 canonical anchors → retailer/merchant
listings match + deposit. This is the real "crawl-before-they-integrate" engine.
