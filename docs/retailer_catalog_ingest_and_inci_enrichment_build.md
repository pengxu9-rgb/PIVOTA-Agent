# Retailer-Catalog Ingest + INCI Enrichment — Build Doc

**Status:** scoped 2026-07-03, proofs done, not built. Ready to pick up.
**Goal:** get the Olive Young / @cosme long-tail brands into the commerce index as
per-market offers, and fill their moat (INCI-grounded claims) — so frontier agents
can find and cite them across markets.

---

## 1. Problem

Two questions drove this:
1. **How do we get the OY/@cosme brands in?** The domain-guess + Shopify
   `products.json` probe only catches brands running a US `.com`/`.us` D2C — a small
   minority. Most of the long tail sells *through* the retailer or via a Korean
   Cafe24/NAVER/`.co.kr` store, so they come back "unverifiable" and never land.
2. **How do we tag which markets each product is available in?** Needed so agents
   can recommend across markets (KR/JP/US). The offer model supports it; the identity
   resolution to collapse the same product across languages does not.

---

## 2. What's proven (artifacts on the working machine)

| Link | Proof | Verdict |
|---|---|---|
| Brand discovery | `~/Desktop/gemini-code-1783066349582.py` | Olive Young A–Z wall (2,069 K-beauty brands) + @cosme brandcollection (headless render) works. |
| D2C verification | same script, `verify_shopify_identity` | HEAD probe over-reports ~85%; only a `products.json` vendor-match confirms identity. |
| Tier-B acquisition | `scratchpad/oy_retailer_cohort.py` → `~/Desktop/oy_cohort_abib.json` | OY brand-grid → PDP yields identity + image + link + **price w/ dual currency** (¥2,716 / US$18.60). Schema-valid against the onboarder. |
| INCI source | `scratchpad/scout_inci*.py` | **INCIDecoder** = static HTML, full English INCI as text, brand-page walkable. K-beauty **head** deep; long-tail 404. |
| Enrich + join | `scratchpad/incidecoder_enrich.py` → `~/Desktop/oy_cohort_abib_enriched.json` | Matched SKU filled with a real 62-ingredient INCI list. **Match precision is the binding constraint** (see §5). |
| **Brand-direct harvest (PRIMARY path)** | `scratchpad/harvest_branddirect_cohort.py` → `~/Desktop/branddirect_cohort.json` | **PROVEN.** 4/5 brands → vendor-verified own stores (caraseoul/sllight/dermafix/cosrx); 28 products, schema-valid, **21/28 clear short_desc gate via real `body_html`** (the OY image gap is gone). |
| **Multi-market extension** | `scratchpad/harvest_branddirect_multimarket.py` → `~/Desktop/branddirect_multimarket_cohort.json` | **Built + store-level works** (sllight → discovers US + JP stores, emits per-market offers; anua.com/.us deduped 200→100 via shared handles). **BUT product-level cross-market join is BLOCKED** — sllight.us vs sllight.jp: **0 shared handles, 0 shared titles, no GTIN** → 0 products confidently linked across markets. See §5.5. |

---

## 3. Architecture

### 3.1 Acquisition strategy (decided 2026-07-03: BRAND-DIRECT PRIMARY)
Retailer-catalog crawl is OFF the table for the commercial index — OY & @cosme Terms
prohibit commercial reuse (§5.4). Revised strategy:
- **Brand-DIRECT D2C (PRIMARY).** For each discovered brand, find its OWN store and
  ingest from its public `products.json` → onboard with `offer_type="brand_direct"`.
  ToS-clean (the brand's own data), aligns with our get-cited value prop, and — bonus —
  a brand's own Shopify feed carries **text description (`body_html`) + variants**,
  which the OY image-encoded PDPs did NOT. Widen discovery beyond `.com`/`.us` to
  `.co.kr`/`.jp` + Cafe24 / NAVER SmartStore patterns (the old "Tier A"). Confirm
  identity with the `products.json` vendor-match already built in
  `~/Desktop/gemini-code-1783066349582.py` (`verify_shopify_identity`).
- **Retailers (OY/@cosme) = DISCOVERY SIGNAL ONLY.** Use them for brand *names* (facts)
  to know which brands exist; do NOT reproduce their catalog. Harvest already built.
- **Licensed / affiliate feeds (medium-term, optional).** If retailer-as-seller
  multi-market offers are strategically needed, get them via affiliate/partner feeds
  (which carry reuse rights) or a direct data partnership — not by crawling.

### 3.2 Market tagging = crawl-locale → offer
Olive Young Global **geo-localizes** currency+language (served ¥/JP, shipping country
JAPAN). So **the crawl locale IS the offer market.** Multi-market availability =
multi-locale crawl → one `catalog_offers` row per market (real `market` +
`price_currency`), all hanging off one `content_key`. The onboarder already preserves
the offer's real locale — do **not** force US/USD.

### 3.3 Identity: cross-lingual matcher (decided)
`content_key = make_content_key(brand, title, gtin)` (`services/catalog_identity.py:133`).
Missing GTIN → key = f(brand, normalized title) → **different-language titles
fragment into different keys.** To collapse KR/JP/US variants into one product:
- Crawl each product's **English name under the EN locale** (canonical identity),
  tag the offer market separately.
- Match on `(brand, product-line, size/variant)`. English INCI from INCIDecoder is a
  language-independent secondary anchor.

### 3.4 Content/moat is a SEPARATE pass
OY image-encodes `description` **and** full INCI (24 detail-images; INCI not in text).
So Tier-B is acquisition + market only. INCI comes from a decoupled enrichment pass
(matches backend design — `services/crawled_inci_ingest`, #855):
- **Primary:** INCIDecoder (English INCI, K-beauty head).
- **Fallback (tail/misses):** Hwahae 화해 (Korean JS app — needs headless + KR matching),
  brand-D2C PDP, or OCR on OY detail images.
- **Description:** still open — OCR or brand-D2C; lower priority than INCI.

---

## 4. Build plan

### Phase 1 — `scripts/harvest_branddirect_cohort.py` (BRAND-DIRECT)
Reuses the discovery + verification already built. Per discovered brand name:
1. **Find the brand's own store** — probe `.com`/`.us`/`.co.kr`/`.jp` + Cafe24 /
   NAVER SmartStore patterns for a public `products.json`.
2. **Verify identity** — `verify_shopify_identity` (vendor-match); onboard only
   CONFIRMED stores (empty beats wrong).
3. **Map `products.json` → cohort** — `offer_type="brand_direct"`, `market`/currency
   from the store locale (`/meta.json` or presentment), `title`/`description` from
   `body_html` (now REAL text, ≥50 chars → clears the short_desc gate), image, price.
   `raw_inci` still empty (products.json has no ingredients → Phase 2).
Emit `cohort.json` → `onboard_external_brand_from_crawl`.
- **ToS-clean:** the brand's own public store data. Rate-limit + honest UA anyway.
- OY/@cosme are used ONLY to supply the brand-name list (facts) that seeds step 1.

### Phase 2 — `scripts/enrich_inci_from_incidecoder.py`
Port `scratchpad/incidecoder_enrich.py`. Per cohort SKU: pull the brand's INCIDecoder
catalog (`/brands/{slug}`, paginate), fuzzy-match `english_title`, and on a
high-confidence **unambiguous** match, `fetch_inci` → write `raw_inci`. Feed the
existing `services/crawled_inci_ingest`. Queue misses for the fallback source.
- **Safe matcher (required):** threshold ≥ 0.82; ambiguity guard (reject if top-2
  within 0.06 and different products); variant-complete name. **Empty beats wrong** —
  wrong INCI pollutes the shared `content_key`.

### Phase 3 — onboard + verify serving
Run onboarder (`--file cohort.json`, then `--apply` with review). Walk the
serving-eligibility ladder: `quality<65 → short_desc<50 → entity_unresolved`
(the onboarder's `_resolve_pdp_scope` handles the last one). Note: description-empty
SKUs will fail `short_desc<50` until the description pass lands.

### Phase 4 — serve `available_markets`
Aggregate `DISTINCT offer.market` (+ per-market price/buyability) onto the served
record in `agent_pdp_view` / `find_products`. **No such aggregation exists in the
serve path today** — this is the piece that actually exposes cross-market
availability to agents.

---

## 5. Open risks

1. **Match precision (highest).** Naive fuzzy filled INCI from a *different* product
   at 0.46. Mitigate with the safe matcher (§4 Phase 2); the durable fix is a strong
   key — variant-complete EN names now, GTIN later (see `gtin-enrichment-scope`).
2. **Product-level INCI coverage.** INCIDecoder is head-only; individual products of
   covered brands can be absent (Abib "Hyaluronic Boom" line missing → 1/3 recall in
   the proof). Needs the fallback source.
3. **Description gap.** OY image-encodes it; SKUs stay below the `short_desc` serving
   gate until OCR or brand-D2C fills it.
4. **ToS.**
   - **INCIDecoder (checked 2026-07-03):** LOW legal risk. robots.txt permissive
     (`Allow: /`; only `/auth/`, `/products/recommend/` disallowed — our
     `/brands`,`/products`,`/search` allowed). **No ToS/Terms/Privacy page exists**
     (all standard URLs 404; footer = `Copyright 2026 | About` only). We take raw INCI
     (facts, not copyrightable) NOT their per-ingredient prose (their content). BUT
     it's a small indie project (founder Judit Rácz; partly USER-UPLOADED, manually
     checked "to make sure realistic" → not authoritative). Required posture:
     (a) rate-limit hard + cache permanently (INCI is static, fetch once);
     (b) HONEST bot UA `PivotaBot/1.0 (+contact)` — NOT the spoofed Chrome UA used in
     the scout; (c) email hello@incidecoder.com to disclose/ask (commercial use →
     right move, they invite contact + could partner); (d) attribution via
     `_inci_source_url`; (e) treat as candidate to verify, prefer brand-official INCI.
   - **Olive Young Global (checked 2026-07-03): RESTRICTED — commercial reuse
     prohibited.** robots.txt technically allows `/display`,`/product` (Crawl-delay 5),
     BUT 利用規約 (Terms, footer seq 48) Art.14② + prohibited-conduct item 2 EXPLICITLY
     bar using service information "by reproduction, transmission, publication,
     distribution, broadcast or ANY OTHER METHOD for COMMERCIAL PURPOSES, or letting
     third parties do so, without prior consent." IP asserted as company's. Crawling
     the OY catalog for our commercial index is against their ToU. (`.co.kr` also
     returns 403 anti-bot.)
   - **@cosme (checked 2026-07-03): RESTRICTED.** ToU (`/html/prv/rules.html`): no use
     "beyond personal private use," no 複製/publication, no 転載/再配布 (item 16), no
     営利/commercial activity (item 13); robots.txt blocks `/products/*context*schema.org*`.
   - **IMPLICATION — supersedes the "B then A" decision (§3.1):** do NOT crawl OY/@cosme
     product catalogs for the commercial index. Compliant paths: (a) **Tier A
     brand-direct D2C becomes PRIMARY** — the brand's OWN store data is ToS-clean and
     aligns with our value prop (help them get cited); (b) use OY/@cosme ONLY as a
     brand-DISCOVERY signal (brand *names* are facts) then acquire products from the
     brand-direct source; (c) pursue LICENSED/affiliate retailer feeds (they carry
     reuse rights) or a direct data partnership if retailer-as-seller market coverage
     is strategically needed. Needs user decision before any retailer-catalog build.
   - Quarantine everything as `SCAN_AGGREGATED`; gate serving/publishing on review.

---

### 5.5 Cross-market product join is the hard wall (measured 2026-07-03)
Store-level multi-market discovery works (probe all TLDs → find sllight.us + sllight.jp
→ per-market offers). But collapsing the SAME PRODUCT across a brand's regional stores
into one record with `available_markets=[US,JP]` is blocked:
- **No GTIN** — `barcode` empty on every store's `products.json`.
- **Handles independent** — sllight.us vs sllight.jp share 0 handles (separate Shopify
  backends).
- **Titles cross-lingual** — 0 exact-title overlap (English vs Japanese).
- **SKU schemes differ per region** — sllight.us `RNPTP001` vs sllight.jp `QP001`.

So brand-direct crawl yields per-market OFFERS but they land as separate single-market
products. Levers, updated with what's now been TESTED (sllight.us ↔ sllight.jp,
scratchpad/imagehash_join.py + translit_join.py):
1. **GTIN sourcing** (GS1/aggregators) — the only language-independent key; ~0% at
   source today (see `gtin-enrichment-scope`). THE clean unlock.
2. **JP→EN (LLM/MT) TRANSLATION + fuzzy match — the viable text path (recommended
   next).** The JP titles are katakana loanwords of the English (ネックパッチ="neck
   patch", アズレン="azulene"), so a real translation renders them to English and the
   match becomes trivial. NOT yet built (needs a translate call).
3. ~~Image-hash join~~ — **TESTED, FAILS.** Best cross-market image distance d=20 (≥24
   =unrelated) and the closest pairs are WRONG; stores use different regional
   photography. Dropped.
4. ~~Katakana transliteration (pykakasi) + string fuzzy~~ — **TESTED, INSUFFICIENT.**
   Phonetic romaji ("azuren supotto kontooru") is too far from English orthography:
   correct pairs score 0.43–0.50, a wrong pair scores 0.58 (shared "patch" token) →
   can't threshold safely. Transliteration alone ≠ enough; needs real translation (#2).
5. **Brand-supplied SKU map** — ask the brand directly (they know US-X = JP-Y).
Minor refinement also open: same-market duplicate domains (anua.com/.us) currently emit
2 offers per product — dedup to one canonical offer per (product, market).

## 6. Grounded entrypoints (pivota-backend)
- `scripts/onboard_external_brand_from_crawl.py` — cohort → serving_eligible (5 steps).
- `services/crawled_inci_ingest.py` (`ingest_crawled_inci_items`) — the shared INCI path.
- `services/catalog_identity.py:133` — `make_content_key(brand, title, gtin)`.
- `services/external_seed_servability.py` — `make_external_seed_servable`, quality payload.
- Related memory: `crawl-ingest-coverage-runbook`, `retailer-crawl-tierB-verdict`,
  `identity-resolution-deposit-gate`, `gtin-enrichment-scope`,
  `frontier-citation-publish-proof`.
