# ADR-020 Phase 1 — acceptance corpus re-baseline

**Date:** 2026-08-07
**Status:** needs an owner's decision (items marked ❱ DECISION)
**Supersedes:** `tests/fixtures/adr020_phase1_gap_scope.json` @ 2026-07-30 (15 gap queries / 71 products)

> **Revision note.** Earlier drafts of this report were wrong in ways worth stating
> plainly, because the corrections are the most useful thing in it. They claimed catalog
> precision@8 of 59.8%, then 75.0%; both were artifacts of measuring a lane configuration
> production does not serve, and of a rubric hole. They cited "vanilla perfume" as the
> worked example of the catalog lane returning *better* answers — the opposite of what the
> data showed once the configuration was corrected. Every number below is from a single
> set of three clean prod passes at one code revision. §6 lists what changed and why.

---

## TL;DR

The Phase 1 acceptance target was measuring the wrong thing. It recorded a **parity
diff** — everything the seed lane returned that the catalog lane did not — with **no
relevance judgement attached**, over a **generic multi-category query corpus** replayed
against a beauty-only catalog. Roughly 40% of its queries had no correct answer in the
data at all, so seed-lane substring noise became acceptance targets.

Three instrument defects were found and fixed before any number here could be trusted
(§6). Measured in-domain, both lanes judged, lane configured as prod serves it:

- **The catalog lane is ahead, and by more than the old corpus could see.** Precision@8
  **88.0% vs the seed lane's 58.5%**, on **18 wins / 2 ties / 3 losses** across 23
  measured queries. Distinct relevant brands 105 vs 84, so this is not variant-stuffing.
- The genuine acceptance target is **3 queries / 22 products**, not 15 / 71.
- **56** of the products the seed lane surfaces are graded irrelevant; **43** more are
  relevant but *substitutable* — the catalog already returns equally-relevant different
  products for those queries.
- A **product-form rank arm** (this PR) took catalog precision from 68.5% to 88.0%. It
  closed both queries where *both* lanes previously returned zero relevant results — a
  failure class a parity diff is structurally blind to. **That figure predates three
  rounds of review fixes to the arm and has not been re-measured; see §7.**
- Three deficits remain, all small: `sunscreen` (−2), `moisturizer` (−1), `lightweight
  gel moisturizer for acne-prone skin` (−1). Two of the three are **single-token
  queries**, which no text rank arm can reach — see §4.

---

## 1. What was wrong with the old corpus

Two independent defects, compounding.

**Provenance.** `scripts/audit-recall-lane-parity.cjs` defaulted to
`/Users/pengchydan/dev/pivota-agent-ui/scripts/eval_corpus_recall_v1.jsonl` — an
out-of-repo, generic recall eval set spanning apparel, footwear, electronics and
housewares. ADR-020 phase 0 explicitly instructed reusing it. Against a beauty catalog,
16 of its 53 queries are unanswerable by construction.

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

Graded directly, the old fixture holds **73 product entries over 15 queries**: 24 belong
to out-of-domain queries the rubric refuses to grade at all, and of the remainder 19 are
irrelevant, 5 partial, 25 relevant. (The "71" in the old test counted unique
`external_product_id`s.)

---

## 2. What replaced it

| artifact | role |
|---|---|
| `tests/fixtures/adr020_phase1_recall_corpus.jsonl` | 37 in-domain queries (23 en / 14 zh), checked in. Restricted from the original 53 by dropping `fashion_*`, `electronics`, `home`. |
| `scripts/lib/adr020_recall_relevance.cjs` | The relevance rubric. |
| `scripts/build-adr020-phase1-acceptance-corpus.cjs` | Builds the fixture from parity reports. |
| `tests/scripts/adr020_recall_relevance.test.js` | Pins mistaken targets from **both** lanes. |

### How relevance is judged

Products are classified by **form** from brand + title (multi-label). Form is decisive
because a title reliably supports it. Query modifiers a title *cannot* settle —
"long-lasting", "under $30" — are recorded as unverified and **never** decide a grade.

- **2 relevant** — the form directly answers the query
- **1 partial** — right family, wrong sub-form (a lip liner for a lipstick query); also
  every multi-product set, which may contain the right product but is not it
- **0 irrelevant** — wrong form, or a non-face surface (a body scrub is not a perfume)

### The definition of a gap

> A product graded **RELEVANT** that the seed lane returned and the catalog lane did
> not, **on a query where the catalog lane returns fewer relevant answers than the seed
> lane.**

The second clause matters: the lanes overlap little, so without it *every* relevant seed
result scores as a gap even where the catalog returned eight equally-relevant
**different** products. Its limitation is real and stated in §6.

---

## 3. Results

Relevant results in the top 8 per lane, 3 clean passes (zero lane errors in all three),
`token_match: true`, `form_agreement: true`. The 14 Chinese queries return nothing from
either lane and are omitted.

| query | seed | catalog | delta |
|---|---|---|---|
| matte lipstick under $30 | 0 | 8 | **+8** |
| nude lipstick everyday | 0 | 8 | **+8** |
| red lipstick long-lasting | 0 | 8 | **+8** |
| lipstick | 0 | 8 | **+8** |
| unisex fragrance for daily wear | 0 | 7 | **+7** |
| woody fragrance under $80 | 0 | 7 | **+7** |
| concealer for dark circles | 0 | 7 | **+7** |
| neutral eyeshadow palette | 2 | 8 | +6 |
| mascara | 0 | 6 | +6 |
| waterproof volumizing mascara | 3 | 8 | +5 |
| full coverage foundation oily skin | 2 | 6 | +4 |
| salicylic acid serum for acne and pores | 5 | 8 | +3 |
| vanilla perfume | 0 | 2 | +2 |
| cushion foundation | 4 | 6 | +2 |
| hydrating barrier moisturizer fragrance free | 5 | 7 | +2 |
| hyaluronic acid hydrating serum | 6 | 8 | +2 |
| acne cleanser | 7 | 8 | +1 |
| barrier moisturizer | 6 | 7 | +1 |
| gentle cleanser | 8 | 8 | 0 |
| spf 50 | 8 | 8 | 0 |
| moisturizer | 7 | 6 | −1 |
| lightweight gel moisturizer for acne-prone skin | 8 | 7 | −1 |
| sunscreen | 8 | 6 | −2 |

**18 wins / 2 ties / 3 losses.** A sign test on 18 vs 3 gives p < 0.001. The seed lane
returns *zero* relevant results on seven queries; inspection confirms these are genuine
(eyeliners for "mascara", lip liners and balms for "lipstick").

### What the product-form arm changed

Same corpus, same three-pass discipline, flag off vs on:

| query | catalog, form agreement **off** | **on** |
|---|---|---|
| unisex fragrance for daily wear | 0 | **7** |
| woody fragrance under $80 | 0 | **7** |
| concealer for dark circles | 1 | **7** |
| lightweight gel moisturizer for acne-prone skin | 4 | **7** |
| full coverage foundation oily skin | 3 | **6** |
| nude lipstick everyday | 5 | **8** |
| salicylic acid serum for acne and pores | 5 | **8** |

| | off | on |
|---|---|---|
| catalog precision@8 | 68.5% | **88.0%** |
| distinct relevant brands | 84 | **105** |

The brand count rising with precision is the check that this is better answers rather
than more variants of the same answer.

**A claim withdrawn.** An earlier draft bolded "No query regressed" here. That was a
23-query claim supported by the 7-query excerpt above, and the arm-off pass is not
checked in, so a reader cannot verify it. Worse, the query most likely to have regressed
— "vanilla perfume", the corpus's worst at 2/8 — was absent from the excerpt and scored
in the table above as a **+2 win**. It has since been shown to be an arm defect (§7).
Treat the per-query rows as indicative and the aggregate as the result.

Note what the top two rows mean: `unisex fragrance for daily wear` and `concealer for
dark circles` previously returned **zero relevant results from both lanes**. A parity
diff cannot see that failure class at all, because the two lanes agree.

---

## 4. The defect, and what remains

**It was never missing inventory.** Live US catalog coverage, by title substring — these
are loose upper bounds, not form counts, and should be read as such:

| form (substring) | live rows |
|---|---|
| foundation | 501 |
| concealer | 337 |
| fragrance | 292 |
| mascara | 88 |
| lipstick | 70 |

**It was token matching without product-form awareness.** Token overlap counts tokens
without asking what any of them mean, so matching the query's form noun is worth exactly
as much as matching a generic material or attribute word. For "lightweight gel
moisturizer for acne-prone skin", only 13 live rows clear the token WHERE arm and
**twelve tie at exactly 75** — real gel moisturizers tied with a facial toner, a sheet
mask, a cleanser and two bundles, all matching {acne, prone, skin}. `product_key ASC`
then picks the cut.

**IDF was tried first and rejected on measurement.** The rarest token in that query is
"prone" (df=10) — half of the attribute "acne-prone", semantically worthless — while the
form noun "moisturizer" sits at df=192. IDF promotes the sheet mask, the bundle and the
toner into positions 2–4. Measured relevant-in-top-8: **flat 5/8, IDF 5/8, form
agreement 8/8.**

### What remains: single-token queries

`buildSignificantTokens` drops tokens under 3 characters and stopwords, and the token arm
is gated on `tokens.length >= 2`. So for **`mascara`, `lipstick`, `sunscreen`,
`moisturizer`, `spf 50`** the token arm never fires — and neither do the phrase (+120) or
coverage (+80) arms, which need a multi-token match. The rank ladder is genuinely inert,
and the returned rows are a strictly ascending run by `product_key`:

```
sunscreen:   anua…, anua…, axis-y…, axis-y…, beauty-of-joseon…×3, centellian24…
moisturizer: arencia…, arocell…, cosrx…, glossier…×3, merit…, saie…
```

Against hundreds of live sunscreens, an alphabetical run from "anua" to "centellian24" is
the flat-tie band, not a ranking. **Two of the three remaining deficits are exactly these
queries**, and the form arm cannot help: with one token, the form is the whole query, so
every candidate that matches at all gets the same +60.

This also means an earlier draft's retraction went too far. The alphabetical-tie-break
mechanism #1927 identified is **not** dead: it is what prod runs for every single-token
query. It is only displaced on multi-token queries, where the ladder now fires.

**The fix for that class is not a rank arm** — there is no text signal left to rank on.
It needs a category/quality prior for bare-noun queries. Out of scope here; filed as
follow-up.

---

## 5. Recommendation

❱ **DECISION 1 — Adopt the re-baselined corpus as the Phase 1 acceptance target.**
Replaces 15 queries / 71 products with 3 / 22. Recommend: adopt.

❱ **DECISION 2 — Close the old gap list as a corpus defect, not a recall regression.**
Of the products the seed lane surfaces in-domain, 56 are irrelevant and 43 substitutable.
Of the old fixture's own 73 entries, 24 are for queries the catalog cannot answer by
construction and 19 more are irrelevant.

❱ **DECISION 3 — Ship the product-form arm, and set its flag.**
`CANONICAL_CATALOG_FORM_AGREEMENT` defaults **off** and does nothing until set in prod.
Given #1933 — where a rank fix rode an unrelated flag and sat dark — this needs an
explicit decision to enable, not an assumption. Recommend: enable, after the soak this
codebase applies to rank changes.

❱ **DECISION 4 — Phase 1 acceptance defined on relevance, not parity.**

> Phase 1 is accepted when, over the in-domain English corpus and with the lane
> configured as production serves it, the catalog lane's relevant@8 is **≥ the seed
> lane's** on every query.

Currently met on **20 of 23**. The three exceptions are the single-token class in §4 plus
`lightweight gel moisturizer` at −1. Recommend accepting Phase 1 with those three listed
as known, tracked, and not projection defects — or, if the bar must be absolute, adopting
it only after the bare-noun work.

❱ **DECISION 5 — Fix the harness/mainline config drift as a class.**
`fetchCanonicalChainRows` has ten behaviour-changing optional params defaulting to off.
`mainlineLaneConfig()` now shares the flag-derived ones, but `categoryPathPrefix`,
`categoryMode` and `verticalSearch` are per-query and cannot be shared this way — and
category-browse mode **drops the query-text predicate entirely**, which is the mode most
beauty traffic takes. The harness measures text mode. That is a real limit on what this
corpus certifies.

❱ **DECISION 6 — Cross-lingual recall is out of scope and currently zero.** All 14
Chinese queries return nothing from either lane. Not a parity gap (both lanes agree), so
it never appeared in the old fixture. File separately; do not let it block Phase 1.

---

## 6. Method and caveats

### The instrument was wrong three times, always in the same direction

Each defect made the harness measure something other than the system, and each time it
reported confident numbers while doing so.

1. **A corpus of queries the catalog cannot answer** (§1).
2. **A lane configuration no caller uses.** The harness never passed `tokenMatch`, which
   `fetchCanonicalChainRows` defaults to `false` while every production caller enables it
   (prod sets `PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED=true`). The `+25`/token arm was
   dark in every measurement ever taken with this tool. Catalog precision read 59.8% that
   way. The tell was that re-running after #1927's merged fix moved *nothing*.
3. **A rubric hole that flattered the catalog lane.** A body/hair surface suppressed only
   face-care forms, so `fragrance` survived it: "TIELA Perfume Nourishing Body Scrub"
   graded RELEVANT for "vanilla perfume". Five of the six results credited to that query
   were TIELA body creams and scrubs; it returned **no eau de parfum at all**. That query
   was this report's worked example for the deficit clause, asserting the catalog
   "returns actual eaux de parfum instead" — true of the pre-`tokenMatch` run, carried
   forward into a configuration where it is false. Correcting it moved catalog precision
   75.0% → 68.5% and the gap count 2 → 3.

The lesson generalises past this corpus: **when a merged fix does not move your numbers,
suspect the instrument before concluding the fix did not work.**

### What is and is not trustworthy here

- **Trust the direction.** 18 wins / 3 losses, p < 0.001, and the largest deltas are
  0-vs-8 with titles anyone can inspect.
- **The form-arm delta is provisional.** 68.5% → 88.0% with distinct brands 84 → 105 was
  measured on one code revision, which three rounds of review have since changed
  substantially (§7). The direction is well-supported; the number is not current.
- **Do not trust any single-query delta of 1–2.** Rubric edits during this work moved
  catalog precision by 2.2pp and then 6.5pp. A per-query delta of 1 is inside the
  rubric-sensitivity band, and the band is not symmetric between lanes: the
  multi-product-set rule cost the catalog lane 7 relevant slots and the seed lane zero.
- **Precision measures form, not ranking quality.** A lane that returns any 8 products of
  the right form scores 100%, so §3 cannot distinguish "ranked well" from "swept the
  right category alphabetically" — which is exactly what happens on single-token queries
  (§4). `catalog_relevant_distinct_brands` is reported beside precision as a partial
  guard; a proper fix needs graded relevance against a hand-ranked head.
- **The rubric reads the same field the catalog lane ranks on.** The catalog lane selects
  on `title`/`brand`; the seed lane also selects on category, description, ingredient and
  alias tokens. 100% of catalog results contain a query token in title/brand versus 64%
  of seed results — so the rubric sees all of one lane's selection signal and two-thirds
  of the other's. Checked and *not* explained by title formatting (titles of products
  both lanes return are byte-identical), but it is a structural bias toward the catalog
  lane and the headline gap should be read with it in mind.

### Gap-definition limits

The deficit clause is a hard threshold, so a query flips between 0 and 8 acceptance
targets on a delta of 1. Eight queries sit within ±1 of it. It is also blind to
right-count/wrong-products failures: `cushion foundation` returns 6 relevant across **one
brand** against the seed lane's 4 across 4 brands, and scores as no deficit.

### Reproducing

```
railway run -p <project> -e production -s PIVOTA-Agent \
  node scripts/audit-recall-lane-parity.cjs \
  --corpus tests/fixtures/adr020_phase1_recall_corpus.jsonl --limit 8 --market US \
  --out <report>.json
node scripts/build-adr020-phase1-acceptance-corpus.cjs --report <report>.json ... \
  --out tests/fixtures/adr020_phase1_gap_scope.json
```

- **`railway run` executes *local* code against the prod database**, so the ranking code
  under measurement is the working tree's, not the deployed build's.
- **Every report records `token_match` and `form_agreement`.** A report without them
  cannot be compared to another.
- The fixture now stores the catalog lane's returned titles with grades
  (`catalog_returns_last_clean_pass`), so the precision figure is auditable from the
  repo. Earlier versions stored seed-lane titles only, which made the headline
  uncheckable — the raw pass JSON lives in a session scratchpad, not in git.
- **Cross-pass variance is zero** for clean passes: the lanes are deterministic given DB
  state, so repeated passes guard against transport stalls, not sampling error. No claim
  here should be read as having a statistical noise floor from pass count.

---

## 7. What adversarial review changed, and why the flag is not enabled

Three review rounds ran over this work. Each found defects the measurement could not,
and each invalidated the measurement that preceded it. That pattern is the finding.

### Defects found in the rank arm after it was first measured

| # | defect | consequence |
|---|---|---|
| 1 | `mainlineLaneConfig` read the mainline's flag through the wrong value set (`{enabled,on,1,true}` vs `parseBooleanEnv`'s `{1,true,yes,y,on}`) | Setting the flag to `enabled` — the spelling every sibling flag here uses — would give a **dark lane in prod and a harness stamping `token_match: true`**. The instrument defect, inverted and self-certifying. |
| 2 | `'spf'` in the sunscreen title vocabulary | Boosted "Tinted Moisturizer SPF 30" and "Foundation SPF 15" on sunscreen queries. **The rubric shared the error**, so the harness could never falsify it. |
| 3 | Unanchored `LIKE '%...%'` | `%mask%` matched "Da**mask** Rose Toner"; `%perfume%` matched "**Perfume**d Body Lotion". |
| 4 | Whitespace-only tokenization | The arm was silently dark on `"moisturizer,"` (one comma) and `"moisturizers"` (plural). |
| 5 | No multi-product-set exclusion | `applyMultiProductSetTopCap` (#1927) only swaps within a tie group, so a set titled "Moisturizer Duo" would take +60, land in a higher group and become **undemotable** — reintroducing the head-crowding #1927 shipped to prevent, through a channel that cap cannot see. |
| 6 | `'perfume'` as a title pattern, and no body-surface exclusion | On "vanilla perfume", "TIELA Perfume Nourishing Body Cream" scored 25 + 60 = **85** against Tom Ford "Lost Cherry Eau de Parfum" at **60** — the arm ranked body cream **above** the eau de parfum, on the query this work used as its showcase. |
| 7 | 18 of 31 lexicon entries unexercised by any corpus query | Unfalsifiable by this corpus. The one that was checked misfired: `'mask'` boosted six TIRTIR cushion foundations, a line titled "Mask Fit Red Cushion". Removed. |

Defect 6 is the one to remember: it is the same class as the corpus defect this entire
report exists to correct — a claim carried forward from a superseded configuration
without rechecking it against the data.

### A reasoning error, corrected

The arm was documented as monotone, with "under-inclusion is safe". That holds **between**
queries — a form absent from the lexicon means the arm never fires. It is **false within a
firing query**: every row the patterns miss is relatively demoted by 60. Measured over the
247 corpus titles, ~20% carry no form-vocabulary word at all ("1025 Dokdo Cream",
"Dynasty Cream", "Airy Sun Stick SPF 50+" are real products), and the unlabelled cohort is
brand-correlated with K-beauty naming. A narrow vocabulary ranks by merchandiser naming
convention rather than merit — the defect class this file's own neutrality note forbids.
The title vocabulary was widened toward the rubric's `FORM_PATTERNS` in response.

### ❱ DECISION 3 REVISED — do not enable the flag yet

Both reviewers independently returned **ENABLE: BLOCK**, and the reasons are not about the
code being wrong. They are about what has never been looked at:

1. **~89% of mainline beauty traffic takes category-browse mode**, and the arm was
   measured on 0% of it. Bucket mode drops the query text from the WHERE but **still
   applies the rank arms**, so that traffic is reordered by a change no measurement covers.
2. **The flag affects five callers, not one.** It is read inside the helper, so it reaches
   the citable-supplement and ingredient-direct lanes and a general-shopping lane that
   serves **non-beauty** — where "printer toner", "air conditioner", "sofa cushion" are
   homographs of lexicon entries.
3. **There is no telemetry stamp.** Every sibling flag has one (`canonical_token_match`,
   `canonical_sargable_text_where`). Without it the soak cannot be sliced and a
   post-flip regression cannot be attributed to this change.
4. **The arm is inert unless `CANONICAL_CATALOG_RANK_V2` is on** — stated nowhere else,
   and flipping it on a service without rank v2 reproduces #1933 exactly.

Merging is safe regardless: flag-off SQL and params are byte-identical to `origin/main`
across 114,688 verified combinations, and bind-safe across 229,376 with the flag on.

**Before enabling:** add the telemetry stamp on all three serving lanes; measure
category-browse mode the way #1933 did (top-8 relevance off vs on, plus one prod
`EXPLAIN ANALYZE`); and run #1927's control-query discipline at prod candidate depth
(`limit 48`, not the harness's 8). Rollback is
`railway variables --unset CANONICAL_CATALOG_FORM_AGREEMENT`, effective on the next
request with no persisted residue.
