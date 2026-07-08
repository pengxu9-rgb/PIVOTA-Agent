# Trust & Identity — Full Build Plan (authoritative)

**Status:** authoritative build plan. Supersedes `trust_and_identity_track_scope.md` (precursor).
**Created:** 2026-07-01. **Owner track:** commerce-index moat.
**Rule:** build in phase order. Every PR names the phase-task it implements and how it moves a
success metric (below). No work outside the current phase without an explicit gate decision.

---

## 0. North Star (the anti-drift anchor)

> **Pivota is the commerce index a frontier agent reads *instead of crawling the open web*, because
> its product data is identity-anchored and every trust signal is provenance-backed and graded —
> merchant assertions are separated from independent corroboration, and only substantiated claims
> are credited.**

The one test every task must pass: **"Does this make an agent trust/cite Pivota's product data over
what it could reconstruct itself by crawling Amazon?"** If a task doesn't move that, it's out of scope
for this track.

## 1. Definition of Done (the served trust contract)

The target shape every serving product converges to. This is the concrete DoD — build toward it.

Per served product (`agent_pdp_view` → `/api/agent/pdp` + search), a typed **trust block**:

```
trust: {
  claims: [                      # ProductClaim (exists) — merchant/brand-asserted, GRADED
    { claim_text, source_ref, source_type, evidence_grade,
      substantiation_status: unverified|substantiated|flagged|rejected }
  ],
  review_state: observed|reviewed|flagged,           # EvidenceProfile (exists)
  independent_signals: [         # NEW — non-merchant corroboration (the missing half)
    { kind: citation|review|lab|cert,
      source_host, source_url, role, provider,
      independence: independent|first_party|competitor }
  ],
  cert_trust: { vegan_status, cruelty_free_status: verified|claimed|null },  # exists (beauty)
  disclaimers: [ { code, text, applies_to } ],       # exists
  identity: { gtin13|null, identity_confidence, anchor: gtin|fuzzy }  # gtin NEW
}
```

**Two invariants that define correctness (never violate — this is where drift kills the value):**
- **Separation:** merchant-asserted (`claims`) is never merged with independent (`independent_signals`).
  An agent must always be able to tell "the brand says" from "a third party corroborates."
- **Grading before credit:** a claim is only surfaced as *credited* (substantiated / reviewed) when
  evidence supports it. `endorsement ≠ substantiation`; `observed ≠ reviewed`. Ungraded = shown as
  unverified, never as fact.

## 2. Current state (prod-measured 2026-07-01) & reuse map

| Piece | State | Reuse in this track |
|---|---|---|
| Trust data model | `ProductClaim`/`EvidenceProfile`/`RequiredDisclaimer` well-designed | The DoD contract — extend, don't rebuild |
| Claim grading | `claim_safety` (statuses, `substantiated_claims`, disclaimers) exists but idle (3 reviewed) | Phase 1.2 grader |
| INCI→evidence | `crawled_inci_ingest` + `beauty_enrichment` + auto-refresh (#1095/#1093) | Feeds `claims` (observed) |
| Independent signal | `citation_observations` = **607 rows, product-keyed**, siloed for BD | Phase 1.1 — the un-wired pipe |
| Host classifier | `cited_host_classifier` exists | Phase 1.1 independence/credibility |
| Cert-trust | `vegan_status`/`cruelty_free_status` verified-vs-claimed modeled | Phase 1.4 surface |
| Identity/matching | content_key + matching layer (PR #1089) | Phase 2.3 GTIN anchor upgrades confidence |
| GTIN | **1 product; 10/18,953 SKUs carry a barcode** → sourcing gap | Phase 2 (external) |
| Reviews / lab | none | Phase 3 (net-new, licensing-gated) |

## 3. Scope guardrails (drift control)

**IN:** feeding the trust layer with independent evidence; grading claims; identity anchoring (GTIN);
the served trust contract above.

**OUT (explicitly — do not wander here):**
- More decision-signal refinement (freshness/buyability variants) — done, marginal now.
- The merchant-audit *product/UX* — it's the acquisition wedge; this track only consumes its exhaust.
- Checkout/transactability/charge — separate track, gated elsewhere.
- Coverage-breadth expansion (new verticals/brands) — separate coverage engine.
- Non-trust discovery (llms.txt/sitemap/feeds) — related but separate.

---

## 4. The plan (strict build order)

### PHASE 0 — Spike & measure (GATE, ~3–5 days)
*Goal: de-risk the three biggest assumptions before committing build. Measure-before-build.*

- **0.1 Citation-signal audit.** Per serving product: coverage of ≥1 `citation_observation`; distribution
  of `cited_host` × `host_type` × `citation_role` × `is_competitor`; how many hosts are *credible &
  independent* (editorial/licensed) vs social vs marketplace vs first-party. → coverage % + host taxonomy.
- **0.2 Grading-gap read.** Trace why 93 `observed` / 3 `reviewed`: is there a grader, or is `reviewed`
  only ever set manually? What evidence would auto-substantiate an INCI-derived claim? → the grading trigger.
- **0.3 GTIN sourcing spike.** Take ~30 head-brand products (Anua + top skincare). Test capture-at-crawl
  (do their JSON-LD/OG carry gtin/barcode we're dropping?) + external resolution (GS1 GTIN-Check gate,
  Barcode Lookup, UPCitemdb) hit-rate & accuracy & cost. → **go/no-go for Phase 2**.

**Exit gate:** citation coverage + host credibility known; grading trigger identified; GTIN viability decided.
If 0.1 shows citations are mostly non-credible/first-party, Phase 1.1 narrows to credible hosts only.
If 0.3 is no-go, Phase 2 defers and Phase 3 blocks (no anchor) — revisit.

### PHASE 1 — Wire the independent signal + grade what we have (~1–2 wk)
*Entry: 0.1 shows meaningful credible-citation coverage; 0.2 identified the grading trigger.*
*Goal: light up the trust layer using data we ALREADY collect. Biggest ROI, mostly reuse.*

- **1.1 `independent_signals` block.** Project `citation_observations` (host, role, evidence_url, provider,
  is_competitor) into `agent_pdp_view` + the served contract, typed as independent, with an
  `independence` + credibility grade via `cited_host_classifier`. Filter to credible hosts (per 0.1).
  *Reuse:* citation_observations, cited_host_classifier. *DoD:* served PDP shows independent corroboration
  separated from merchant claims.
- **1.2 Substantiation grader.** Wire `observed → reviewed` + `unverified → substantiated`: grade each
  merchant claim against available evidence — INCI actives support ingredient claims; credible independent
  citations support reputation/efficacy claims; cert authority supports vegan/cruelty claims. Everything
  else stays `unverified` (shown, not credited). *Reuse:* claim_safety, EvidenceProfile. *DoD:* substantiated
  claim count ≫ 3; grading is deterministic + auditable (basis recorded).
- **1.3 Serve the credited subset + independent block.** Extend `agent_pdp_v1` `_row_as_product` (already
  emits `evidence_claims`/`disclaimers`) + search path to serve `independent_signals` + graded claims.
  Honor the two invariants (separation; grading-before-credit).
- **1.4 Cert-trust surface.** Emit `cert_trust` (verified vs claimed) on served PDP.

**Exit gate:** % serving products with ≥1 credible independent signal rises from ~0 to ≥ [0.1 coverage];
substantiated-claim count up ≥ 10×; the served contract carries separated + graded trust. Verify live.

### PHASE 2 — Identity anchoring / GTIN (~3–4 eng-wk; GATED on 0.3 = go)
*Entry: 0.3 GTIN sourcing viable. Goal: the join key for external data fusion + reliable cross-seller dedupe.*

- **2.1 Capture-at-crawl (cheap first).** Fix crawlers/onboarders to extract gtin/barcode from JSON-LD/OG
  (we're currently dropping them → 10/18,953). Promote to `catalog_skus.barcode` → `pick_gtin13`.
- **2.2 External sourcing (head-first).** GS1 GTIN-Check gate + fuzzy aggregators for the head brands, with
  a hard validate gate. **A wrong GTIN is worse than none — it pollutes the shared content_key.** Fuzzy
  matches require a confidence gate + human review for the head.
- **2.3 Anchor into identity.** Promote to `agent_pdp_view.gtin13`; feed GTIN match into the matching layer
  to raise `identity_confidence` (GTIN-match → high confidence). Cross-seller offers sharing a GTIN merge.

**Exit gate:** GTIN coverage on head brands ≥ [target from 0.3]; GTIN-matched products reach
identity_confidence ≥ 0.85 (the claim-serve gate). No wrong-GTIN collisions (validate audit clean).

### PHASE 3 — Fuse independent evidence via the anchor (ongoing; licensing-gated)
*Entry: GTIN anchor at head coverage. Goal: the ungameable moat — signals a seller can't assert.*

- **3.1 License-first reviews.** Aggregate independent review sentiment/quality (licensed source), keyed
  by GTIN. *Business/legal licensing precedes engineering.*
- **3.2 Third-party ingredient/lab data.** Ingredient-safety / lab signals (e.g. INCI-keyed safety ratings),
  fused as independent, graded claims.
- **3.3 Fuse into the contract.** Land 3.1/3.2 as `independent_signals` (kind: review|lab) + upgrade claim
  grading where independent evidence now substantiates.

**Exit gate:** serving products carry independent review + lab signals at head coverage; the DoD contract
is fully populated for the head; the "why cite Pivota" test passes on a real category query.

---

## 4b. PHASE 0 RESULTS (measured 2026-07-01) — re-sequences the plan

Phase 0 ran and **overturned the assumed "P1 is the cheap first win" ordering.** All three trust/identity
INPUTS are thin — the moat is blocked by *data acquisition*, not plumbing.

- **0.1 Citations (gate for P1.1): FAIL as a coverage play.** Only **44/5,361 serving (0.8%)** have any
  citation; of 607 obs: **309 competitor, 228 retailer, 2 editorial**. Independent-credible signal is ~nil
  and capped by *audit* coverage (a separate engine). → **P1.1 DEFERRED** until audit coverage grows.
- **0.2 Grading (gate for P1.2): grader ALREADY EXISTS.** `beauty_evidence.derive_substantiated_claims` /
  `_inci_substantiated_claims` substantiate claims from `source="inci"` actives; `review_state` is hardcoded
  `observed` (never auto-`reviewed`). Input capped at **~215 beauty profiles (126 w/ evidence)**. → P1.2 is
  mostly BUILT; the gap is **INCI input coverage + evidence-type diversity**, not a grader.
- **0.3 GTIN: split verdict.** Source mix = 7,441 external_seed / 1,524 shopify / 20 wix. **Shopify: 4,796
  SKUs, 0 barcodes landed** despite `catalog_sync` reading `product.barcode` (written to `catalog_skus.barcode`
  only via a `strong_identifier` gate, l.1231) → **capture gap or empty-upstream — cheap to spike, potential
  near-term anchor.** external_seed (60% of catalog) lack barcodes at source → external sourcing (expensive).
  Forward name→GTIN still paid/gated (GS1 $6.5k/yr; free tiers reverse-only).

**Uncomfortable truth Phase 0 surfaced:** INCI ~215, citations ~44, GTIN ~0 — the moat's bottleneck is
INPUT DATA (ingredients, identifiers, independent evidence), i.e. acquisition engines, not wiring. Plan is
slower/heavier than "cheap-first P1" implied. Sequencing revised accordingly (below).

### Revised build order (evidence-driven)
1. **P2.1 — barcode capture spike + fix (FIRST).** Determine if Shopify barcodes are gated-out vs empty
   upstream; capture crawl JSON-LD/OG barcodes. Cheapest concrete identity-anchor gain. *(was Phase 2's first task)*
2. **P1.2 — grow INCI input coverage.** Extend ingredient extraction to more products; the grader already
   credits them. Grows substantiated-claim coverage. *(grader itself already done)*
3. **P2.2 — external GTIN** (gated/expensive) for the crawl slice.
4. **P1.1 — citations: DEFERRED** — revisit when audit coverage grows.
5. **P3 — reviews/lab via GTIN anchor** — after anchors exist.

## 4c. Reconciliation with Gemini's identity-architecture research (2026-07-01)

Read `~/Downloads/Pivota Agentic Commerce Architecture.md` (612 lines). It is an ambitious NORTH-STAR
(GS1 Digital Link canonical IDs, hybrid graph+vector DB / Neptune, SigLIP-2 multimodal entity resolution
+ Mahalanobis drift gating, registry bridging, merchant-native checkout, Web3 reputation/staking/slashing,
1M-product target). Reconciled against our reality (Postgres, fuzzy+LLM identity #1089, 5,361 serving beauty
products, GTIN≈0):

**VALIDATES our direction (adopt):**
- **GTIN / GS1 Digital Link is THE canonical identity spine** (`https://pivota.id/01/{gtin14}`), with all
  identifiers (upc/ean/jan/mpn/styleCode) collapsed under one node and multi-merchant offers hung beneath —
  i.e. our content_key→offers, but anchored on GTIN instead of fuzzy brand+title. Confirms Phase 2 is
  FOUNDATIONAL, not optional. Consider emitting a GS1 Digital Link URI as the canonical id (agent-discoverable, future-proof).
- **Mandatory GTIN validation** = GS1 check-digit + GS1 GEPIR prefix/ownership verification (anti-hijack).
  This IS our "wrong GTIN worse than none" gate — the doc gives the concrete mechanism (GEPIR router API).

**CONCRETIZES the hard Phase-2 gap (GTIN sourcing = registry bridging):**
- **Open Beauty Facts** (cosmetics sister of Open Food Facts): FREE, open-licensed, barcode→**INCI + identity**,
  free API (`/api/v2/product/{barcode}.json`, `/api/v2/search`) + nightly bulk JSONL/Parquet + 14-day deltas.
  **DUAL-PURPOSE: feeds Phase 2 (GTIN anchor) AND Phase 1.2 (INCI → the existing grader).** Highest-ROI
  extraction from the doc. Caveat: reverse (barcode→data); forward name→GTIN via their search + fuzzy match;
  K-beauty coverage is the open question → spike it.
- GS1 GEPIR (validate/anti-hijack, not forward-lookup); ASIN↔UPC/EAN cross-reference for the retailer slice.
- Beauty GTIN density in the wild ≈ **90%** per the doc → our ≈0% is a CAPTURE/SOURCING failure, not intrinsic
  absence. Reinforces P0's "we're dropping Shopify barcodes" — the identity ROI is real.

**ASPIRATIONAL — explicitly DEFER (anti-drift):** SigLIP-2 multimodal + Mahalanobis drift + Neptune graph
(our fuzzy+LLM matching is the pragmatic stand-in at beauty scale — do NOT chase GPU/graph infra ahead of
coverage); Web3 staking/slashing/reputation (orthogonal to the trust moat, far-future). Vertical note: the doc
picks 3C-electronics primary / cosmetics secondary, but we are ALREADY beauty-committed — stay there (90% GTIN
density makes it a good identity-anchoring vertical). The doc is a horizon, not a near-term build sheet; extract
the spine (GTIN/GS1 + registry bridging + validation) + the free accelerant (OBF), defer the heavy infra.

### P2.1 SPIKE RESULTS (2026-07-01) — external anchors are HEAD-only for our catalog
- **Barcode-at-ingest: low-yield.** Public Shopify `/products.json` omits `barcode` entirely (Admin-API-only;
  confirmed on ownist.com — not even in variant keys). The `extract_strong_identifier` gate is fine (accepts
  8/12/13/14-digit). The Shopify slice is effectively **one store (ownist.com)**; 60% of catalog is crawl
  (external_seed) with no barcode at source. So capture-at-ingest can't anchor the catalog.
- **Open Beauty Facts: real but thin for K-beauty.** Brand-index counts: CeraVe **71**, COSRX **4**, Anua **1**,
  Beauty-of-Joseon **0**; INCI inconsistent even when present; 0/15 on an indie-tail sample. Western mass covered,
  indie K-beauty ~absent.
- **Root cause:** GS1/OBF registries serve the MASS/STANDARD market; our catalog is INDIE K-BEAUTY — the segment
  they don't cover (the doc's ~90% density = *mass* cosmetics). External anchoring is a HEAD accelerant, low ceiling.

### RE-WEIGHTED direction (spike-driven)
- **GTIN/OBF = opportunistic HEAD enrichment only** (mass + famous K-beauty). Bounded effort; NOT the tail moat.
  Keep barcode capture only where cheap (Shopify Admin API for connected merchants). Defer paid GS1 US Data Hub.
- **ELEVATE P1.2 — INCI from the brands' OWN PDPs** (the #1095 crawl-INCI path) is the catalog-appropriate,
  growable evidence source for indie K-beauty, since external registries won't cover them. This is the durable moat work.
- **Fuzzy identity (#1089) stays the serving-adequate anchor for the tail** (GTIN is needed for external-data FUSION,
  which the tail can't get anyway → its absence is less costly than assumed).

### ⛔ OBF COVERAGE SPIKE RESULT (2026-07-01, MEASURED on the 83MB bulk dump vs our 8,966 products)
The research's "mainstream K-beauty/Western well-covered" claim is FALSE for our catalog. OBF = 65,836 products,
9,234 brands; skewed to European packaged skincare/food, thin on makeup + K-beauty. Per-product match CEILING
(optimistic min(ours,OBF)-per-brand) = **488/8,966 = 5%** (with INCI: 286 = 3%). Brand-level 40% is an illusion:
OBF has 1 Fenty (we have 863), 1 Tom Ford (464), 1 Sigma, 3 Kylie, 6 COSRX (120), 3 skin1004; our #1 brand moyu
(1,225) + Merit/Glossier/Rare Beauty/Saie MISS entirely. Only European skincare is real (Nuxe 63, The Ordinary 18).
**VERDICT: OBF is a dead end for our catalog on BOTH axes (GTIN ~5%, INCI ~3%) — do NOT build the OBF ingestion
pipeline.** By extension, external-registry GTIN anchoring (GS1/OBF-style) has a low ceiling for our catalog
composition (Western makeup + indie K-beauty, neither in the registries). SHELVE external GTIN anchoring; fuzzy
identity (#1089) stays serving-adequate (it needs no GTIN). Reinforces: the moat is the TRUST track (own-crawled
INCI + our own signals — executing), NOT external identity anchoring. Starting the spike in parallel was the right
call: it prevented building a ~5%-yield pipeline. dump: static.openbeautyfacts.org/data/openbeautyfacts-products.jsonl.gz (ODbL).

### Phase 2 OBF METHOD (refined by external research 2026-07-01, reviewed) — SUPERSEDED by the spike result above
ACCEPTED: (1) do NOT use the live OBF API (rate limits 15/min GET, 10/min search — confirmed empirically);
ingest the nightly `openbeautyfacts-products.jsonl.gz` (ODbL) and query locally with **DuckDB**
(`read_ndjson_auto`). (2) Forward match = normalize (strip volume/unit tokens, lowercase, isolate brand) →
brand-filter → lexical similarity (BM25 / Jaro-Winkler) → **confidence gate ≥0.85** (same threshold as our
identity/deposit gate); <0.85 → paid validation (GS1 US Data Hub). (3) GS1 check-digit + GEPIR for barcode-present.
CAVEAT ADDED (research under-weighted it): a name match ≥0.85 does NOT guarantee same FORMULATION — reformulated/
regional variants share a name but differ in INCI under a new barcode. OBF INCI must stay LOWER-AUTHORITY than
first-party PDP INCI (ADR-001 may_write already enforces this); use OBF INCI only where we have no first-party INCI,
else we risk minting substantiated claims off the wrong ingredient list ("wrong data worse than none").
UNVERIFIED CLAIM to test at Phase-2 entry: research asserts mainstream K-beauty is "highly indexed", but our
brands_tags API probe found COSRX 4 / Anua 1 / BoJ 0 — likely a messy-brand-tag artifact the bulk+fuzzy method fixes,
but MEASURE the real hit-rate of the bulk dump against our 212 brands before relying on it (measure-before-build).

### Phase 2 sourcing, updated by the above
2.1 barcode capture (Shopify gate + crawl JSON-LD) → 2.1b **Open Beauty Facts enrichment** (free: barcode→GTIN
confirm + INCI; also forward-match by brand+name) → 2.1c GS1 check-digit + GEPIR validation gate → 2.2 paid
head-brand forward lookup (GS1 US Data Hub) only for the residual. **P1.2 accelerates for free via OBF's INCI.**

## 5. Dependency graph (build order)

```
P0.1 citation audit ─┐
P0.2 grading gap ────┼─→ P1 (wire + grade)  ──────────────┐
P0.3 GTIN spike ─────┴─→ P2 (GTIN anchor) ─→ P3 (fuse reviews/lab via GTIN)
                              (P2 gated on P0.3=go; P3 blocked without P2 anchor)
```
P1 is independent of P2 (wire existing signal now); P3 depends on P2 (needs the anchor). Do P0 → P1 in
parallel-safe order, then P2, then P3.

## 6. Risks & mitigations

- **Merchant incentive corrupts neutrality** (get-cited = marketing). → Separation invariant + kill any
  pay-to-win ranking boost; independence flag on every signal; competitors' citations excluded from credit.
- **Endorsement mistaken for substantiation.** → Typed `kind` + `independence`; grading-before-credit invariant.
- **Wrong GTIN pollutes shared content_key.** → Validate gate (GS1 GTIN-Check), confidence threshold, head human-review.
- **Citation coverage too thin/non-credible** (P0.1 risk). → Gate P1.1 on credible-host coverage; if thin,
  P1 leans on grading (1.2) + cert-trust (1.4) first, re-audit citations as coverage grows.
- **Model/scope drift** (the stated concern). → This doc is authoritative; phase-gates; every PR cites a
  phase-task + metric; OUT-of-scope list enforced in review.

## 7. Success metrics (the scoreboard)

Primary (moat):
- **% serving products with ≥1 credible independent (non-merchant) trust signal** (today ~0).
- **% serving products with a stable identity anchor** (GTIN or identity_confidence ≥ 0.85) (today ~0 GTIN).

Secondary:
- # substantiated claims; % claims `reviewed` vs `observed` (today 3 / 96).
- cert-trust coverage (verified vs claimed).
- head-category "why cite Pivota" pass: on a real category query, does the served set carry
  separated + graded + independently-corroborated + anchored trust.
