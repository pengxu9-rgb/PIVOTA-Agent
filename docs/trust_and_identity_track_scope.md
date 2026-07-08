# Trust & Identity — the next major track (scope)

**Decided 2026-07-01.** After a holistic review of the commerce-index architecture, the
verdict: the *skeleton* is right (identity resolution → offer aggregation → serving
pipeline → decision signals: freshness, buyability). The *moat* — grounded, independent,
substantiated trust at coverage, anchored to a stable identity — is ~2% built. This track
builds the moat. It is what answers "why would a frontier model read Pivota instead of
crawling the open web itself?"

## Grounding (prod-measured 2026-07-01)

- Coverage: 8,986 products, 5,361 serving, 212 brands — beauty-narrow (75% no `category_kind`; skincare-dominant).
- Offers/price: 15,232 offers, 96% priced. The commerce plumbing is real.
- **Trust layer: 96 of 6,099 PDPs (1.6%) have `evidence_profile`; of those, 93 `observed` vs only 3 `reviewed`.** The substantiated moat is ~3 products.
- **Identity anchor: GTIN on 1 product. Only 10 of 18,953 SKUs carry a barcode** → sourcing gap, not a promotion gap.
- **Independent signal already collected but siloed: `citation_observations` = 607 rows, product-keyed** (`content_key`, `product_key`, `provider`, `cited_host`, `host_type`, `citation_role`, `evidence_url`, `is_competitor`). Gathered by the merchant audit, used for BD — NOT surfaced as agent-read product trust.

## The reframe

The independent-trust signal an agent needs is *partly already being produced* by the audit
(third-party citations, product-linked). The gap is that it's a decision-support product for
merchants, not a data pipe into the agent-read trust layer. So the cheapest, highest-leverage
first move is to **wire what we already collect**, not to build net-new sourcing first.

Two honest distinctions to hold:
- **Endorsement ≠ substantiation.** "Cited by Allure for 'best vitamin C serum'" substantiates
  *reputation/relevance*, not a specific factual claim ("20% L-ascorbic acid"). Both are trust
  signals; keep them typed distinctly.
- **Observed ≠ reviewed.** Ingesting evidence (INCI → claims) is not grading it. The moat is the
  *grading/substantiation* step, which is barely exercised (3 reviewed).

## Phases (cheap-first)

### Phase 0 — spike/measure (days)
Confirm the reuse assumptions at depth before building: (a) citation_observations coverage per
serving product + host/role distribution (how many serving products have ≥1 independent citation,
and are the hosts credible/licensable); (b) the INCI→evidence path (#1095) — what stops `observed`
becoming `reviewed`; (c) GTIN sourcing spike (does GS1 / Barcode Lookup / UPCitemdb resolve our
head brands — the gtin-enrichment-scope P0 spike). Gate Phase 2 on (c).

### Phase 1 — wire the independent signal we already have (1–2 wk)
- Surface `citation_observations` as a typed **independent-endorsement** block on the served PDP
  (host, role, evidence_url, provider) — distinct from `evidence_profile` (merchant-asserted).
  Turns the audit exhaust into agent-read trust. Directly re-aligns the audit with the index.
- Add the **substantiation/grading** step so INCI/authored evidence moves `observed → reviewed`
  with a basis, instead of sitting ungraded. This exercises the claim_safety moat that already exists.
- Reuse: `citation_observations` (607, product-keyed), `claim_safety` grading model, the evidence
  auto-refresh (#1093), `crawled_inci_ingest`/`beauty_enrichment` (#1095).

### Phase 2 — identity anchoring (GTIN) (3–4 eng-wk, gated on Phase 0c)
- External GTIN sourcing (GS1 US Data Hub for licensed forward-lookup; fuzzy aggregators +
  GS1 GTIN-Check gate for the non-US/K-beauty head). Promote to `agent_pdp_view.gtin13`.
- Value: the join key to fuse independent datasets (reviews, lab/ingredient safety keyed by
  GTIN/UPC) and to dedupe cross-seller reliably (today identity leans on fuzzy brand+title).
- Risk (memory): a WRONG GTIN is worse than none — it pollutes the shared content_key. Validate-gate hard.

### Phase 3 — fuse independent evidence via the anchor (ongoing)
- License-first review aggregation (independent sentiment/quality) + third-party ingredient/lab
  data, keyed by GTIN. This is the durable moat: signals a seller cannot assert or game.
- Business/legal step (licensing) precedes engineering here.

## What this is NOT
- Not more decision-signal refinement (freshness/buyability are done and correct, but marginal
  against a 1.6% trust layer).
- Not the merchant-audit product itself — that's the acquisition wedge; this track makes its
  exhaust feed the index.

## Success metric
Move from "structured product+price records an agent could reconstruct by crawling retailers" to
"grounded, independently-corroborated, identity-anchored product decisions" — measured as % of
serving products carrying ≥1 independent (non-merchant) trust signal, and % with a stable identity anchor.
