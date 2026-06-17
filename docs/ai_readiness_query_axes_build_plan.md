# AI-Readiness Query-Axis Expansion — Build Plan & Tracker

_Single source of truth for diversifying the AI-readiness audit's probe queries from "superlative
head terms" into a deterministic, separately-scorable intent taxonomy — plus a cross-model judge
layer. Update the status table as steps land. Pairs with memory
`ai-readiness-action-plan-integration-map.md`, `tiered-audit-provider-model`, and the redesign tracker._

_Created 2026-06-17 · Revised 2026-06-17 (LLM-authored templates + judge layer + two-pass comparison;
corrected to the real credit-driven billing model — no free model tier)._

## North-star (anti-drift anchor — re-read before any step)
A shopper asks an AI agent to shop in **many intent shapes** — problem-first, comparison, constraint,
trust — not just "best {category}". The audit must measure discoverability across those shapes so a
merchant learns **where they can actually win** (winnable long-tail) vs **what retailers own** (head
terms), and **trust the verdict** (not one model's quirk). The bar is *merchant insight*, not query count.

## The problem (confirmed 2026-06-17, code-grounded)
Auto-generated category queries collapse to ~2 intent shapes, overwhelmingly `{superlative} {category}`
permutations. Consequences: (1) redundant signal — ~10 near-synonym head probes measure one thing;
(2) **ingredient-competitor bug at the source** — `{cat}` = `product_type` = an *ingredient*
("collagen") → `best collagen` → ingredient-type rundown → extraction harvests ingredient types as
"competitors" ([[#1b filter task]] `task_f52542dc`); (3) brittle hardcoded `2026` / `under $50` on the
deepseek surface; (4) downstream starvation — "Where you can win" is empty because we only probe
retailer-owned head terms.

**Myth busted:** no LLM generates the queries today. `deepseek_probe.py:_build_query_strings` is plain
Python f-string templates that live in the DeepSeek provider module. Model roles in the per-SKU audit:
**Gemini** = grounded-search probe (the measurement), **ChatGPT** = secondary probe, **DeepSeek** =
answer-quality verifier (the cross-model judge that exists but was skipped).

## Billing model (corrected 2026-06-17 — read before reasoning about cost)
**Every model charges credits** — Gemini is the *lowest-credit* option, ChatGPT/Claude cost more; there
is **no free model**. Coverage is **credit-driven and merchant-chosen** (which models, how many SKUs ×
prompts), previewed before launch, never auto-shrunk. The only "free" is a **2-audit new-user promotion
absorbed by Pivota** (acquisition) — orthogonal to coverage design. Implication for this plan: don't add
silent credit cost. The diversified axes must **rebalance within the existing prompt budget** (same
credits as today at equal coverage); the expensive extras are **opt-in coverage** the merchant pays
credits for and sees in the cost preview.

## Architecture — two layers
1. **Deterministic templated axes** — the *trended core*. Query SHAPES are **LLM-authored offline,
   reviewed, frozen** into code; runtime fills slots from the SKU attribute graph deterministically.
   LLM creativity at design time, determinism at runtime → period-over-period deltas stay valid.
2. **Cross-model judge layer** — a *second model verifies key findings* (e.g. "not cited") to cut
   single-model bias. Reuses the existing answer-quality-verify path (DeepSeek challenging Gemini).
   **Nondeterministic → kept OUT of the trended metric** (confidence annotation); pinned where possible.

## Two surfaces (both in scope)
| Surface | Generator | Feeds |
|---|---|---|
| **A. Per-SKU AI-readiness audit** (redesigned page) | `agent_center_bd_report_service.py:6130` `_unbranded_category_specs` → `_build_per_sku_base_query_specs` (:6190) → `_build_per_sku_audit_query_records` (:6484) | Gemini + ChatGPT per-SKU probes |
| **B. Brand / BD / cold-start + content-brief** | `deepseek_probe.py:78` `_build_query_strings` (scan-mode) | brand scan, content-brief ("best Serums 2026") |

Query schema (A): `(query, axis)` → `{"query","axis"}`. Existing axes: `intent`, `category`,
`attribute`, `identity`. Slots: `build_sku_attribute_graph(product)` (use_case / exclusion / ingredient
/ proof / cert / audience) + `product_enrichment` (topic_tags / usage_scenarios / bullets).

## Locked design decisions (the agreed spec)
- **Templates are LLM-authored-then-FROZEN, not LLM-generated at runtime.** Determinism for trends.
- **Keep bare-`{cat}` as ONE small `category_head` axis** (diagnostic: retailer/ingredient-owned
  surface). Winnable axes are **attribute-graph framed** → fixes the ingredient-competitor bug at source.
- **`comparison` axis = two-pass probe** (user decision): pass 1 probes category, extract top real
  competitor, pass 2 probes `{cat} vs {competitor}`. Costs a bounded second pass → **opt-in coverage**.
- **Cross-model judge verifies findings** — off-trend; **opt-in coverage** (extra credits).
- **Credit-driven, no free model** (corrected): the **default** audit runs the rebalanced single-pass
  axes → **same credits as today** at equal coverage (rebalance the budget, don't inflate it). Two-pass
  comparison + the judge layer + extra providers are **opt-in, priced in the pre-launch credit preview**.
  New users' 2 promo audits are Pivota-absorbed and orthogonal.
- **#1b ingredient filter stays** (brand-vs-ingredient judge NOT selected) — backstop once the
  attribute-graph reframe reduces ingredient "competitors" at source.
- No hardcoded year/price in new templates; on Surface B derive band from SKU price or omit, drop year.

## Proposed axis taxonomy (Surface A; B mirrors supported shapes)
| Axis (named) | Shape(s) | Slot source | ~Budget | Coverage | Status |
|---|---|---|---|---|---|
| `category_head` (demote) | `best {cat}`, `what {cat} should I buy` | product_type | 2–3 | default | ☐ |
| `navigational` (keep) | `where can I buy {identity}`, `shop {identity} online` | resolved identity | 2 | default | ☐ |
| `problem_jtbd` (new) | `best {cat} for {use_case}`, `what helps {problem}`, `{cat} for {benefit}` | attr graph use_case/benefit/audience; enrichment | 3 | default | ☐ |
| `constraint` (promote sidewalk) | `{exclusion} {cat}`, `{cert} {cat}` ("vegan collagen") | attr graph exclusion/cert/ingredient | 2 | default | ☐ |
| `trust` (new) | `is {brand} legit`, `does {identity} actually work`, `{brand} reviews` | identity/brand | 1–2 | default | ☐ |
| `comparison` (new, two-pass) | `{cat} vs {competitor}`, `alternatives to {competitor}` | pass-1 extracted top competitor | 2 | **opt-in** (extra credits) | ☐ |

Default single-pass axes ≈ 10–12 prompts, **rebalanced from today's ~10 redundant superlatives →
credit-neutral at equal coverage**. `comparison` revives the slot `_budgeted_wedge_query_records`
(:6420) reserves but never fills.

## Guardrails — check EVERY step before coding
- **Determinism (templated axes):** same SKU → same queries; axis tag preserved end-to-end so trend
  deltas compare like-for-like per axis. Additive axes + demoted `category_head` are safe; flag any
  change to an *existing* axis's templates affecting historical comparability.
- **Judges off the trend:** never feed a nondeterministic judge output into a trended score; render it
  as a confidence/verification annotation. Pin temp/seed.
- **No silent credit inflation:** the default audit's prompts/SKU ≤ baseline (assert in a test).
  Two-pass + judge + extra providers add credits ONLY when the merchant opts in, and the delta appears
  in the pre-launch cost preview. Never auto-shrink scope to fit balance — merchant decides.
- **Ingredient-bug-at-source:** after the reframe, a collagen SKU shows fewer ingredient "competitors"
  even with #1b disabled. Don't double-pay — note the overlap.
- **Reuse, don't rebuild:** slots from `build_sku_attribute_graph` + enrichment + the competitor Counter
  exist; judge reuses the answer-quality-verify path. No new scorer, no runtime query-gen.
- **Honesty:** no slot data → fewer queries, never a fabricated `{use_case}`/`{competitor}`.

## Progress tracker
| ID | Step | Surface | Coverage | Status | PR |
|----|------|---------|----------|--------|----|
| 0 | Lock taxonomy + architecture + billing model (this doc) | — | — | ◐ review | — |
| 1 | **LLM-author** the axis templates (realistic shopper phrasings per axis) → review → **freeze**; demote `category_head`; slot-fill from attr graph/enrichment | A | default | ☐ | — |
| 2 | Preserve `axis` through scoring → per-axis trendable; revive/clean the dead `comparison`/`review` budget slots | A | default | ☐ | — |
| 3 | `comparison` two-pass: extract top competitor pass-1 → probe `{cat} vs {competitor}` pass-2 (opt-in; priced in preview) | A | opt-in | ☐ | — |
| 4 | Cross-model judge: second model verifies key findings (off-trend annotation; opt-in) — reuse answer-quality-verify path | A | opt-in | ☐ | — |
| 5 | Surface B: expand deepseek scan-mode shapes; drop hardcoded `2026`/`under $50` (derive band or omit) | B | — | ☐ | — |
| 6 | Confirm `{cat}` reframe; measure ingredient-"competitor" drop (filter disabled) | A+B | — | ☐ | — |
| 7 | Verify default-audit credit-neutral + per-axis trend validity; quantify opt-in credit delta in cost_summary | A | — | ☐ | — |

## Acceptance & verification (fill before coding each step)
- **Step 1:** per-SKU audit emits ≥5 named axes; ≥1 problem_jtbd + ≥1 constraint query slot-filled from
  the SKU's real attribute graph. The frozen template bank is reviewed/checked in (not runtime-generated).
- **Step 2:** each probed query carries `axis`; per-axis citation breakdown computable; two runs of one
  SKU → per-axis deltas align; no axis silently dropped.
- **Step 3:** on a re-audit, a `comparison` query names a real competitor from pass-1; first run degrades
  to competitor-free shapes; opt-in flag + credit delta shown in preview.
- **Step 4:** a finding carries a second-model verification flag; the flag never enters a trended score.
- **Step 5:** brand/BD + content-brief emit new shapes; no hardcoded year/`$50`; unit test per scan mode.
- **Step 6:** collagen SKU, filter OFF → materially fewer ingredient-type competitors vs old query set.
- **Step 7:** default prompts/SKU ≤ baseline (credit-neutral); trend delta on an unchanged SKU ≈ 0 per
  axis; opt-in credit delta quantified in cost_summary.

## Related / downstream
- [[#1b filter task]] (`task_f52542dc`) — ingredient→competitor filter; backstop after Step 6.
- **"Where you can win" empty** (#4) — winnable long-tail should populate open lanes; re-check after Step 1.
- **Per-model split** (#3, Gemini vs ChatGPT) — separate thread; provenance already captured
  (`authority_map.provider_counts`), blended at render.

## Decisions / change log
- 2026-06-17 (a) — plan created; 6-axis taxonomy; `{cat}` = one diagnostic `category_head` axis.
- 2026-06-17 (b) — BOTH surfaces in scope; plan-before-code.
- 2026-06-17 (c) — `comparison` = two-pass; architecture = LLM-authored frozen templates + cross-model
  judge for finding verification; brand-vs-ingredient judge NOT adopted (keep #1b filter).
- 2026-06-17 (d) — **billing model corrected:** every model charges credits (no free model; Gemini =
  lowest-credit). "Free" = 2-audit new-user promo absorbed by Pivota. So: default axes rebalance to be
  **credit-neutral**; two-pass + judge + extra providers are **opt-in, priced in the cost preview**
  (was wrongly framed as free/paid tiers).
