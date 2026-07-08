# External GTIN-Enrichment Pipeline — Scope & Recommendation

**Status:** Scoping (not yet built)
**Date:** 2026-06-30
**Repos:** `pivota-backend` (Python writeback) + `PIVOTA-Agent` (Node identity re-resolve)
**Author context:** commerce-index / `citation_observations` identity track

---

## TL;DR / Recommendation

**Build it, but sequence it AFTER the fuzzy-match-to-anchor track is solid, and scope it to the branded head only.**

GTIN enrichment is a real **accelerant** on cross-retailer identity, not a foundation. Three facts drive that verdict:

1. **The authoritative forward source is US-only and walled; everything else is fuzzy.** GS1's *global* surfaces (Verified by GS1 / GRP / GTIN Check / GEPIR) are **validation-only** — you query *with* a GTIN to confirm it's licensed to a brand; no name→GTIN search. The **one** authoritative forward (name→GTIN) lookup in the GS1 ecosystem is the **GS1 US Data Hub Product API** (wildcard search on BrandName/CompanyName/ProductDescription), but it covers only **~45M US-licensed** products and sits behind GS1 US membership + a **~$6,500/yr API add-on**. Outside that US-licensed slice, obtaining a GTIN from brand+title forces us onto third-party aggregators (Barcode Lookup, UPCitemdb), which did the *same* fuzzy product-identification match we're trying to escape — patchy coverage, real false-match risk.

2. **It only reaches the head.** Well-known branded products (COSRX, PIXI) exist in external registries. Long-tail, private-label, and dropship listings ("dog onesie", unbranded lingerie) are in **no** GTIN database and cannot be enriched at any price. This is an accelerant on the head, never a replacement for the `official_url`-anchored canonical brand catalog.

3. **A wrong GTIN is worse than no GTIN.** `make_content_key(brand, title, gtin)` folds the GTIN into the key ([catalog_identity.py:133](../pivota-backend/services/catalog_identity.py)). A false GTIN doesn't just fail to help — it mints a *different* `content_key`, **splitting** a cluster that should merge (or mis-merging two distinct products). Because `content_key` is the shared cross-merchant clustering anchor, pollution propagates. This mandates a two-stage design: cheap aggregator lookup → **authoritative GS1 validation** → only then write back.

**Net:** worth building as a bolt-on enrichment job once the anchor track lands. Estimated **~3–4 eng-weeks** for a production v1 (provider integration + two-stage validation + writeback + re-resolve trigger + observability), excluding provider contract/onboarding lead time. Do **not** build it first — it depends on the anchor foundation it accelerates, and its marginal lift over a well-anchored head product is incremental, not categorical.

---

## 1. Why GTIN matters here (grounded in the actual seams)

A GTIN raises identity confidence at two distinct gates, both verified in code:

**Python deposit gate** — `resolve_deposit_content_key` ([catalog_identity.py:220](../pivota-backend/services/catalog_identity.py)):
- Basis precedence: **`gtin` (confidence 1.0, always depositable)** → `identity_high_conf` (≥0.85) → `reviewed` → `unresolved` (not depositable).
- A GTIN is the *strongest* basis — it bypasses the 0.85 threshold entirely (`_DEPOSIT_MIN_CONFIDENCE_DEFAULT = 0.85`, env `CONTENT_KEY_DEPOSIT_MIN_CONFIDENCE`).

**Node identity confidence** — `computeIdentityConfidence` ([pdpIdentityGraph.js:1321](src/services/pdpIdentityGraph.js)):
```js
let score = sourceTier === 'brand' ? 0.6 : 0.42;
if (strongIdentity?.gtins?.length > 0) score += 0.2;   // GTIN bonus
if (strongIdentity?.official_url)      score += 0.12;
// ...
```
- A GTIN adds **+0.2**. An external-seed product (base 0.42) clears 0.62; with `official_url` too it clears the 0.85 deposit gate cleanly.

**Cross-seller clustering** — `buildSoftExactClusterKey` ([pdpIdentityGraph.js:1630](src/services/pdpIdentityGraph.js)) clusters on `brand_norm | title_core_norm | axis_signature`, but GTIN is decisive in two ways:
- **Conflict guard:** two listings in the same soft cluster with >1 distinct GTIN are flagged `review_required: 'conflicting_gtin'` and **do not merge** — protecting against bad merges.
- **GTIN-keyed grouping:** matched-by-GTIN listings group on `gtin:<sorted-gtins>` as the `sellable_item_group_id`, so multiple retailers selling the same physical product land in one served PDP.

**The well is dry at the source.** Barcode capture is already fully wired (Shopify variant `barcode` → `StandardProductVariant.barcode` at [product_adapters.py:539](../pivota-backend/adapters/product_adapters.py) → `products_cache.product_data` → `catalog_skus.barcode` via `extract_strong_identifier` at [catalog_sync_service.py:1197](../pivota-backend/services/catalog_sync_service.py) → `make_content_key` at [catalog_sync_service.py:931](../pivota-backend/services/catalog_sync_service.py)). The plumbing works; merchants just don't fill `barcode` in Shopify. **0 of 5,229** connected-merchant SKUs and **10 of 12,687** external-seed SKUs carry a barcode. External lookup is the only fill path.

---

## 2. The bottleneck: forward (name→GTIN) lookup

This is the crux. The forward-search landscape splits into one **authoritative-but-walled US lane** and a **fuzzy-but-global aggregator lane** — and the global authoritative registry can only *validate*, never look up.

| GS1 surface | name+brand → GTIN? | Coverage | Access |
|---|---|---|---|
| **GS1 US Data Hub Product API** | **YES** — wildcard `Search` on BrandName / CompanyName / ProductDescription | ~45M **US-licensed** only (395M for GTIN-in) | GS1 US member + View/Use sub + **~$6,500/yr** API add-on |
| Verified by GS1 / GRP (global) | **No** (GTIN-in verify; "Find Company" by name only) | 300M+ products, 2M+ companies, 120+ countries | Free 30/day; enterprise API member-gated |
| GS1 UK GTIN Check API | **No** (batch-validate GTINs you hold) | global registry passthrough | partner-gated, API key |
| GEPIR / Company DB | **No** (GTIN/company-name → company) | 2M companies | 30 free/day |

**Implication.** For the **US-licensed branded head**, GS1 US Data Hub is the ideal primary — it's *both* forward lookup *and* issuer-of-record validation in one call (no separate gate needed), at the cost of a US-only scope and a ~$6,500/yr wall. For everything outside that slice (non-US brands, K-beauty like COSRX, anything not licensed through GS1 US), forward resolution must come from **aggregators** (Barcode Lookup, UPCitemdb) that themselves did a fuzzy match to assign the GTIN — so we inherit their error rate and **must** treat their output as a *candidate*, validated through GS1 GTIN-Check before writeback (§4).

---

## 3. Provider evaluation

Focused on the decision-critical axis — **forward (name→GTIN) search** — plus coverage on a branded beauty/consumer-goods head, false-match risk, and cost.

| Provider | name→GTIN forward search | Coverage (head/long-tail) | False-match risk | Cost model | Role in our design |
|---|---|---|---|---|---|
| **GS1 US Data Hub Product API** | **Yes** — wildcard `Search` on BrandName / CompanyName / ProductDescription | **~45M US-licensed only** (US geo); authoritative | **Lowest** (issuer of record) | GS1 US member + View/Use sub ($500–$2,500/yr) + **~$6,500/yr API add-on** | **Authoritative primary for the US-licensed head** — forward lookup *and* validation in one |
| **GS1 Verified by GS1 / GTIN Check API (global)** | **No** (validation only) | Authoritative for *registered* GTINs; brand-licensee truth | Lowest | Member/partner API; batch validation (thousands real-time) | **Validation gate** for aggregator candidates — confirm GTIN is licensed to the matched brand |
| **Barcode Lookup API** | **Yes, strongest** — multi-field (Name + Brand + Manufacturer + MPN + Category, combinable) | "Hundreds of millions"; head-strong, rich attrs | Medium — multi-field constraint lowers it materially | **$99/mo entry**, higher tiers quote-only; **billed only on hit (HTTP 200)**; 100 req/min | **Primary forward lookup for non-US / non-DataHub** head (candidate generation) |
| **UPCitemdb** | **Yes** — `/search` (phrase + brand + category only) | ~700M UPC/EAN (largest); decent head, long-tail gaps | Medium — coarser params, harder to disambiguate | Free (~20–40 searches/day); **DEV $99/mo** (2k searches/day); PRO $699/mo; overage ~$0.03/10 | **Secondary** forward lookup / **cross-source agreement** |
| **Icecat (Open + Full)** | **No free-text name search** — keyed by GTIN or **Brand + MPN** only | 18–29M datasheets but **electronics/IT-heavy; beauty thin** | Low (brand-approved) but unusable without an MPN we lack | Open free; Full €350–€3,500/mo | **Marginal** — only a corroborator when we already hold an MPN; weak on K-beauty |
| **Google Shopping via SerpAPI / SERP scrapers** | Two-step (search → product_id → Specs `…gtin`); GTIN often absent | Very broad but GTIN field inconsistent | **High** — fuzzy ranking, wrong-result risk | ~$0.018–$0.05 per resolved GTIN. **⚠ Active Google v. SerpApi suit (Dec 2025, unresolved Jun 2026) = vendor/ToS risk** | **Avoid for v1**; last-resort corroboration only |
| **Syndigo / Salsify / 1WorldSync / NIQ Brandbank (GDSN)** | **No** — own-catalog / approved-recipient scoped | Deep CPG/FMCG where brands publish | Low | Enterprise GDSN (~$25k–$200k+/yr) + GLN onboarding | Out of scope (wrong tool — manages *your* catalog, not third-party discovery) |
| **Open data (Open Beauty Facts, Wikidata)** | Partial / SPARQL | OBF ~66K beauty (Euro/food skew, **K-beauty sparse**); Wikidata **~2,279 GTINs total** | Low but negligible coverage | Free (ODbL / CC0) | Negligible; optional offline corroborator via OBF Parquet dump |

**Read:** there are **two** viable forward lanes. (1) **GS1 US Data Hub** is authoritative and self-validating but **US-licensed-only** and behind a ~$6,500/yr wall — best for the US head. (2) **Barcode Lookup** (primary) + **UPCitemdb** (secondary, for cross-source agreement) cover the global/K-beauty head fuzzily and **must** be validated through GS1 GTIN-Check before writeback. Icecat (no name search, beauty-thin), the GDSN networks (own-catalog only), SerpAPI (litigation + false-match), and open data (negligible coverage) are all eliminated from the core path.

---

## 4. The false-GTIN problem and the two-stage defense

Because a wrong GTIN actively pollutes the shared `content_key`, candidate GTINs must clear a verification bar before writeback. Layered defense — **routed by lane**:

0. **Lane A (US-licensed head): GS1 US Data Hub.** If the brand is GS1-US-licensed, query the Data Hub Product API directly — it returns an issuer-of-record GTIN *with* the licensee block, so steps 1–2 collapse into one authoritative call (no aggregator, no separate validation). Highest precision; use first where available.
1. **Lane B (everything else): aggregator forward lookup** (Barcode Lookup primary; UPCitemdb secondary) → 0..N candidate GTINs for `(brand, title)`.
2. **Brand-licensee validation via GS1 GTIN-Check** — for each Lane-B candidate, confirm the GTIN is *licensed to the matched brand*. This is GS1's global strength and it directly kills the dangerous case (right product name, wrong/recycled GTIN owned by another company).
3. **Cross-source agreement** — accept only when ≥2 independent sources return the *same* GTIN, OR GS1 confirms brand-licensee match. Single-source, unvalidated candidates are **quarantined**, not written.
4. **Image corroboration (optional, phase 2)** — when brand+title is ambiguous, compare the product image (we already have it) against the provider's image as a tiebreaker before accepting.
5. **Conflict guard already exists** — if writeback would introduce a GTIN conflicting with an existing cluster member, `conflicting_gtin` review flips on ([pdpIdentityGraph.js:1638](src/services/pdpIdentityGraph.js)). Route to human review rather than auto-merge.

**Confidence policy:** only candidates that pass (2) or (3) get written to `catalog_skus.barcode` + `products_cache`. Everything else lands in a `gtin_enrichment_candidates` staging table with a status, never touching the live `content_key`.

---

## 5. Pipeline architecture

```
[1] Select head candidates        (Python, pivota-backend)
      catalog_skus WHERE barcode IS NULL
        AND brand IS NOT NULL AND identity_confidence >= brand-tier
        AND product is "head" (known brand allowlist / official_url anchored)
            │
[2] Forward lookup                 (new provider client: services/gtin_enrichment/)
      Lane A (GS1-US-licensed brand): GS1 US Data Hub Search → authoritative GTIN+licensee
      Lane B (else): Barcode Lookup (name+brand+mfr) → candidates
                     UPCitemdb /search             → candidates
            │
[3] Validate + agree
      Lane A: already authoritative (skip)
      Lane B: GS1 GTIN-Check: candidate → licensed-to-brand?
              require GS1-pass OR ≥2-source agreement
      → stage in gtin_enrichment_candidates (status: confirmed | quarantined | conflict)
            │
[4] Writeback (confirmed only)
      catalog_skus.barcode = <gtin>                       (catalog_sync_service path)
      products_cache.product_data.barcode / variants[].barcode
      content_key = make_content_key(brand, title, gtin)   (RECOMPUTE)
      → triggers refresh_agent_pdp_view_for_content_key
              + recompute_serving_eligibility  (already fires on content_key change)
            │
[5] Re-resolve identity            (Node, PIVOTA-Agent)
      POST /api/admin/pdp-identity/backfill
        { external_product_ids: [...] }   ← NEW param (endpoint extension needed)
      → backfillPdpIdentityGraph re-reads catalog_products.content_key,
        recomputes identity_confidence (+0.2 GTIN), re-clusters,
        writes pdp_identity_listing
            │
[6] Observe
      count: candidates found / validated / written / conflicts
      content_key_basis transitions: unresolved → gtin
      deposit-gate pass-rate delta on the enriched cohort
```

**Plumbing notes from the code seams:**
- **Writeback is two-surface.** `catalog_skus.barcode` (normalized via `extract_strong_identifier`) AND `products_cache.product_data` (the JSON the Node side reads for internal products). `content_key` recompute already triggers `refresh_agent_pdp_view_for_content_key` + `recompute_serving_eligibility` ([catalog_sync_service.py:1461+](../pivota-backend/services/catalog_sync_service.py)) — reuse, don't rebuild.
- **`catalog_skus.barcode` is NOT indexed** (`VARCHAR(128)`, [catalog.py:195](../pivota-backend/db/catalog.py)). The selection query in [1] filters on `barcode IS NULL` over the whole table — add a partial index `WHERE barcode IS NULL` if the batch job is slow.
- **The Node re-resolve trigger needs a small extension.** `backfillPdpIdentityGraph` already accepts `externalProductIds` ([pdpIdentityGraph.js:5054](src/services/pdpIdentityGraph.js)) but the HTTP endpoint hardcodes `{limit, brand, dry_run}` and doesn't pass it through. ~10-line change to plumb `external_product_ids` through `POST /api/admin/pdp-identity/backfill`.
- **Internal vs external read-path asymmetry.** Node reads external-seed `content_key` via a `LEFT JOIN catalog_products` (picks up our writeback automatically); for **internal** `products_cache` products the GTIN must be embedded in `product_data` JSON (no barcode column on the cache). Writeback step [4] must update both or internal products won't re-resolve.

---

## 6. Effort breakdown (production v1)

| Phase | Work | Est. |
|---|---|---|
| **P0 — Provider spike** | Sign up Barcode Lookup + UPCitemdb (instant); start GS1 US Data Hub membership + API add-on (slow); measure real coverage & precision on a 200-SKU labeled head sample (COSRX/PIXI/etc.), **per lane** (how much of our head is GS1-US-licensed vs needs aggregators); kill-or-go | 3–4 d (+ GS1 onboarding lead time, async) |
| **P1 — Forward-lookup client** | `services/gtin_enrichment/providers/` (Lane A: GS1 US Data Hub; Lane B: Barcode Lookup + UPCitemdb), brand→lane routing, normalization to candidate set, rate-limit/retry/cache | 4–5 d |
| **P2 — Validation + staging** | GS1 GTIN-Check client; cross-source agreement; `gtin_enrichment_candidates` table + status machine; conflict routing | 3–4 d |
| **P3 — Writeback** | Dual-surface write (`catalog_skus` + `products_cache`), `content_key` recompute, reuse existing APV/serving recompute; partial index | 2–3 d |
| **P4 — Re-resolve trigger** | Extend `/api/admin/pdp-identity/backfill` for `external_product_ids`; batch driver Python→Node; idempotency | 2 d |
| **P5 — Observability + batch runner** | Metrics (found/validated/written/conflict, basis transitions, deposit-pass delta), backfill job, dashboards | 2–3 d |
| **P6 (optional) — Image corroboration** | Image-match tiebreaker for ambiguous candidates | 3–5 d |
| **Total v1 (P0–P5)** | | **~4 eng-weeks** + provider onboarding lead time |

**Provider $ floor (annual, v1):** Barcode Lookup ~$99/mo + UPCitemdb DEV $99/mo ≈ **$2.4k/yr** for the aggregator lane; GS1 US Data Hub adds **~$7k/yr** (View/Use sub + API add-on) *if* Lane A is worth it. The P0 spike's per-lane coverage split decides whether the GS1 US wall pays for itself or we run aggregator-only.

---

## 7. Whether / when — relative to the fuzzy-match-to-anchor track

**The anchor track is the foundation; GTIN is the accelerant. Order matters.**

- The `official_url`-anchored canonical brand catalog already drives identity confidence for the head **without** an external dependency (brand-tier base 0.6 + `official_url` +0.12 + soft-identity signals clears the 0.85 deposit gate). For a well-anchored head product, GTIN's marginal lift is to harden basis from `identity_high_conf` → `gtin` (1.0) and to strengthen cross-seller GTIN-keyed merge. Real, but **incremental** — not the difference between "callable" and "not callable."
- GTIN enrichment **inherits the anchor track's product-identification problem** (you must identify the product to look up its GTIN). If the fuzzy match is wrong, the GTIN lookup is wrong too — and now it's a *validated-looking* wrong answer polluting `content_key`. Building GTIN enrichment on a weak anchor amplifies error.
- The long-tail / private-label majority — the bulk of the dry well — is **unreachable** by any GTIN provider. The anchor track is the only thing that serves them.

**Recommended sequence:**
1. **Land the fuzzy-match-to-anchor foundation first** (canonical brand catalog, `official_url` anchoring, confident soft-identity clustering). This serves head *and* long-tail.
2. **Run the P0 spike in parallel** (cheap, mostly provider onboarding + a measurement on labeled head SKUs) to get real coverage/precision numbers before committing build time.
3. **Build P1–P5 once the anchor is solid**, scoped to the branded head, as a confidence *hardening* layer — GTIN raises the highest-value head clusters to basis=`gtin` and locks cross-seller merges via the conflict guard.
4. **Defer P6 (image corroboration) and enterprise GDSN providers** until volume/precision data justifies them.

**Decision gate (from P0):** proceed to build only if the spike shows, on the head sample, **≥60% forward-lookup coverage at ≥95% post-validation precision**. Below that, the pollution risk and provider cost outweigh the incremental confidence lift, and effort is better spent on the anchor track.

---

## Open questions / dependencies
- **Two distinct GS1 entitlements** — (a) **GS1 US Data Hub Product API** for Lane-A forward search (membership + View/Use sub + ~$6,500/yr add-on; 60-day API trial exists — use it in P0); (b) **GTIN-Check** (GS1 US/UK) for Lane-B candidate validation. Confirm both entitlements and per-query terms. GS1 onboarding is the long-pole; start in P0.
- **Per-lane coverage of our head** — what fraction of our branded head (COSRX/PIXI/etc.) is GS1-US-licensed (Lane A) vs needs aggregators (Lane B)? K-beauty is likely *not* US-licensed → Lane B heavy. P0 must measure this; it decides whether the GS1 US wall is worth paying.
- **Head allowlist definition** — what marks a product "head" for selection in step [1]? Reuse the brand-tier / `official_url`-anchored signal rather than a hand-maintained brand list.
- **Provider ToS** — confirm Barcode Lookup/UPCitemdb terms permit storing returned GTINs in our catalog (most do; verify). Keep SerpAPI out given the active Google litigation.
- **Re-resolve batch safety** — the Node endpoint is admin-gated; confirm the Python→Node batch driver authenticates and is idempotent under retry.

---

### Source references
- **GS1 US Data Hub Product API** — the one authoritative forward (name→GTIN) search; wildcard on BrandName/CompanyName/ProductDescription, ~45M US-licensed: [developer portal user guide PDF p.11](https://documents.gs1us.org/adobe/assets/deliver/urn:aaid:aem:351f9e7c-390c-4140-8a6f-afc57146bf10/gs1-us-data-hub-view-use-api-developer-portal-user-guide.pdf), [gs1us.org APIs](https://www.gs1us.org/tools/gs1-us-data-hub/gs1-us-apis), [help.gs1us.org product view/use](https://www.help.gs1us.org/product-view-use)
- GS1 Verified by GS1 / GRP (global, validation-only): [gs1.org/services/verified-by-gs1](https://www.gs1.org/services/verified-by-gs1)
- GS1 UK GTIN Check API (batch validate licensed GTINs): [gs1uk.org GTIN Check API](https://www.gs1uk.org/standards-services/data-services/gtin-check-api)
- Barcode Lookup API (multi-field search; $99/mo entry, billed on hit): [barcodelookup.com/api](https://www.barcodelookup.com/api), [API docs](https://www.barcodelookup.com/api-documentation)
- UPCitemdb `/search` (free ~20–40/day, DEV $99/mo = 2,000/day, PRO $699/mo): [upcitemdb.com/api](https://www.upcitemdb.com/api), [devs.upcitemdb.com](https://devs.upcitemdb.com/)
- Icecat (no free-text name search; identifier-keyed, electronics-heavy): [icecat.com](https://icecat.com/), [JSON request manual](https://iceclog.com/manual-for-icecat-json-product-requests/)
- Google Shopping via SerpAPI (two-step, GTIN inconsistent; ⚠ active Google v. SerpApi litigation Dec 2025): [serpapi.com/google-product-api](https://serpapi.com/google-product-api), [Google lawsuit](https://blog.google/technology/safety-security/serpapi-lawsuit/)
- GDSN networks (own-catalog only): [Syndigo CXH](https://docx.syndigo.com/cxh/docs/product-search-by-gtins), [Salsify retrieve products](https://docs.supplierxm.salsify.com/docs/retrieve-product), [1WorldSync Content1](https://community.1worldsync.com/t5/Content1/API-Content1-Product-Search-API-Guide/ta-p/939)
- Open data (negligible coverage for our catalog): [Open Beauty Facts](https://world.openbeautyfacts.org/), [Wikidata P3962](https://www.wikidata.org/wiki/Property:P3962)
