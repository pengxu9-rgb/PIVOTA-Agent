# AI-Readiness Report Page — Usability Redesign (make it usable, not a prototype)

_Consolidated build plan & tracker, written from a code-grounded holistic review of the
LIVE page (deployed `main`: portal `35716ae`, backend `015ab162`), 2026-06-18. This plan
supersedes the piecemeal panel-by-panel work; it fixes the page as a whole. Nothing here
is "done" — every step is ☐ until shipped AND eyeballed on a real audit._

## North-star (anti-drift anchor — re-read before any step)
A merchant opens the report and, in one read, knows: **(1) am I winning, (2) what exactly do
I do next, (3) is what I did working.** Every section must be either a *finding about this
audit* or a *thing the merchant can act on* — never internal plumbing, never the same data
twice, never present-day state masquerading as this audit's result. If a section can't answer
"so what do I, the merchant, do with this?", it doesn't belong on the page.

## The root cause (the one diagnosis that explains all four complaints)
The page **conflates two different objects** and renders them in one undifferentiated scroll:

- **THE REPORT** — an *immutable snapshot* of findings from the audit run on a given date
  (scores, where-you-can-win, win-plan, suggested prompts). Read from the `report` payload.
- **THE WORKSPACE** — the merchant's *live, account-wide, audit-independent* operational state
  (task queue, agent-activity feed, outreach status). Three panels **self-fetch present-day
  state and ignore the loaded report entirely.**

Because the two are interleaved, opening *any* report (fresh or historical) stitches **today's**
tasks + agent activity into it. That single conflation produces every symptom the merchant hit:
stale "30 days ago" activity, duplicated scorecards, an action plan that doesn't match the
audit, and a "did my fix work?" loop that never closes on the thing they actually changed.

## The four complaints, validated against code (none are cosmetic)
1. **"I don't understand the action plan."** `MerchantTaskQueuePanel` self-fetches the task list
   (NOT `report`). Most strategic tasks are stored with **no `cta_url`** → render as inert
   title+severity text with only "Mark done". `expected_outcome`/`kpi_to_track` are populated
   only when the task title hits ~8 keywords (`_v2_metadata_for_action`,
   `agent_center_bd_report_service.py:10204`); every other task shows neither. The "On your
   store / On Pivota" split is a client-side title heuristic ("On Pivota" is the default
   fallback bucket). Header claims "across all audits" but the backend scopes to latest run +
   standing tasks. Supersession only de-dupes `pending` tasks on exact host+product match and
   never `in_progress` → stale tasks accumulate with no age/context.
2. **"Pivota agent activities ran 30 days ago — what does that mean?"**
   `MerchantExecutorActivityPanel` fetches the latest 30 executor runs **globally, unscoped to
   the audit** (`recent_runs_for_merchant`, `executor_runs.py:296` — no `parent_audit_run_id`,
   no time filter). A fresh audit usually dispatches **no** new runs (agents are flag-gated;
   GSC submit default-off), so real-but-month-old runs show under a header that claims "what
   Pivota did **on your most recent audit**." Rows are internal agent names + technical
   evidence — plumbing surfaced without merchant meaning. Same agent also appears as "by
   Pivota" tags in the action plan (concept shown twice).
3. **"Why is 'Your products' at the bottom — is it a duplicate?"** `PerSkuCardList` is *technically*
   the per-SKU drill-down behind the brand medians in Zone 1 — but the same 4 dimensions +
   model strip render at brand level (top) AND per-SKU (bottom), it sits **below** the action
   plan so it reads as "scores again," and the one genuinely useful per-product action
   (`PerSkuNextStep` "Make this product AI-ready") is **buried inside each collapsed card**.
   (The team already deleted one duplicate of this from the narrative panel — same smell.)
4. **"Follow-up test on a history run is missing."** Confirmed — and it was **deliberately cut**.
   History is view-only (immutable snapshots, re-openable). There is **no** way to re-test a past
   run's exact prompts/SKUs on demand; a "re-run" means manually re-selecting SKUs and the prompt
   set regenerates from scratch (not apples-to-apples). The only "did it work?" signals (trend
   sparkline, niche won/lost, outreach re-verify) are **automatic-only + aggregate**. The redesign
   doc explicitly killed "per-task re-crawl" and a "live test-a-prompt lab" as gold-plating
   (`ai_readiness_redesign_build_plan.md:65-69`). That product call is the thing to revisit.

## The target design — separate THE REPORT from THE WORKSPACE
Make the two objects explicit instead of interleaved. Same 4-zone narrative, re-anchored:

- **Zone 1 · Am I winning?** — the verdict + the evidence, as ONE coherent block.
  - Brand cover becomes a true **summary** (headline AI-readiness number + honest verdict),
    not a parallel scorecard.
  - **"Your products" moves UP to here** as the drill-down *behind* the summary (it IS the
    analysis), with the per-product **"Make this AI-ready"** action surfaced, not buried.
  - Keep CitationByIntent + MerchantNarrative (evidence-rich, already good).
  - Kill the brand-vs-SKU score duplication: brand = 1-line roll-up, SKU cards = the detail.
- **Zone 2 · How can I improve?** — the recommendations (unchanged in spirit; already the
  strongest zone). WinPlan, WhereYouCanWin, SuggestedPrompts, CustomPrompts. These *generate*
  workspace items (Create-the-answer, Mark-sent, Add-prompt).
- **Zone 3 · What do I do next?** — THE WORKSPACE (live, cross-audit, clearly labeled as such).
  - **Every task must be actionable**: a real CTA (do-it-here / open-form / mailto) OR a
    concrete self-serve instruction. A task with no next click is not a task — fix the backend
    to populate CTA + outcome for the bulk strategic tasks, or don't materialize them.
  - **Agent activity**: scope to outcomes, not plumbing. Either fold "✓ done by Pivota" rows
    INTO the action plan and delete the standalone stale feed, OR scope it to the viewed run +
    reframe in merchant outcomes ("refreshed your sitemap → 12 PDPs resubmitted"). Decision below.
- **Zone 4 · Is it working?** — the proof over time. Trend + outreach proof stay; add the
  **follow-up re-test loop** (the real "I changed X, did X improve?") — see Step 5 / product call.

## Cross-cutting fix — the leaky snapshot
The report body (Zones 1-2) is immutable per run, but the three self-fetching panels show
present-day state even on a historical run. **Scope task/activity/outreach to the run being
viewed** (or, when viewing history, clearly separate "this is a past report" from "your live
workspace"). Pick one model and apply it consistently (decision below).

## What EXISTS — reuse, don't rebuild
- All panels + the 4-zone shell already exist (`page.tsx` `PerSkuAuditReportRenderer`).
- Task store + supersession + outcome/CTA fields (`merchant_tasks`, `task_queue_service.py`,
  `evidence_jsonb`) — the schema already HAS `cta_url`/`expected_outcome`/`kpi_to_track`/
  `priority_order`; they're just sparsely populated.
- Per-SKU drill-down + per-product action (`PerSkuCardList` + `PerSkuNextStep` +
  `submitProductEvidence`) — needs relocation + surfacing, not rebuilding.
- Run history + immutable snapshots + deep-link (`RecentAuditsPanel`, `getAuditRunDetail`,
  `?run_id=`) — the re-test loop builds on this (store the run's prompt set; add `from_run_id`).
- Trend / niche-movement / outreach-reverify (`_build_history_trend`, `niche_outcomes.py`,
  `reverify_outreach_records`) — the automatic signals; the on-demand re-test complements them.

## Locked design decisions
- **Report = snapshot; Workspace = live.** Make the distinction explicit in the UI; never let
  live state silently overwrite a historical report's meaning.
- **No inert tasks.** Every workspace task carries a concrete next action + a one-line outcome,
  or it isn't shown as a task.
- **No plumbing as a merchant section.** Internal agent names/telemetry never headline a zone;
  surface outcomes, not executor identities.
- **One scorecard.** Per-SKU dimensions appear once (the drill-down); brand level is a summary.
- **Honesty preserved.** Immutable runs stay immutable; the re-test loop costs credits and says
  so; "cited"/"done"/"improved" are earned, never faked.

## Guardrails — check EVERY step
- Don't break the immutable-run contract (old payloads must still render; additive fields only).
- Don't double-charge or auto-probe; any on-demand re-test is explicit + cost-previewed.
- Keep the `axis` tags + per-intent additive (the load-bearing-rename lesson).
- A historical report must never *look* like it's reporting today's tasks/activity.

## Progress tracker (prioritized by merchant impact / effort)
| ID | Step | Surface | Status | Notes |
|----|------|---------|--------|-------|
| 1 | **Make the action plan actionable** — outcome+KPI on every task; persistent cross-audit scope + scope-aware reconciliation; honest lanes; inline next-step. | backend + portal | 🟢 merged + deployed (NOT yet eyeballed on a real audit) | backend #939 (330e9b02) · portal #85 (Vercel) · mailto-CTA-in-row deferred |
| 2 | **Fold "Pivota agent activity" into the action plan** — "✓ done by Pivota" rows in the workspace, dated correctly; DELETE the standalone `MerchantExecutorActivityPanel` feed. (Decision A, locked.) | portal | ☐ | Kills the "30 days ago" confusion + the duplicate. |
| 3 | **Restructure Zone 1 + relocate "Your products"** — move per-SKU cards up as the drill-down, surface the per-product "Make AI-ready" action, make brand cover a true summary (no duplicate scorecard). | portal | ☐ | Fixes the "duplicate at the bottom" + buries-the-action problem. |
| 4 | **Close the leaky snapshot** — scope task/activity/outreach to the run being viewed (or cleanly separate past-report vs live-workspace). | portal + backend | ☐ | Makes historical runs honest. |
| 5 | **Follow-up re-test loop** — re-run a past run's EXACT prompt/SKU set on demand for a true before/after ("I fixed X — did X improve?"). Store the run's prompt set; add `from_run_id` to create-audit; show paired deltas. **PRODUCT CALL** — was cut as gold-plating; costs credits. | backend + portal | ☐ | The "did my fix work" loop the merchant actually wants. |

## Acceptance & verification (the bar for each step — eyeball on a REAL audit)
- **Step 1:** every row in the action plan has a concrete next action (link/form/mailto/clear
  instruction) + a one-line "what success looks like." Zero inert title-only rows. Header text
  matches the actual scope.
- **Step 2:** no standalone stale agent feed; Pivota-done work appears once, dated correctly,
  framed as outcomes.
- **Step 3:** per-SKU scores appear exactly once; the per-product action is visible without
  expanding a card; brand cover reads as a summary, not a second scorecard.
- **Step 4:** opening a historical run shows that run's tasks/activity (or an explicit "this is
  a past snapshot; your live list is here") — never today's list silently.
- **Step 5:** from a past run, one click re-tests the same prompts and shows per-prompt
  before/after, with an honest credit-cost preview first.

## Product decisions — LOCKED 2026-06-18
1. **Action plan scope = PERSISTENT WORKSPACE.** One living cross-audit to-do list; each audit
   adds/supersedes items. The UI claim is correct — fix the BACKEND to actually honor it
   (broaden scope beyond `latest_completed`; harden supersession so stale/started tasks don't
   pile up). Drives Steps 1 + 4.
2. **Agent-activity = FOLD INTO the action plan.** Show "✓ done by Pivota" rows inside the
   workspace, dated correctly; **delete the standalone `MerchantExecutorActivityPanel` feed.**
   Kills the "30 days ago" confusion + the duplicate in one move.
3. **Re-test loop (Step 5) = BUILD IT.** Revive the cut feature — it's the merchant's stated
   need. Re-run a past run's exact prompt/SKU set on demand; **credit cost shown upfront**;
   adds a `from_run_id` audit path; show per-prompt before/after.

## Change log
- 2026-06-18 (a) — plan created from a code-grounded holistic review (3 parallel investigations
  against deployed `main`). Root cause = REPORT (snapshot) vs WORKSPACE (live) conflation. All
  four merchant complaints validated in code; none cosmetic. Prioritized: action-plan
  actionability (1) → agent-activity (2) → Zone-1 restructure (3) → snapshot leak (4) → re-test
  loop (5, product call). Nothing built yet.

## Change log (cont.)
- 2026-06-18 (b) — Step 1 BUILT (not merged), in two worktrees:
  - **Backend** (`pb-step1`, 2 commits): (1) every action-plan task gets a concrete
    `expected_outcome` + `kpi` — closed the 6 uncovered families + an honest generic
    fallback (reversed the prior "leave it blank" stance, justified); (2) default task
    scope = PERSISTENT cross-audit workspace on BOTH merchant + BD routes; scope-aware
    audit-completion reconciliation closes prior-run pending tasks the latest audit
    dropped (per-product tasks only if THIS audit re-covered that product → no SKU-B
    audit closing SKU-A tasks; brand tasks always; in_progress + standing NULL-parent
    exempt; recoverable). Tests: recommendation_engine_v2, task_queue_scope (3 reversed),
    task_reconciliation (new) — 56+ pass.
  - **Portal** (`pmp-step1`, 1 commit): honest lane assignment (default → 'On your
    store', not the misleading 'On Pivota' fallback); concrete next-step instruction
    surfaced INLINE (was hidden behind 'Show details'); header now honest (scope is
    truly persistent). TS clean on touched file.
  - DEFERRED within Step 1: a mailto CTA in the task row (outreach already has a mailto
    in the Win-plan panel; the row CTA needs backend cta_url + allowing non-http CTAs).
  - NOT merged — both are prod deploys (Railway + Vercel), awaiting user go.
- 2026-06-18 (c) — Step 1 MERGED + DEPLOYED (backend #939 → 330e9b02 live; portal #85 → Vercel Ready). NOT yet eyeballed on a real audit — the plan's bar is shipped AND eyeballed. Portal changes (lanes/inline/persistent view) show immediately on existing tasks; backend outcome+KPI populate on NEWLY materialized tasks and reconciliation runs at the NEXT audit completion (a fresh audit costs the merchant credits → their call to trigger).
