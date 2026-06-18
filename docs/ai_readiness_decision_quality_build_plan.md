# AI-Readiness "Where You Can Win" + "What To Do" — Decision-Quality Upgrade

_Build plan & tracker. Make the two weakest report sections best-in-class by SURFACING the
decision-grade fields the audit already computes (and ranking by the signals that already exist).
Pairs with the query-axis + outreach-loop plans. Created 2026-06-18._

## North-star (anti-drift anchor)
Both sections are **data-rich, decision-poor**: the audit computes gold-standard analysis (winnability
score, why-decomposition, the **verbatim AI answer**, the single `first_move`, `priority_order`,
`expected_outcome`) then **drops the best parts at the render layer**. The job is to **surface what's
already computed** and **rank by impact** — matching how Ahrefs/Semrush/Profound present opportunity +
action. Almost zero new analysis. If a step recomputes something already in `per_prompt`/NBA/task
evidence, it's drift.

## The problem (code-grounded 2026-06-18, holistic review)
- **"Where you can win"** (`WhereYouCanWinPanel`, page.tsx): renders `query` + a movement pill +
  `why_you_fit` + a "Create the answer" CTA. HIDES the computed `opportunity_score`, `opportunity_factors`
  (the why-decomposition), `demand_state`, and — worst — **`cited_evidence.excerpt`** (the verbatim AI
  answer is computed in `per_prompt` and never forwarded by `build_where_you_can_win`). The "don't fight"
  column dominates, is struck-through/discouraging, and is **evidence-starved** (the builder pulls
  competitor names out of `cited_evidence` but throws away the quote). Empty → panel **vanishes silently**.
- **"What do I do next?"** — two paths: (A) per-SKU NBA (`PerSkuNextStep` / `next_best_action.py`):
  text is GOOD/specific, but **`first_move`** (the one-line action) is computed and used ONLY to gate
  visibility — never rendered; `secondary_moves`/`evidence_summary`/full `tracking_metrics` dropped; no
  impact/effort. (B) Action plan (`MerchantTaskQueuePanel`): sorts by **status-then-created_at**, so a
  `low` task can sit above a `critical` one; **`priority_order`** is stored in every task's
  `evidence_jsonb` and **never read**; `cta_url`/`cta_label` stored, never rendered; `expected_outcome`/
  `kpi_to_track` exist only on the sibling `action_plan_items` table, never joined into the panel.

## What EXISTS — reuse, don't recompute
- `opp.per_prompt[]` rows (`sku_opportunity.py:330-368`): `opportunity_score`, `opportunity_factors`
  {attribute_fit, intent_weight, demand_signal, density_inverse, volume_proxy, actionability, confidence},
  `cited_evidence` {provider, excerpt≤400, cited_hosts, competitors_named}, `demand_state`, `competitors`.
- `build_where_you_can_win` (`agent_center_bd_report_service.py:5361-5446`) picks the best per_prompt row
  per target/skip — just forward more of it.
- NBA payload (`next_best_action.py:_base_payload`): `first_move`, `secondary_moves`, `evidence_summary`,
  `tracking_metrics[]`, `cta{label,action,target_sku_key}` — typed/emitted, mostly unrendered.
- `merchant_tasks.evidence_jsonb`: `priority_order`, `cta_url`, `cta_label`, `target_host` — stored,
  unread. `action_plan_items` has `expected_outcome`/`kpi_to_track` (different table).

## Locked design decisions
- **Surface, don't recompute.** Reuse existing fields end-to-end.
- **Lead with proof + the one action.** The verbatim AI excerpt and `first_move` are the headline assets.
- **Rank by impact.** Action plan sorts `priority_order` then severity; opportunities by `opportunity_score`.
- **Honesty preserved.** The excerpt is real AI output (cited-vs-retrieved discipline intact); never
  fabricate; render only REAL `cta_url`s (skip the known no-ops like request_indexing).
- **Honest empty states** — panels never vanish silently.

## Guardrails
- No new probe/scorer; forward computed fields only.
- Don't render no-op CTAs as if actionable (request_indexing is informational today).
- Excerpts are merchant-facing → keep the ≤400-char cap + attribute the source host/provider.
- Additive types only (no breaking renames — the axis lesson).

## Progress tracker (prioritized by impact / effort)
| ID | Step | Surface | Status | PR |
|----|------|---------|--------|----|
| 1 | ✅ **Verbatim AI evidence** — forward `cited_evidence.{excerpt,cited_hosts}` onto WYCW target+skip rows; render the quote ("AI literally said…") in win rows AND the don't-fight list (proof of the routing) | backend + portal | ✅ done | backend #934 · portal #82 |
| 2 | ✅ **`first_move` headline** — render the one-line action at the top of the per-SKU next-step | portal | ✅ done | portal #82 |
| 3 | ✅ **Action plan priority** — sort status → `priority_order` → severity (fixes low-above-critical) | portal | ✅ done | portal #82 |
| 4 | **Winnability score + why-decomposition** — forward `opportunity_score`/`opportunity_factors`/`demand_state`; render a score + mini "why winnable" on win rows | backend + portal | ☐ | — |
| 5 | **Outcome contract on tasks** — surface `expected_outcome`/`kpi_to_track` (join `action_plan_items` or carry into task evidence) + render real `cta_url`/`cta_label` | backend + portal | ☐ | — |
| 6 | **Honest empty states** — WYCW + per-SKU next-step never vanish ("we probed N; none cleared the bar yet — add SKUs/attributes/custom prompts") | portal | ☐ | — |

## Acceptance & verification
- **Step 1:** a win row and a don't-fight row each show the verbatim AI excerpt + the host AI cited; the
  excerpt is the real per_prompt `cited_evidence` (≤400 chars, attributed). No fabrication.
- **Step 2:** the per-SKU next-step leads with `first_move` text (not just the headline/why).
- **Step 3:** tasks render in `priority_order` (then severity); a critical task never sits below a low one;
  a "Do these first" top-3 is visible.
- **Step 4:** each win row shows its 0–100 score + a why breakdown.
- **Step 5:** each task shows an expected outcome / KPI; real CTAs render as links/buttons (no no-ops).
- **Step 6:** thin audits show an honest empty message, never a vanished panel.

## Change log
- 2026-06-18 (a) — plan created from the holistic gold-standard critique. Thesis: data-rich, decision-poor
  — surface computed fields + rank by existing signals. Top-3 quick wins (1,2,3) first.
- 2026-06-18 (b) — top-3 quick wins shipped: verbatim evidence (backend #934 forward + portal #82 render), first_move headline (#82), priority_order sort (#82). Remaining: 4 (score+why-decomp), 5 (outcome/KPI+CTA), 6 (honest empty states).
