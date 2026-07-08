# WooCommerce Merchant Onboarding via Crawl (external-seed) — Runbook

**Status:** operational today. No native WooCommerce connector required.
**Scope:** read-only catalog + PDP onboarding for discovery / AI-readiness audit / commerce-index coverage. **Not** live checkout, quotes, refunds, or webhooks (that is the native-connector track — see `woocommerce_native_connector_scope.md`).
**Owner:** commerce-index / catalog.
**Date:** 2026-07-08.

---

## What this does

The `external-seed` path onboards *any* brand store — WooCommerce included — using only a **brand name + domain**. The external Catalog Intelligence extractor reads the store (for WooCommerce, its public Store API / PDPs), returns normalized products with provenance, and the pipeline writes them as `external_seed` catalog rows that are searchable and auditable.

Already proven on WooCommerce: **KHUS KHUS** was ingested straight off its `official_woocommerce_store_api` (see `reports/markato_expansion_status_20260524/wave14_khuskhus_direct_pdp_20260525/candidate_manifest.json`).

Pipeline (three scripts, chained by one workflow):

```
build_beauty_brand_external_seed_manifest.cjs   → raw manifest (calls extractor /api/extract[-v2])
review-external-seed-creation-manifest.cjs      → coverage gate → accepted manifest
run_aurora_external_seed_creation_pipeline.cjs  → dry-run, then --apply → DB rows
```

Serving of the resulting rows: `src/services/externalSeedProducts.js` (merchant id `external_seed`).

---

## Preconditions

- **Domain must be the store's own site** where the WooCommerce Store API / PDPs are publicly reachable. If the brand only sells via a marketplace (Amazon, @cosme, Olive Young), this path onboards thin or not at all — that is a retailer-crawl problem, not this runbook.
- Secrets available to the workflow (GitHub environment `Pivota Agent / production`): `DATABASE_URL`, `CATALOG_INTELLIGENCE_BASE_URL`.
- `market` code drives locale/currency for the offer. **Set it to the store's real selling market** — do not leave `US` on a KR/EU store (past US/USD-hardcode bug fixed in PR #1094; still confirm the offer market matches).

---

## Procedure — single store

Use the workflow `External Seed Create From Brand` (`.github/workflows/external-seed-create-from-brand.yml`), `workflow_dispatch`.

Inputs:

| input | value | notes |
| --- | --- | --- |
| `brand` | e.g. `KHUS KHUS` | canonical brand name |
| `domain` | e.g. `khuskhus.com` | the WooCommerce store origin |
| `market` | `US` / `KR` / `GB` … | **must match where the store sells** |
| `limit` | `10` (spot-check) → raise for full | extractor row cap |
| `dry_run` | **`true` first**, then `false` | always dry-run before apply |
| `include_commerce_facts` | `true` | attaches price/availability from extract-v2 |
| `exclude_title_regex` | optional | extra bundle/gift/sample exclusion |
| `allow_block_provider` | `false` | only flip if anti-abuse block is a known false positive |

**Run order: dry-run → inspect → apply.**

1. **Dry-run** (`dry_run=true`). Download the `external-seed-create-from-brand-<run_id>` artifact. Check:
   - `review-summary.json` → `ok_to_continue: true`, `accepted_item_count > 0`, and **no** blockers of the form `price_coverage_below_0.9`, `availability_coverage_below_0.9`, `image_coverage_below_0.9` (the review gate is `--min-coverage 0.9`; see `scripts/review-external-seed-creation-manifest.cjs:208-210`).
   - `zero_accepted_items_from_extractor` blocker ⇒ extractor couldn't read the store (WooCommerce Store API not public, JS-rendered PDPs, or anti-bot). Do not proceed; escalate to catalog-intelligence.
   - Spot-check `seed-creation-manifest.reviewed-accepted.json` — real single PDPs, not bundles/kits/samples (the builder already filters `BUNDLE_LIKE_TITLE_PATTERNS`).
2. **Apply** (`dry_run=false`). Re-run same inputs. Artifact `database-gate.json` must show `database_available: true` and a non-empty `summary`.

---

## Procedure — batch of stores

For "lots of WooCommerce merchants," don't hand-run per store. Two options:

- **Loop the workflow** per `(brand, domain, market)` triple. Cheapest; one artifact per store; easy to audit.
- **Cohort file** (existing Path B): `onboard_external_brand_from_crawl --file cohort.json` where each entry is `{brand, domain, market}`. Same extractor + gate underneath. Use when you want one reviewed manifest for a whole wave (mirrors the `markato_expansion` wave pattern under `reports/`).

Recommended batch flow:
1. Assemble the WooCommerce merchant list with real selling market per store.
2. Dry-run the whole cohort; triage stores that hit `zero_accepted_items_from_extractor` or coverage-below-0.9 into a "needs-extractor-work" bucket.
3. Apply only the clean ones. Re-audit the failures separately.

---

## Verify it worked (don't trust apply summary alone)

After apply, confirm the rows are not just ingested but **serving-eligible** — the common failure mode is "ingested but `serving_eligible=FALSE`" (exactly what happened on the ANUKO KRW ingest).

Serving gate ladder (rows drop out at the first failure):
1. `quality_score` too low (thin extraction),
2. short description under the minimum length,
3. entity unresolved (no canonical product match).

Checks:
- Query the `external_seed` rows for the brand; confirm `serving_eligible = TRUE` on the products you expect to serve. Rows at `FALSE` are indexed but **won't appear in discovery/search** — they still count for audit but not for the "callable/citable" surface.
- Run a discovery query for a known product; confirm it returns from the `external_seed` lane (`src/findProductsExternalSeedDirectRetrieval.js`).
- If serving-eligible but thin: the fix is **enrichment** (description/INCI), not re-ingest.

---

## Known caveats specific to WooCommerce / crawl onboarding

- **Read-only.** No `previewQuote`, `createOrder`, `refund`, or webhooks. Attribution redirects point at the store PDP URL, not a merchant-owned commerce rail. Anything requiring live checkout is the native-connector track.
- **Image-encoded descriptions / INCI gap.** Some stores render descriptions + ingredients as images (the Olive Young pattern). Those onboard thin → serving-eligible may fail on short_desc, and claims can't be substantiated. Needs INCI enrichment (Hwahae / INCIDecoder), tracked separately.
- **Marketplace-only brands** won't onboard here — use retailer-crawl instead.
- **Do not overstate coverage.** The `external_seed` path produces read-only catalog data. Audit/pitch copy must not claim a "native WooCommerce adapter." (An ANUKO audit output currently asserts a *verified end-to-end native WooCommerce/BigCommerce adapter* — that is false demo copy and should be removed before any customer sees it.)

---

## Rollback

External-seed rows are provenance-tagged and isolated under merchant id `external_seed`. To remove a bad ingest, delete/deactivate that brand's `external_seed` rows (they do not touch connected-merchant catalogs). No live commerce state is created, so rollback is data-only.
