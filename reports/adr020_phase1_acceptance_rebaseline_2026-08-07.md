# ADR-020 Phase 1 — acceptance corpus re-baseline

**Date:** 2026-08-07
**Status:** needs an owner's decision (items marked ❱ DECISION)
**Supersedes:** `tests/fixtures/adr020_phase1_gap_scope.json` @ 2026-07-30 (15 gap queries / 71 products)

---

## TL;DR

The Phase 1 acceptance target was measuring the wrong thing. It recorded a **parity
diff** — everything the seed lane returned that the catalog lane did not — with **no
relevance judgement attached**, over a **generic multi-category query corpus** replayed
against a beauty-only catalog. Roughly 40% of its queries had no correct answer in the
data at all, so seed-lane substring noise became acceptance targets.

**A second instrument defect was found while re-measuring** (see §6). The harness never
passed `tokenMatch`, which `fetchCanonicalChainRows` defaults to `false` while every
production caller enables it. So the original baseline — and this report's own first
draft — measured a lane configuration **prod does not serve**, with the `+25`/token rank
arm permanently dark. All numbers below are measured with the lane configured as prod
serves it (`token_match: true`, recorded in every report).

Re-measured in-domain, with an explicit relevance rubric applied to **both** lanes:

- **The catalog lane is clearly ahead.** Precision@8 **75.0% vs the seed lane's 58.5%**,
  filling **184** result slots to the seed lane's **135**. It returns more relevant
  answers on **15 of 23** measured queries and ties on 6 — it is behind on **2**.
  On "mascara", "lipstick" and "matte lipstick under $30" the seed lane returns
  *nothing* relevant and the catalog lane returns a clean 8.
- The "6 of 71 gap products returned" panic reading was an artifact. The genuine
  acceptance target is **2 queries / 14 products**, not 15 / 71.
- **53** of the old corpus's products are graded irrelevant — tuning rank to return them
  would degrade results. A further **50** are relevant but *substitutable*: the catalog
  lane already returns equally-relevant different products for those queries.
- Coverage is **not** the problem: 337 concealers, 501 foundations, 292 fragrances and
  88 mascaras are live in the US catalog. The failures are ranking, not inventory.
- One real deficit remains, and it is narrow: **"lightweight gel moisturizer for
  acne-prone skin"** (seed 8, catalog 4). One further query, "moisturizer", is behind by
  a single product and sits inside pass-to-pass noise.

---

## 1. What was wrong with the old corpus

Two independent defects, compounding.

**Provenance.** `scripts/audit-recall-lane-parity.cjs` defaulted to
`/Users/pengchydan/dev/pivota-agent-ui/scripts/eval_corpus_recall_v1.jsonl` — an
out-of-repo, generic recall eval set spanning apparel, footwear, electronics and
housewares. ADR-020 phase 0 explicitly instructed reusing it ("reuse its golden corpus
rather than minting a new one"). Against a beauty catalog, 16 of its 53 queries are
unanswerable by construction.

**No relevance judgement.** A parity diff inherits whatever the incumbent lane got
wrong. The seed lane substring-matches, so:

| query | the old fixture's "recall gap" |
|---|---|
| running shoes | Hydra Vizor Tinted Moisturizer ×5 |
| black leather sneakers | Ombré **Leather** Eau de Parfum ×2 |
| aroma diffuser | Neroli Hand & Body Moisturizer, Almond Honey Cookie Lotion |
| red lipstick long-lasting | Glow Bright Day Cream, Birch Moisturizing Cleanser |
| vanilla perfume | Phyto-Glow Lip Balm ×3, Architecture Foundation |

These were recorded as recall "the projection must close".

---

## 2. What replaced it

| artifact | role |
|---|---|
| `tests/fixtures/adr020_phase1_recall_corpus.jsonl` | 37 in-domain queries (23 en / 14 zh), checked in. Restricted from the original 53 by dropping `fashion_*`, `electronics`, `home`. |
| `scripts/lib/adr020_recall_relevance.cjs` | The relevance rubric. |
| `scripts/build-adr020-phase1-acceptance-corpus.cjs` | Builds the fixture from parity reports. |
| `tests/scripts/adr020_recall_relevance.test.js` | Pins every previously-mistaken target as irrelevant. |

The harness default corpus now points in-repo, so this cannot silently regress.

### How relevance is judged

Products are classified by **form** from brand + title (multi-label: a mineral SPF
tinted moisturizer is genuinely both `sunscreen` and `foundation`). Form is decisive
because a title reliably supports it. Query modifiers that a title *cannot* settle —
"long-lasting", "under $30", "for oily skin" — are recorded as unverified and **never**
decide a grade. Judging marketing copy from a title is how the first corpus went wrong;
the rubric does not repeat that mistake in the opposite direction.

- **2 relevant** — the form directly answers the query
- **1 partial** — right family, wrong sub-form (a lip liner for a lipstick query)
- **0 irrelevant** — wrong form

### The definition of a gap

> A product graded **RELEVANT** that the seed lane returned and the catalog lane did
> not, **on a query where the catalog lane returns fewer relevant answers than the seed
> lane.**

That second clause matters and was easy to miss. The lanes barely overlap (mean
overlap@k ≈ 0.04), so without it *every* relevant seed result scores as a gap — even on
queries where the catalog returned eight equally-relevant **different** products.
"vanilla perfume" is the worked example: the catalog misses the seed lane's lip balms
and returns actual eaux de parfum instead. That is a win being counted as a loss.

---

## 3. Results

Relevant results in the top 8, per lane, over 3 passes with the lane configured as prod
serves it (`token_match: true`). Sorted by how much the catalog lane beats the seed lane.
The 14 Chinese queries (all zero from both lanes) are omitted.

| query | seed rel@8 | catalog rel@8 | delta |
|---|---|---|---|
| mascara | 0 | 8 | **+8** |
| matte lipstick under $30 | 0 | 8 | **+8** |
| lipstick | 0 | 8 | **+8** |
| vanilla perfume | 0 | 6 | +6 |
| neutral eyeshadow palette | 2 | 8 | +6 |
| red lipstick long-lasting | 0 | 6 | +6 |
| waterproof volumizing mascara | 3 | 8 | +5 |
| nude lipstick everyday | 0 | 5 | +5 |
| cushion foundation | 4 | 7 | +3 |
| barrier moisturizer | 6 | 8 | +2 |
| hydrating barrier moisturizer fragrance free | 5 | 7 | +2 |
| hyaluronic acid hydrating serum | 6 | 8 | +2 |
| concealer for dark circles | 0 | 1 | +1 |
| full coverage foundation oily skin | 2 | 3 | +1 |
| acne cleanser | 7 | 8 | +1 |
| unisex fragrance for daily wear | 0 | 0 | 0 |
| woody fragrance under $80 | 0 | 0 | 0 |
| sunscreen | 8 | 8 | 0 |
| gentle cleanser | 8 | 8 | 0 |
| salicylic acid serum for acne and pores | 5 | 5 | 0 |
| spf 50 | 8 | 8 | 0 |
| moisturizer | 7 | 6 | −1 |
| lightweight gel moisturizer for acne-prone skin | 8 | 4 | **−4** |

**The catalog lane beats or ties the seed lane on 21 of 23 queries.** The old corpus,
read literally, said it was failing 15.

### What the tokenMatch correction changed

The same queries, before and after configuring the lane the way prod does:

| query | catalog rel@8, `tokenMatch` **off** | **on** (prod) |
|---|---|---|
| hydrating barrier moisturizer fragrance free | 1 | **7** |
| matte lipstick under $30 | 2 | **8** |
| red lipstick long-lasting | 2 | **6** |
| nude lipstick everyday | 2 | **5** |
| hyaluronic acid hydrating serum | 5 | **8** |
| lightweight gel moisturizer for acne-prone skin | 1 | **4** |
| full coverage foundation oily skin | 0 | **3** |
| vanilla perfume | 4 | **6** |
| woody fragrance under $80 | 3 | **0** |

Overall catalog precision@8 moves 59.8% → 75.0%. Every query that improved is a
multi-token one, which is exactly what the `+25`/token arm is for. Note the one
**regression**: "woody fragrance under $80" drops from 3 relevant to 0 — worth a look,
but it is not a lane deficit (the seed lane also returns 0).

Two queries return **zero relevant results from both lanes** — "unisex fragrance for
daily wear" and "woody fragrance under $80" — a shared failure that a parity diff is
structurally blind to, because the two lanes agree.

---

## 4. The one remaining defect

**Correction to this report's first draft.** It claimed the degeneration was "the only
arm that fires is `overlap x 25`, and it weights every token equally", with thousands of
rows tied at 25 and `product_key ASC` breaking the tie alphabetically. That was measured
with `tokenMatch` **off**, where the `+25`/token arm does not fire *at all* — the WHERE
arm and the rank arm are gated on the same flag (`canonicalCatalogSearch.js:799-804`).
Everything scored a flat `+20` from `multi_merchant_canonical` alone, which is precisely
what #1927 measured independently ("ALL 192 candidates scored exactly 20"). The
alphabetical-tie-break story was real for that configuration, and #1927 fixed its
symptom — but it is **not** the mechanism prod runs under.

With the lane configured as prod serves it, the picture is narrower.

**It is not missing inventory.** Live US catalog coverage:

| form | live rows |
|---|---|
| foundation | 501 |
| concealer | 337 |
| fragrance | 292 |
| mascara | 88 |
| lipstick | 70 |
| gel moisturizer | 49 |
| multi-product set | 2,166 |

**It is token matching without form awareness.** The one substantive deficit,
"lightweight gel moisturizer for acne-prone skin" (seed 8, catalog 4), returns:

```
[relevant]   The Ordinary  - Natural Moisturizing Factors + Beta Glucan Lightweight Gel Moisturizer
[relevant]   ARENCIA       - Vitamin C Glow Booster Gel Cream, Lightweight Brightening Gel Moisturizer
[relevant]   Arencia       - Eraser Soothing Cream, Lightweight Barrier Moisturizer
[relevant]   Olay          - Super Cream with Sunscreen SPF 30, Ultra Lightweight SPF Face Moisturizer
[IRRELEVANT] AXIS-Y        - Heartleaf Skin Soothing Gel MASK
[IRRELEVANT] Centellian24  - Madeca Lab PDRN Skin Tightening Glow Gel MASK
[IRRELEVANT] Centellian24  - Matcha PEELING GEL
[IRRELEVANT] Arocell       - Face Mask Soft Silicone BRUSH ... Moisturizer APPLICATOR
```

The top 4 are correct. The bottom 4 are gel *masks*, a *peeling* gel and an applicator
*brush* — they score on "gel" and "skin" while being the wrong product form entirely.
The same single false positive costs "moisturizer" its one-product deficit (the same
Arocell brush, plus a tinted moisturizer).

Token specificity still matters — "skin" matches 808 live rows, "oily" 12, "acne" 58,
and all contribute the same `+25` — so IDF-style weighting would help. But the sharper
observation is that **product form is not a ranking signal at all**, even though the
catalog knows it. A "gel mask" and a "gel moisturizer" are indistinguishable to a
matcher that only sees shared tokens.

**Scope of a fix, in priority order:**

1. Penalise or exclude wrong-form matches (masks, tools, applicators) on
   product-form queries. This alone closes both remaining deficits.
2. IDF-style token weighting so "skin" cannot outweigh "acne".

Neither is a `pdp_scope` change. Boosting `unverified` would not help: at `+20` the
structural bonus is small relative to 120/80/60, and it does nothing about form
confusion.

**Not fixed here.** No ranker change is made in this PR; this report scopes the work.

---

## 5. Recommendation

❱ **DECISION 1 — Adopt the re-baselined corpus as the Phase 1 acceptance target.**
Replaces 15 queries / 71 products with the judged set (2 queries / 14 products).
Recommend: adopt.

❱ **DECISION 2 — Do not tune the ranker toward the old corpus.** 53 of its products are
irrelevant and 50 more are substitutable. Recommend: close as "corpus defect, not a
recall regression".

❱ **DECISION 3 — Fix the harness/mainline config drift, and treat it as a class.**
The parity harness measured `tokenMatch: false` while prod serves `true`, so ADR-020's
designated parity instrument was reporting on a lane no caller uses. Fixed here, but the
general defect is that `fetchCanonicalChainRows` has **eight** behaviour-changing
optional params defaulting to off, and each caller opts in differently — the harness will
drift again on the next flag. Recommend: have the harness take its lane config from the
same constant the mainline reads, rather than restating it. Note `48f697c3` (#1933)
changed the mainline's params without touching the harness; that is how this went
unnoticed.

❱ **DECISION 4 — Phase 1 acceptance should be defined on relevance, not parity.**
Proposed wording:

> Phase 1 is accepted when, over the in-domain English corpus and with the lane
> configured as production serves it, the catalog lane's relevant@8 is **≥ the seed
> lane's** on every query.

**This bar is nearly met:** it holds on 21 of 23 queries. The two exceptions are
"lightweight gel moisturizer for acne-prone skin" (−4, real) and "moisturizer" (−1,
inside noise). Both are caused by the wrong-form matches in §4, and fixing item 1 there
closes both. The two queries returning zero relevant from *both* lanes are a shared
failure and should be tracked separately, not folded into a lane-parity bar.

❱ **DECISION 5 — Rank change: warranted, and now well-scoped.** Not a `pdp_scope`
rebalance and no longer the alphabetical-tie-break story (#1927 addressed that, and prod
does not run the configuration where it dominated). The remaining work is form-aware
matching first, IDF-style token weighting second. Recommend sequencing after Phase 1
acceptance is agreed, so it is measured against the corrected corpus and the corrected
harness.

❱ **DECISION 6 — Cross-lingual recall is out of scope and currently zero.** All 14
Chinese queries return **nothing from either lane**. This is not a parity gap (both
lanes agree) so it never appeared in the old fixture, but it is a real product gap.
Recommend: file separately; do not let it block Phase 1.

**One regression to look at, unrelated to the above:** "woody fragrance under $80" went
from 3 relevant to 0 when `tokenMatch` was enabled. It is not a lane deficit (seed also
returns 0) so it is not an acceptance target, but it is a real quality loss from a flag
that is already on in prod.

---

## 6. Method and caveats

- **The instrument was wrong twice, in the same direction.** Both defects made the
  harness measure something other than the system: a corpus of queries the catalog
  cannot answer, and a lane configuration no caller uses. Neither was visible from the
  harness's own output — it reported confident numbers both times. The report now
  records `token_match` in every run, and the corpus lives in-repo, so both are
  falsifiable from the artifact alone.
- **The measured deltas are `tokenMatch: true`,** matching prod
  (`PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED=true`; the code default is `false`).
  Reproduce the old shape with `--no-token-match`. Passes: `parity_tm11/12/13`,
  3 clean passes, catalog-lane errors 6/0/1 of 37.
- **The harness is not the mainline.** It calls `fetchCanonicalChainRows` directly with
  its own params; it does not exercise `server.js` routing, the beauty relevance gate,
  or category-bucket mode. A query that takes bucket mode in prod is measured here in
  text mode. This bounds what the corpus can certify — see DECISION 3.

- Corpus: 37 in-domain queries, `--limit 8 --market US`, run against prod via
  `railway run` (SELECT-only).
- **`railway run` executes *local* code against the prod database** — it injects prod env
  vars into a locally-run process, so the ranking code under measurement is the working
  tree's, not the deployed build's. Runs were made from a tree at `origin/main`.
- **Concurrency caveat.** Another session was editing this repo during the measurement
  window. It landed a 252-line change to `src/services/canonicalCatalogSearch.js` — the
  file the catalog lane runs — at 13:44:08, **83 seconds after the final pass completed
  at 13:42:45**. Before that, its only change to the file was an unused `require`, which
  is behavior-neutral. All four passes therefore ran identical ranking code, corroborated
  empirically: the headline numbers are identical computed from pass 1 alone and from all
  four passes combined. **Anyone re-running this audit will be measuring different code**
  — re-baseline before comparing. That session appears to be working on the multi-product
  -set crowding path (`beautyRelevanceGate.queryWantsMultiProductSet`), i.e. #1927, the
  same defect §4 identifies; the two efforts should be reconciled before either lands.
- **Flakiness is severe and the brief's warning was accurate.** Five passes were
  attempted; four produced reports:

  | pass | catalog-lane errors | mean catalog latency | usable |
  |---|---|---|---|
  | 1 | 0 / 37 | 5.3s | yes (pristine) |
  | 2 | **35 / 37** | 54.6s | mostly discarded |
  | 3 | 2 / 37 | 9.0s | yes |
  | 4 | 2 / 37 | 7.4s | yes |
  | (aborted) | — | — | Railway CLI `tls handshake eof` |

  The builder discards, per query, any pass where either lane errored, and records a
  product as missing only when it is missing in a **majority of surviving passes**. 32 of
  37 queries ended with 3 clean passes.
- **A silent failure mode worth knowing about:** a stalling proxy returns an *empty*
  result set without throwing, so `catalog_count: 0` is indistinguishable from a timeout.
  "concealer for dark circles" returned 8/8 in a healthy pass and 0/0 in one stalling at
  35–40s. Averaging those manufactures a deficit that is pure transport artifact. The
  builder therefore believes a zero only when **every** clean pass agrees on it; 3
  queries had a stalled pass dropped on this rule. Headline numbers were identical from
  pass 1 alone and from all four passes combined.
- **Rubric limitations — read before trusting the precision figures.** Judgement is from
  brand + title only, which is what a human reviewer sees in this data but is not ground
  truth. Every judgement in the fixture carries its matched forms and reason so it can be
  audited and overridden per product. The rubric deliberately does not grade unverifiable
  attributes, so precision here means *"right product form"*, not *"right product"* —
  "red lipstick long-lasting" scores a lipstick of any colour as relevant. A rubric bug
  found and fixed during this work (implements such as "Foundation Brush" grading as
  foundations) moved catalog precision by 2.2pp, which is a fair indication of the
  residual uncertainty. The seed-vs-catalog precision gap is now **16.5pp** (75.0% vs
  58.5%) — an order of magnitude above that uncertainty, so the direction is safe even
  if the absolute figures are not exact. The load-bearing results remain the per-query
  deltas in §3, several of which are 0-vs-8.
- Both flags confirmed enabled in prod: `CANONICAL_CATALOG_RECALL_DOC_MATCH`,
  `CANONICAL_CATALOG_RANK_V2`.
