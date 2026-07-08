# Vertical Expansion — Electronics Pilot Scope & Multi-Vertical Architecture

**Status:** proposed / not started.
**Trigger:** channel partner asked us to audit **mojawa.com** (bone-conduction sports earphones, Shopify, 13 SKUs via open `products.json`, rich descriptions incl. `product_type`). First concrete pull outside beauty.
**Positioning:** beauty remains the primary vertical. This doc scopes (a) the *minimum honest* electronics pilot, and (b) the architecture that makes vertical #3, #4… additive instead of another rewrite. Do not build (a) in a way that forecloses (b).
**Date:** 2026-07-08.
**Code audit basis:** two full scans on 2026-07-08 — audit pipeline (`pivota-backend`) + enrichment/claims/serving (`PIVOTA-Agent`). File:line refs below are from those scans.
**Review log:** adversarially reviewed 2026-07-08 (independent fresh-context pass, findings verified against code). Corrections incorporated: `_vertical_for` too weak to promote as-is (no earphone/earbud/audio tokens); `_SKU_CONTEXT_CACHE` is in-memory, durable vertical persistence is net-new work; `_health_sensitive` is a metadata flag, not a brief gate; LLM extractor needs a groundedness guard (evidence spans) before its output may seed probes; golden-file can't cover LLM brief leakage. Timeline revised **1–2 wks → ~3 wks** to report delivery.

---

## Verdict being scoped against

Running mojawa.com through today's pipeline yields a report that *looks* complete but:

- **Attribute/constraint probe axis is dead** — `sku_sidewalk` lexicons are 100% beauty; "bone conduction / IP68 / open-ear / for swimming" resolve zero attributes → zero sidewalk queries (`services/sku_sidewalk.py:1295` returns `[]` on no category match). This is precisely the axis where a niche brand competes.
- **Strategic brief is off-target** — ingredient prompt rules, cosmetics claims bans ("clinically tested", "repairs" — legitimate for electronics), beauty-only publisher list. (*Corrected in review 2026-07-08:* the `_health_sensitive` token list at `services/strategic_brief.py:1947,1967` is a metadata flag with one call site (L868), **not** a gate a brief fails — the off-target risk is entirely in the prompt rules.)
- **Competitor panels corrupt** — the type-name filter only knows beauty tokens, so "wireless earbuds" leaks as a fake competitor brand (`services/competitor_brand_filter.py:75,113`); `_RETAILER_NAME_TOKENS` has no electronics retailers so Best Buy/Rtings can be mis-picked as "category winner" (`agent_center_bd_report_service.py:9380`).
- **Grounded evidence = zero** — the entire claims engine is INCI-only (`src/groundedProductIntel.js:5`, `externalSeedIngredientEnrichment.js`); the Phase-2 cross-vertical claim model is designed but not built.
- **URL-only audits collapse to branded queries** — category title-fallback `_CATEGORY_HEAD_NOUNS` is beauty-scoped on purpose (`agent_center_bd_report_service.py:7989`), and worse, has hardcoded beauty fallbacks (returns `"beauty supplement"` on collagen/vitamin-c tokens).

What already works, category-neutrally: the probe `axis` vocabulary + query template shapes, `win_plan_builder`, `where_you_can_win`/`where_youre_losing` assembly, serving eligibility, honesty gates, and — notably — **latent electronics support**: PDP-completeness scoring has an electronics branch (`agent_center_bd_report_service.py:2509` checks `electronics_meta`: spec_groups/in_box/pro_reviews), serving has an electronics PDP container + `GENERIC_*` schema profiles (`src/pdpBuilder.js:568`, `src/pdpSchemaProfile.js`), and query routing already maps earphones/headphones → `electronics/audio/` (`src/server.js:17176`). Nothing produces beauty-flavored *wrong* output — beauty producers gate to null. The failure mode is silent thinness plus two actively-wrong panels (brief, competitors).

**Key structural insight:** the report scaffolding and scoring plumbing are vertical-neutral. The coupling is concentrated in **swappable content** — lexicons, prompt rules, token lists, fallback constants — scattered across ~6 files with no shared seam. That's what the architecture below fixes.

---

## Part 1 — Multi-vertical architecture (the load-bearing part)

### The anti-goal

The naive fix is `if vertical == "electronics":` branches sprinkled wherever beauty is hardcoded today. That turns every new vertical into a re-audit of six files and guarantees drift (the brief's idea of the vertical diverging from the competitor filter's). We already have this disease in embryo: `_vertical_for` (backend, report-time), `inferCategoryKind` (serving, `pdpBuilder.js:568`), and `categories.js` buckets are **three independent category resolvers that can disagree on the same product**.

### Principle 1 — Resolve the vertical once, persist it durably, pass it down

One shared resolver, run **at audit intake / SKU-context build**. Three corrections from the 2026-07-08 adversarial review, all verified against code:

- **Don't promote `_vertical_for` as-is** — it's the *weakest* of the three resolvers. Its electronics keywords (L2143: `electronics, device, laptop, phone, camera, headphone, speaker`) have no `earphone/earbud/audio/bone conduction/tws`, and beauty is checked first (`wellness/supplement` wins ties). Mojawa's core SKUs classify only because their `product_type` happens to be "Headphones"; an "earbuds"-titled product or a URL-only audit falls to generic. Build the resolver from the **union of all three keyword sets** (`server.js:17176` is the most complete) and keep the `beauty|fashion|electronics|other` return shape.
- **Resolution is per-SKU, not per-merchant.** Merchant/audit-level value is a *default and override* only — a merchant selling beauty devices + skincare (or Mojawa adding a supplement) needs SKU-level truth. Persisted unit = the SKU.
- **Persistence must be durable, not `_SKU_CONTEXT_CACHE`** — that's an in-memory process dict (`agent_center_bd_report_service.py:1746`), invisible to the Node serving layer and gone on restart. The vertical needs a real column on the SKU/report row that both repos read. No such persistence exists today, which makes this item bigger than a day — see Phase 0.

Every downstream component *reads* the resolved vertical; nothing re-infers it. Resolution order: audit-level override → per-SKU `product_type`/category → title heuristics → `generic`. The serving side (`inferCategoryKind`) consumes the persisted value when present, keeping its heuristic only for products that never passed through an audit.

### Principle 2 — A `VerticalProfile` registry, not scattered constants

One registry (`services/vertical_profiles.py` in pivota-backend), one profile object per vertical. Components stop owning vertical knowledge and start consuming it:

| Profile field | Replaces (today's hardcode) | Beauty value | Electronics-audio value |
| --- | --- | --- | --- |
| `category_head_nouns` | `_CATEGORY_HEAD_NOUNS` (~L7994) | serum, sunscreen, shampoo… | headphones, earbuds, speaker, earphones… |
| `category_fallbacks` | `"beauty supplement"`/`"supplement"` hardcodes (~L7935) | keep | none — fall to `generic` |
| `attribute_strategy` | `sku_sidewalk` lexicons | `lexicon_first` (existing lexicons = fast path) | `llm_extractor` (see Principle 3) |
| `brief_rules` | `strategic_brief.py` prompt blocks L93–108 | ingredients rule, cosmetics claims bans | specs rule (plain-language specs, no spec-sheet jargon), electronics claims regime (safety/compat cautions; "waterproof/clinically tested" allowed *when substantiated*) |
| `health_sensitive` | `_health_sensitive` token list (L1947,1967) — **metadata flag, not a gate** (one call site, L868) | token-derived True/False | **False** (do NOT swap in electronics tokens — "battery/waterproof" would falsely flag earphones health-sensitive) |
| `publisher_avoid_list` | Vogue/Allure/Cosmo (L102) | keep | Wirecutter, Rtings, SoundGuys, What Hi-Fi |
| `retailer_tokens` | `_RETAILER_NAME_TOKENS` (L9380) | sephora, oliveyoung, coupang… | + bestbuy, bhphoto, crutchfield, newegg |
| `category_type_tokens` | `competitor_brand_filter._INGREDIENTS/_CATEGORY_FORM` (L75) | serum, glycinate… | earbuds, headphones, anc, bone conduction, tws… |
| `authority_hosts` | cited-host registries (`cited_host_classifier.py`, `canonical_source_discovery.py:45`) | K-beauty skew | rtings.com, soundguys.com, head-fi.org… |
| `pdp_completeness_checks` | `_vertical_for` branch (L2509) — **already per-vertical, fold in as-is** | ingredients/INCI | spec_groups, in_box, pro_reviews |
| `evidence_bindings` | INCI-only engine | `inci_grounded` (full) | `none` (v1) → `spec_claims` (future) |
| `grounded_coverage_disclosure` | *(new — honesty gate)* | full | "grounded-evidence dimensions unavailable for this category" |

Rules for the registry:
- **Additive-only on shared vocabularies.** The probe `axis` taxonomy and `_INTENT_AXES` are load-bearing and stay vertical-neutral — profiles feed *values* into template slots, never new axis names, and never rename existing ones.
- **One report schema.** No per-vertical report forks. A vertical with a missing capability emits the honest-empty/disclosed state for that section, same pattern as `coverage_unavailable`.
- **`generic` profile is the default**, not beauty. Unknown vertical → generic head-nouns off `product_type`, LLM attribute extraction, neutral brief rules, disclosure that evidence dimensions are unavailable. Beauty must become *a* profile, not *the* default — the pilot's litmus test is that deleting the electronics profile degrades Mojawa to honest-generic, never to beauty.
- **Granularity note:** `electronics_audio` deliberately mixes two levels — PDP checks (spec_groups/in_box/pro_reviews) are generic-electronics, authority hosts (Rtings/SoundGuys) are audio-specific. One flat profile is correct for the pilot; do **not** build registry inheritance now. Just keep the seam in mind so cameras/laptops later reuse the electronics PDP checks instead of re-forking them.

### Principle 3 — LLM extractor is the cross-vertical attribute engine; lexicons are per-vertical accelerators

Do **not** hand-write an audio lexicon as the fix for `sku_sidewalk`. That's a per-vertical treadmill and it's already the parked follow-up from the Korean-i18n work (PR #1126's noted long-tail gap). Instead:

- Build the **LLM attribute-extractor fallback** emitting into the *existing* `ATTRIBUTE_CLASSES` (`sku_sidewalk.py:17`: category, format, certification_constraint, audience, use_case, scenario, proof…) — those classes are already generic; only the lexicons filling them are beauty. `ingredient` maps naturally to a `key_spec` sense for hard goods (bone conduction, IP68, 32GB, 15-hr battery).
- Beauty keeps its lexicon as the deterministic fast path (cheap, tested, KR-aliased); LLM extraction runs when the lexicon yields nothing or the profile says `llm_extractor`.
- **Groundedness guard (non-negotiable):** extracted attributes seed *probe queries* — a hallucinated "IP68" becomes a real audit probe for a spec the product may not have, i.e. a confidently wrong report, the exact failure the `coverage_unavailable` honesty gates exist to prevent. Every extracted attribute must carry an **evidence span from the source page text**; attributes without a locatable span are discarded, never probed. The existing noise controls (promo/dedup filters) are *not* this guard — they check query hygiene, not truth. This guard, not the extractor plumbing, is the real Phase-2 work.
- Cache extraction results **durably** (same persisted row as the resolved vertical — `_SKU_CONTEXT_CACHE` is in-memory and re-pays extraction across workers/restarts) so re-audits don't re-pay extraction; the once-per-SKU cost argument depends on this.

This one component is what makes "more niche categories" plural: vertical #4 (say, pet supplements or home fitness) needs a profile entry, not an engineering sprint.

### Principle 4 — Evidence layer: bind per vertical, disclose per vertical, don't gate the pilot on it

The cross-vertical claim/evidence model (ProductClaim/EvidenceProfile, `models/catalog.py:134`) exists on paper and was explicitly designed for this (Phase-2 doc). Building the non-INCI population/grading path is its **own track** — spec claims (IP68, battery-hours) are actually *more* mechanically verifiable than beauty claims, which makes electronics a good second binding eventually. For the pilot: `evidence_bindings: none` + a first-class disclosure in the report. The serving-side claims extractor (`pivotaInsightsQuality.js:283`) is already shape-generic; it will simply be starved, which is correct.

### Principle 5 — Repo boundaries

- **pivota-backend**: everything in Part 2 phases 0–2 (resolver, registry, sidewalk extractor, brief rules, competitor/retailer tokens). This is where the audit pipeline lives.
- **PIVOTA-Agent (this repo)**: near-zero pilot work — electronics PDP container, generic schema profiles, and `electronics/audio` query routing already exist. One follow-up: `categories.js` (L265–430) has no electronics bucket (review note: the sportswear bucket keys on `sportswear/activewear/leggings`, not bare "sport", so mislabeling risk is low); fix opportunistically, it doesn't gate the audit.
- **pivota-agent-ui**: JSON-LD `additionalProperty` emission stays beauty-gated (flag default-off) — untouched by pilot.

### Duplication traps (name them now)

1. **A second category resolver.** Anyone adding electronics support to `categories.js` or a new keyword map in the report service re-creates the three-resolver problem. All new code reads the persisted vertical.
2. **Forking `strategic_brief.py` per vertical.** Prompt *rules blocks* come from the profile; the brief service stays single.
3. **Per-vertical query templates.** The shapes (`best {category}`, `{title} reviews`…) are proven neutral. Profiles supply slot values only.
4. **A hand-rolled audio lexicon in `sku_sidewalk`** (see Principle 3). Acceptable only as a tiny seed list to validate the extractor against, never as the mechanism.

---

## Part 2 — Electronics pilot work breakdown (Mojawa as design partner)

Sequenced so each phase is independently shippable; **~3 weeks total for phases 0–2** (revised up in review: durable vertical persistence + the extractor groundedness guard are the two items the original 1–2-week estimate missed).

**Phase 0 — Profile plumbing (the architecture):**
1. Shared vertical resolver (union of the three keyword sets per Principle 1, per-SKU) + **durable `vertical` persistence** on the SKU/report row readable by both repos (new column + write path — no such persistence exists today). (~2–3 days, revised up from ~1 after review: the durable spine is the real work)
2. `VerticalProfile` registry with `beauty`, `electronics_audio`, `generic`; migrate the *existing* beauty constants into the beauty profile behind identical behavior (golden-file check: re-run an ANUKO audit fixture, byte-identical report — valid for the deterministic layers only, see item 5 for the brief). (~2 days)
3. Kill beauty-default leaks: `"beauty supplement"`/`"supplement"` fallbacks and `_noisy_prompt_category` beauty blocklist become beauty-profile members; unknown vertical → generic. (~half day, covered by the golden-file check)

**Phase 1 — Electronics profile content (mechanical):**
4. Head-nouns, retailer tokens, category-type tokens, authority hosts, publisher list per the table above; set `health_sensitive=False`. **Before coding, re-trace each table row to its actual call site** — the review caught one row (`_health_sensitive`) scoped against a misread usage; assume nothing else was traced. (~1–1.5 days)
5. Brief rules block for electronics. The byte-golden check **cannot see brief-level leakage** (LLM output); add an **LLM-mocked brief snapshot test + a leakage assertion** (electronics brief output contains no INCI/ingredient tokens, no cosmetics-claims language like "repairs/clinical") so the next beauty change can't silently reintroduce it. Manual QA of the Mojawa brief is a sanity pass, not the guard. (~2 days)

**Phase 2 — LLM attribute-extractor fallback (the real engineering):**
6. Extractor → existing `ATTRIBUTE_CLASSES`, cached per SKU, noise-controlled, lexicon-first for beauty. Acceptance: Mojawa Purra Swim resolves ≥4 attributes (e.g. bone conduction / IP68-waterproof / swimming / 32GB-MP3) and generates sidewalk + constraint probes from them. (~3–4 days)
7. Regression: K-beauty SKUs still resolve via lexicon (no LLM cost on the happy path); thin-Korean-SKU case from PR #1126 improves rather than regresses.

**Phase 3 — Pilot run + honesty gates:**
8. Run mojawa.com audit (Shopify catalog path; `product_type` present so discovery queries generate even before Phase 2 lands).
9. Report-level disclosures: grounded-evidence dimensions unavailable for electronics (Principle 4); verify-coverage disclosure applies as everywhere.
10. Acceptance criteria for shipping the report to the partner:
    - attribute/constraint axis populated (not branded-only);
    - competitor panel free of type-name fake brands and of retailers-as-brands;
    - brief reads on-target for a sports-audio buyer (spot-check, no ingredient language);
    - all existing honesty gates clean (`succeeded_runs`/`failed_runs` authoritative, no fake-0s);
    - PDP-coverage section uses the electronics branch (spec_groups/in_box/pro_reviews).

**Phase 4 — Outreach / get-cited loop (partner-committed 2026-07-08):**

The partner expects the full loop, not audit-only. Most of it is shipped, vertical-neutral plumbing — but one dependency would silently zero the proof half if unaddressed:

11. **Citation-observation deposits must actually land for Mojawa.** Connected-merchant audits deposit **0** `citation_observations` today (the 0.85 identity deposit gate vs GTIN-less catalogs); the external-seed path clears the gate via `official_url`. Since Mojawa is Shopify, the natural onboarding is *connected* — which is exactly the blocked path. Decide before the pilot run, and note **both options carry hidden cost** (review 2026-07-08): (a) audit via the URL/external-seed path — free, but forfeits connected-store PDP-coverage depth **and risks the ADR-008 external_seed-vs-connected identity fragmentation** if Mojawa later connects; if choosing (a), pre-plan the reconcile-at-connect guard. (b) extend the deposit gate's `official_url` clearance to connected merchants — the more correct fix and it benefits beauty merchants too, but it **touches the 0.85 identity/trust invariant shared with beauty**; prototype behind a flag on a beauty test merchant to measure blast radius before trusting the ~1–2 day estimate. Without one of these, "did you get cited" renders permanently empty and the loop is dead on arrival.
12. **Audio authority hosts** (Rtings, SoundGuys, Wirecutter, head-fi…) in the profile registry — already Phase-1 item 4; they double as the outreach pitch-target list, so treat that list as partner-visible quality, not just classifier hygiene.
13. **Mark-sent → re-verify → proof loop**: shipped and shape-neutral (per-SKU citation flags fix already landed); reuse as-is. Auto-send stays parked.
14. **Expectation-setting in the pilot agreement:** the outcome spine populates *go-forward* from Mojawa's own audits/re-audits — there is no historical baseline, and first re-verify proof is realistically weeks after outreach begins, not at report delivery.

Phase-4 acceptance: after a mark-sent on one Mojawa SKU, re-verify runs and the proof panel renders against at least one audio-relevant host; `citation_observations` rows exist for the Mojawa audit (deposit gate confirmed cleared).

---

## Non-goals (explicit)

- **Cross-vertical evidence/substantiation engine** (non-INCI claim population + grading) — separate track; pilot ships with disclosure instead.
- **Electronics enrichment sources** (spec-sheet ingestion, pro-review licensing) — the electronics analog of the Hwahae/INCIDecoder problem; not scoped.
- **GTIN enrichment** — unchanged from its own scope doc.
- **New verticals beyond `electronics_audio`** — the registry makes them cheap later; adding them now is scope creep.
- **`categories.js` / taxonomy overhaul** in the serving layer — opportunistic fix only.
- **JSON-LD grounded-claims emission for electronics** — nothing to emit until the evidence track exists.

## Open questions

1. Extractor model + cost ceiling per SKU (candidate: same tier as strategic-brief LLM; cache makes it once-per-SKU).
2. ~~Does the partner expect the outreach/get-cited loop?~~ **Answered 2026-07-08: yes** — scoped as Phase 4; the open sub-question is deposit-gate option (a) vs (b) in item 11.
3. Where the audit-level vertical override surfaces in the portal UI (needed for miscategorized edge cases; can start API-only).
4. **Are the intent-axis *values* electronics-shaped?** The template shapes are verified neutral, but electronics buyers query by comparison/compatibility/spec ("bone conduction vs airpods for swimming", "does it work with iPhone", "waterproof rating") — verify during Phase 1 that the intent-axis seed values cover these, or add them via the profile. Claimed-neutral is not proven-neutral.
5. i18n: Mojawa is English/global so deferred, but note the beauty i18n prior art is *Korean*; electronics long-tail brands skew Chinese. Don't assume the PR #1126 path transfers.

## Recommendation

Accept the partner ask as a **named electronics pilot, ~3 weeks out**, gated on phases 0–2 + the acceptance criteria above — not a run of today's pipeline. The report delivery gates on phases 0–2; the outreach loop (Phase 4) starts at delivery and proves out over the following weeks — the deposit-gate decision (item 11) is the one Phase-4 item that must land *before* the audit run, or the proof loop starts from zero. Build Phase 0 first even though it ships no visible feature: it's the difference between "we added electronics" and "we can add categories." Beauty stays primary; the strategic value here is that the extractor + profile registry also fixes known *beauty* long-tail gaps (Korean thin-SKU attributes) — the expansion work strengthens the core vertical rather than taxing it.
