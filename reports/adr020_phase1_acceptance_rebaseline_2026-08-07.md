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

Re-measured in-domain with an explicit relevance rubric applied to **both** lanes:

- **The catalog lane is not behind.** Overall precision@8 is a tie within rubric error
  (59.8% vs 58.5%), but it fills **184** result slots to the seed lane's **135** and
  returns more relevant answers on **12 of 23** measured queries against 5 the other way
  — including two, "mascara" and "lipstick", where the seed lane returns *nothing*
  relevant and the catalog lane returns a clean 8.
- The "6 of 71 gap products returned" panic reading was an artifact. The correct count
  of genuine acceptance targets is **5 queries / 27 products**, not 15 / 71.
- **56** of the old corpus's products are graded irrelevant — tuning rank to return them
  would degrade results. A further **45** are relevant but *substitutable*: the catalog
  lane already returns equally-relevant different products for those queries.
- There **is** a real, single-cause defect, but it is not the one the old corpus implied.
- Coverage is **not** the problem: 337 concealers, 501 foundations, 292 fragrances and
  88 mascaras are live in the US catalog. The failures are ranking, not inventory.

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

Relevant results in the top 8, per lane. Sorted by how much the catalog lane beats the
seed lane. Four passes; the 14 Chinese queries (all zero from both lanes) are omitted.

| query | seed rel@8 | catalog rel@8 | delta |
|---|---|---|---|
| mascara | 0 | 8 | **+8** |
| lipstick | 0 | 8 | **+8** |
| neutral eyeshadow palette | 2 | 8 | +6 |
| waterproof volumizing mascara | 3 | 8 | +5 |
| vanilla perfume | 0 | 4 | +4 |
| woody fragrance under $80 | 0 | 3 | +3 |
| cushion foundation | 4 | 7 | +3 |
| matte lipstick under $30 | 0 | 2 | +2 |
| nude lipstick everyday | 0 | 2 | +2 |
| red lipstick long-lasting | 0 | 2 | +2 |
| barrier moisturizer | 6 | 8 | +2 |
| acne cleanser | 7 | 8 | +1 |
| unisex fragrance for daily wear | 0 | 0 | 0 |
| concealer for dark circles | 0 | 0 | 0 |
| sunscreen | 8 | 8 | 0 |
| gentle cleanser | 8 | 8 | 0 |
| salicylic acid serum for acne and pores | 5 | 5 | 0 |
| spf 50 | 8 | 8 | 0 |
| moisturizer | 7 | 6 | −1 |
| hyaluronic acid hydrating serum | 6 | 5 | −1 |
| full coverage foundation oily skin | 2 | 0 | −2 |
| hydrating barrier moisturizer fragrance free | 5 | 1 | **−4** |
| lightweight gel moisturizer for acne-prone skin | 8 | 1 | **−7** |

The shape is the finding. **Short queries: the catalog lane dominates.** "mascara" and
"lipstick" go from *zero* relevant results on the seed lane to a clean 8. **Long queries:
the catalog lane collapses** — and the three worst are the three longest. §4 explains why.

Two of the five deficits ("moisturizer", "hyaluronic acid hydrating serum") are a single
product and are within pass-to-pass noise; the three substantive ones are all long queries.

Note also that both lanes return **zero relevant results** for "concealer for dark
circles" and "unisex fragrance for daily wear" — a shared failure that a parity diff is
structurally blind to, because the two lanes agree.

---

## 4. The one real defect

The substantive deficits share a single mechanism, and it is **not** the `pdp_scope`
structural penalty the old analysis pointed at.

**It is not missing inventory either.** Live US catalog coverage:

| form | live rows |
|---|---|
| foundation | 501 |
| concealer | 337 |
| fragrance | 292 |
| mascara | 88 |
| lipstick | 70 |
| gel moisturizer | 49 |
| multi-product set | 2,166 |

501 foundations exist; "full coverage foundation oily skin" returns none of them.

Under `CANONICAL_CATALOG_RANK_V2` the match-quality arms are:

| arm | weight |
|---|---|
| lowered query phrase appears in title | +120 |
| **all** significant query tokens covered across title/brand | +80 |
| recall_doc phrase hit | +60 |
| `multi_merchant_canonical` | +20 |
| proportional token overlap | overlap × 25 |

For a long query — "full coverage foundation oily skin" (5 significant tokens) — no
product title contains the phrase (+0), and no product covers all five tokens (+0), and
there is no recall_doc phrase hit (+0). **The only arm that fires is `overlap × 25`, and
it weights every token equally.** Measured selectivity of that query's own tokens:

| token | live rows matching | contributes |
|---|---|---|
| skin | **808** | +25 |
| foundation | 456 | +25 |
| coverage | 107 | +25 |
| full | 71 | +25 |
| oily | **12** | +25 |

A token matching 808 rows is worth exactly as much as one matching 12. Meanwhile only
**2 rows in the entire catalog** match ≥3 of the 5 tokens (`minTokens` = 3), so the token
WHERE arm admits almost nothing and the results arrive via other arms scoring ≤50.

Thousands of rows then tie at 25, and `ORDER BY rank_score DESC, product_key ASC`
breaks the tie **alphabetically**. Hence the observed output:

```
Anua — PDRN 4-Step Glowy Skin Set
Anua — Recharge Your Summer Skin Set
ARENCIA — Eraser Skin Reset Trio
ARENCIA — Ultimate Radiance 7-Step Skincare Set
Arocell — Gua Sha Facial Massage Tools ... Skin Care
AXIS-Y — Artichoke Intensive Skin Barrier Ampoule
```

Multi-product sets dominate because they are numerous and match generic tokens, not
because sets are privileged. This is the same degeneration class already documented at
`src/services/canonicalCatalogSearch.js:76` for `category_browse` mode ("rank_score is
near-constant and ordering degenerates to the tie-break"), now firing on the **text**
lane for long queries. It is the mechanism behind issue #1927.

**The fix is token specificity weighting (IDF-style), not a `pdp_scope` change.**
Boosting `unverified` would not help: at +20 the structural bonus is already small
relative to 120/80/60, and it does nothing about a 25-point universal tie.

---

## 5. Recommendation

❱ **DECISION 1 — Adopt the re-baselined corpus as the Phase 1 acceptance target.**
Replaces 15 queries / 71 products with the judged set. Recommend: adopt.

❱ **DECISION 2 — Do not tune the ranker toward the old corpus.** 56 of its products are
irrelevant and 45 more are substitutable. Recommend: close as "corpus defect, not a
recall regression".

❱ **DECISION 3 — Phase 1 acceptance should be defined on relevance, not parity.**
Proposed wording:

> Phase 1 is accepted when, over the in-domain English corpus, the catalog lane's
> relevant@8 is **≥ the seed lane's** on every query.

Stated honestly: **this bar is not met today.** It fails on 5 of 23 queries (3
substantively). That is deliberate — it is a real bar with a real, single-cause gap
behind it, rather than the old target which was 79% noise and unreachable by
construction. The two "return zero relevant from both lanes" queries ("concealer for
dark circles", "unisex fragrance for daily wear") are a *shared* failure and should be
tracked separately rather than folded into a lane-parity bar.

❱ **DECISION 4 — Rank change: warranted, but scoped to token specificity.** Not a
`pdp_scope` rebalance. Tracked as #1927. Recommend sequencing it after Phase 1
acceptance is agreed, so it is measured against the corrected corpus.

❱ **DECISION 5 — Cross-lingual recall is out of scope and currently zero.** All 14
Chinese queries return **nothing from either lane**. This is not a parity gap (both
lanes agree) so it never appeared in the old fixture, but it is a real product gap.
Recommend: file separately; do not let it block Phase 1.

---

## 6. Method and caveats

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
  residual uncertainty. **Treat the seed-vs-catalog precision gap (1.3pp) as a tie, not
  as a catalog win; the load-bearing results are the large per-query deltas in §3.**
- Both flags confirmed enabled in prod: `CANONICAL_CATALOG_RECALL_DOC_MATCH`,
  `CANONICAL_CATALOG_RANK_V2`.
