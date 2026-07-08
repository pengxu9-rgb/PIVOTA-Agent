# AI-Readiness — On-Demand Re-Test Loop (Step 5) — scoping plan

_Mini-plan for the "I changed X — did X improve?" loop, the last open step of the
page-usability redesign. For review BEFORE building. Created 2026-06-18._

## North-star
A merchant fixes a product (enriches a PDP, sends a pitch, adds content) and wants
to know — **on demand, now** — whether the SPECIFIC prompts they were trying to win
actually improved. Today the only "did it work?" signals are automatic + aggregate
(run-over-run trend sparkline, niche won/lost, outreach re-verify) and fire only on
the next full audit. The loop's job: **re-test the exact prompts the merchant cared
about, against the same SKUs, and show a per-prompt before→after** — honestly, with
the real cited-vs-retrieved discipline, at a credit cost the merchant sees first.

## The gap (code-grounded)
- **Run history is view-only.** `loadRunById`/`getAuditRunDetail`/`?run_id=` re-open
  a stored immutable snapshot; there is **no re-run-these-prompts path**.
- **`CreateAuditRequest` has no `from_run_id`** and prompts are **regenerated** every
  run (sidewalk + diagnostic spine) — so even re-selecting the same SKUs is **not**
  an apples-to-apples replay of a past run's prompts.
- A true re-test must **pin the prompt set** from the source run and re-probe exactly
  those, then diff.

## What EXISTS — reuse, don't rebuild (the key finding)
- **Arbitrary fixed-query probing already exists**: `_probe_per_sku_ctx(custom_prompts=…)`
  probes any merchant-supplied prompts as `axis="custom"`; `build_custom_prompt_results`
  scores them with the SAME honest cited-vs-retrieved discipline (alias-aware
  `extract_cited_hosts`, never fabricated). `CreateAuditRequest.custom_prompts` already
  carries them end-to-end.
- **The source run's prompts + results are recoverable** from its stored report:
  `per_sku_reports[].opportunity.per_prompt[]` (query + cited evidence + cited hosts),
  plus `win_plan` losing queries + `custom_prompts` results. So we can extract the
  exact (sku, query, was-cited) set the merchant wants to re-test.
- Run history + `getAuditRunDetail` + the merchant_tasks/outreach lifecycle.

## Recommended v1 — FOCUSED re-test via the custom-prompt path (no new pipeline)
The cheapest, honest first slice — and arguably the RIGHT product framing (re-test
what you fixed, not re-run everything):
1. From a past run's report, let the merchant pick **up to N prompts to re-test**
   (default-select the ones worth checking: the **failing/targeted** prompts — not
   cited, or the win-plan losing queries, or prompts they acted on). Cap = the existing
   custom-prompt slot budget (today 10) → bounded cost.
2. Launch a **focused re-audit on the same SKU(s)** with those prompts fed as
   `custom_prompts` (reusing `_probe_per_sku_ctx` + `build_custom_prompt_results`). Tag
   the new run as a re-test of the source (`retest_of_run_id` in the run metadata).
3. **Paired before→after**: for each re-tested prompt, show source result (cited? which
   hosts?) → new result, with a clear "now cited ✓ / still not cited / newly lost"
   verdict. Source values come from the stored run; new values from the custom-prompt
   results. Render in a dedicated "Re-test results" panel (or fold into Zone 4 "Is it
   working?").
4. Credit cost = N prompts × per-prompt rate (custom prompts already cost 1/40 of a SKU
   each) — **shown in the preview before launch**, like any audit.

Why v1 this way: zero new probe/scoring machinery, fits the existing cap + cost model,
and answers the merchant's actual question ("did the prompts I fixed improve?") rather
than an expensive full re-run.

## v2 (later) — FULL-RUN replay via `from_run_id`
For "re-run the entire audit's prompts": add `from_run_id` to `CreateAuditRequest`; the
audit pipeline, instead of generating queries, replays the source run's full probed
(sku, query) set (bypassing `_build_per_sku_audit_query_records`); link runs
(`retest_of_run_id`) and diff every prompt. Heavier (a fixed-query mode in the per-SKU
fanout + full-run cost) and mostly redundant with the automatic trend — defer unless v1
demand shows merchants want the whole-run replay.

## Design forks — to confirm before building
1. **Which prompts default-selected for re-test?** Recommend: the **failing + targeted**
   ones (not-cited prompts + win-plan losing queries the merchant has a play for), since
   that's what a fix targets. (Alt: let the merchant free-pick any.)
2. **Where do before/after render?** Recommend a focused **"Re-test results"** view
   (paired rows) reachable from the source run + Zone 4; not jammed into the main report.
3. **Cap / cost.** Recommend the existing ≤10 custom-prompt cap for v1 (bounded, cheap).
   A higher cap or full-run = v2.
4. **Provider.** Re-test with the **same provider(s)** as the source run (comparability).
5. **Linking.** Store `retest_of_run_id` on the new run so history shows "re-test of
   {date}" and the pairing is durable.

## Honesty guardrails (locked, consistent with the rest of the audit)
- "Improved/now cited" is earned by a REAL probe with the same cited-vs-retrieved
  discipline — never inferred, never fabricated.
- Credit cost shown + confirmed before launch (no silent spend).
- A re-test is a real audit run (counts in history); label it as a re-test, don't
  pretend it's the original.
- Prompt identity matched on normalized query (same as reconciliation/dedup).

## Acceptance (v1)
- From a past run, the merchant selects ≤N prompts (failing ones pre-selected), sees the
  credit cost, launches, and gets a per-prompt **before→after** with honest verdicts
  ("now cited ✓ / still not cited"), sourced from a real re-probe — verified live on a
  prompt that was not cited then is/ isn't cited now.

## Open question for the build
Confirm the design-fork choices above (esp. #1 default-selected prompts + #2 where
before/after renders), then build v1 (backend: tag + extract source prompts; portal:
select-and-relaunch + paired-results view). v2 (`from_run_id` full replay) deferred.

## STATUS — v1 SHIPPED 2026-06-18 (portal #90 → Vercel 0f776dc)
RetestPanel in Zone 4: lists the win-plan losing queries ('not cited yet'), 1-click re-test via the custom-prompt path (onAddPrompts injection, <=10 cap). Before = not-cited (definition of losing); after = the re-run's CustomPromptsPanel result. Portal-only, no new probe machinery. v2 (explicit side-by-side before/after + from_run_id full-run replay + retest_of_run_id linking) DEFERRED — build if v1 shows demand.
