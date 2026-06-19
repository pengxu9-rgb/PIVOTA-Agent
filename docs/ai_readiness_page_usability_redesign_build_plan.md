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
| 2 | ✅ **Fold "Pivota agent activity" into the action plan** — DELETED the standalone `MerchantExecutorActivityPanel` feed; Pivota's work lives in the action plan's "On Pivota" lane + "by Pivota" tags (one-line clarifier added). | portal | 🟢 merged + deployed | #87 (Vercel 200d297) |
| 3 | ✅ **Restructure Zone 1 + relocate "Your products"** — per-SKU cards moved up into Zone 1 as the drill-down; brand cover's 4-tile scorecard → compact median strip; per-product next-step already on the card face. | portal | 🟢 merged + deployed | #88 (Vercel 492ae6a) |
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
- 2026-06-18 (d) — Step 1 EYEBALLED on the live page (drove the merchant's own session; reload required re-login — never entered credentials). Confirmed working: persistent scope (action plan went 'No open tasks' → 'Open (61)'), inline next-step instruction, honest 'ON YOUR STORE' lane. FOUND A REAL PROBLEM: the persistent scope EXPOSED an accumulated pile of identical pending tasks ('Index your canonical PDPs' ×5+) that the old latest_completed scope was masking; the forward reconciliation only fires at the next audit, so the live list looked cluttered. FIX shipped: lazy idempotent dedup on the persistent read (backend #940 → 456b71d4) — collapses duplicate pendings to the newest on next page load, no audit/DB-access needed. Lesson: shipping the scope change without a backlog cleanup left the list ugly until an audit ran — eyeballing caught it. STILL: per-task outcome/KPI lines only populate on NEWLY-created tasks (next audit), not the pre-deploy backlog.
- 2026-06-18 (e) — Step 1 cleanup, parts 2-3: (a) lazy dedup (#940, 456b71d4) collapsed exact-duplicate pendings live (61→43); eyeballing showed the residual were NOT dupes but distinct per-product tasks sharing a generic title. (b) Title disambiguation (#941, 8a976b65): _extract_action_items appends the product name to a per-product task title when absent ('Index your canonical PDPs … — Good Night Collagen'), so per-SKU tasks read as distinct. NEXT: run one fresh 1-2 SKU audit (user-authorized) to trigger the scope-aware reconciliation (collapses prior-run pending → this run's set) + populate outcome/KPI lines on the new tasks + render disambiguated titles — the genuinely-clean state.

## ⚠️ CRITICAL FINDING (2026-06-18, from the live fresh-audit eyeball) — Step 1 is NOT verified
Running a fresh per-SKU audit (352 credits) changed the REPORT (citation 20→25) but left the
ACTION PLAN completely unchanged (43 tasks, generic-titled "Index" dupes). Root cause, confirmed
in deployed code:
- `run_brand_report(audit_mode="per_sku")` returns the report under **`per_sku_reports`**
  (agent_center_bd_report_service.py ~9051), NOT `per_product`.
- `_extract_action_items` (task_queue_service.py) reads **`audit_report.get("per_product")`** → []
  for per-SKU runs → `materialize_tasks_from_audit` early-returns ("no action_items") **before**
  the reconciliation/loop.
- ⇒ **Per-SKU audits materialize ZERO merchant_tasks.** The action plan's tasks are LEGACY-mode
  leftovers; the per-SKU audits merchants actually run never feed Zone 3. My Step 1 backend
  reconciliation + title disambiguation hook into a path per-SKU audits don't use, so they never
  fire. (The portal read-path fixes — inline instruction, honest lanes — and the lazy dedup DO
  work, mode-independent: dedup collapsed 61→43 live.)
- This reframes Step 1: the FIRST fix must be **make per-SKU audits materialize tasks** (from
  `per_sku_reports[].next_best_action` + win_plan + brand-level actions), THEN reconciliation +
  titles apply. The per-SKU action source is `next_best_action` (per SKU) — not `merchant_view.actions`.
- Lesson: the holistic review + the task-CTA agent both traced materialize_tasks_from_audit but
  assumed per-SKU fed it; only the live eyeball caught that per-SKU audits don't create tasks at all.
  Do not trust a materialization path is exercised without confirming the report SHAPE it consumes.

## Step 1 foundation fix — per-SKU audits now materialize tasks (2026-06-18)
Shipped the REAL fix for the critical finding above. `_per_sku_action_items` (task_queue_service.py)
turns each SKU's `next_best_action` into one task; `_extract_action_items` falls back to it when the
`per_product` walk is empty (legacy unaffected). Backend #942 → 439d9168 (deploying). Consequences:
- per-SKU audits now feed the action plan (Zone 3) — one product-named task per SKU, with the
  tracking_metric as the outcome/KPI + citation-derived severity + real http CTA only.
- the scope-aware reconciliation now ENGAGES at per-SKU audit completion → closes prior pending
  tasks for covered products (incl. the orphaned legacy leftovers) + brand tasks.
- title disambiguation (#941) applies (NBA headlines already name the product).
- 84 task tests pass. LIVE confirmation still pending: materialization runs in the worker at audit
  COMPLETION, so it needs the NEXT per-SKU audit to complete after this deploy (the 352-credit run I
  did predates the fix). Did NOT auto-run another paid audit.
- Residual risk to watch on that next audit: reconciliation closes a legacy task only if the per-SKU
  report's product_key matches the legacy task's evidence.product_key (format match) — verify the 43
  actually collapse, not just that new tasks appear.

## ✅ LIVE VERIFICATION of per-SKU materialization (2026-06-18, 2nd fresh audit, 352 cr)
Ran a 2-SKU audit AFTER the per-SKU-materialization deploy (439d9168). Result, confirmed on the live page:
- ✅ **Per-SKU audits now materialize tasks.** Two new `HIGH · SKU ENRICHMENT` tasks appeared:
  "Fill the gaps on Triple Shine Grape - Ownist's page…" and "Fill the gaps on …Good Night Collagen…'s
  page…", each with the inline why-line + **Expected:** (enrichment coverage completeness) + **Track:**
  (failed SKU prompts now answered) — product-named, actionable. THE critical gap is fixed + verified.
- ✅ **Reconciliation engaged + is scope-aware.** Open count 43 → 27. It correctly KEPT tasks for
  products NOT in this audit (e.g. "Specific queries… Warm Fall/Winter dog sweater", "Pitch
  whowhatwear.com" — fashion/dog SKUs from past audits).
- ⚠️ **RESIDUAL (precisely diagnosed): product_key FORMAT MISMATCH blocks closing legacy leftovers for
  AUDITED products.** The collagen legacy "Index your canonical PDPs" task stores
  `product_key="https://agent.pivota.cc/products/sig_586147c399a05451ccd799cf9e82eab7"` (canonical-URL
  form), but the per-SKU report + new tasks use `product_key="prod::merch_…::shopify::10100856914217"`
  (catalog form). `_covered_product_keys` only collects the catalog form, so reconciliation's scope guard
  skips the URL-form legacy task → it (and "Convert category mentions", "Strengthen schema", "Close the
  gap") survive with their old generic titles + no outcome line.
  FIX (next): normalize product identity — collect MULTIPLE ids per covered SKU (product_key, sku_key,
  content_key/signature, canonical_url, + the bare `sig_…` extracted from any URL) and match a legacy
  task if ANY of its product_key's normalized ids intersect the covered set. Then a per-SKU audit closes
  the audited product's legacy leftovers too. (Same normalization should apply to dedup's identity.)
- Net: the page is materially better (per-SKU audits feed Zone 3 with clean, actionable tasks); the
  legacy backlog for audited products needs the product-key normalization fix to fully clear.

## 2026-06-18 — residual + side-fix shipped
- **product_key normalization** (backend #943 → c603de53, live): `_product_id_variants` extracts the
  shared `sig_<hex>` from both the canonical-URL and catalog product_key forms; `_covered_product_keys`
  collects it (incl. identity.canonical_url); reconciliation matches on variant intersection. So a
  per-SKU audit now closes the AUDITED product's legacy URL-keyed leftovers (the surviving "Index"/etc).
  Verifies on the next per-SKU audit — no extra paid run. 54 task tests pass.
- **Models-to-run selector** (portal #86 → Vercel, live): dropped the LOWER COST/MORE CREDITS framing
  (cost still shown per-selection in the estimate); Claude greyed + "Coming soon" (CONNECTED_AUDIT_PROVIDERS
  allowlist = {gemini, chatgpt}). Merchant-reported.

## Step 1 status: SHIPPED + verified (one residual verifies on next audit)
Action plan is now actionable + persistent + fed by per-SKU audits, with honest lanes + inline next-step,
dedup, scope-aware reconciliation, product-named titles, outcome/KPI, and cross-format product matching.
Remaining redesign steps untouched: 2 (fold agent-activity), 3 (Zone-1 restructure / move Your-products up),
4 (snapshot leak — scope task/activity/outreach to the viewed run), 5 (follow-up re-test loop).
- 2026-06-18 — Step 2 SHIPPED (portal #87 → Vercel 200d297). Deleted the standalone agent-activity feed (unscoped, stale '34d ago', internal agent names + failures — merchant-flagged). Pivota's work now lives in the action plan's 'On Pivota' lane + 'by Pivota · {agent}' task tags, with a per-lane clarifier. Remaining: Step 3 (Zone-1 restructure: move 'Your products' up as the drill-down, surface per-product action, kill the brand-vs-SKU duplicate scorecard), Step 4 (leaky snapshot — scope task/activity/outreach to the viewed run), Step 5 (re-test loop).
- 2026-06-18 — Step 3 SHIPPED (portal #88 → Vercel 492ae6a). Moved PerSkuCardList into Zone 1 (drill-down
  behind the brand summary; Zone 3 = action plan only); de-duped the brand 4-tile scorecard → a compact
  median strip; reframed 'Your products' as 'the detail behind the summary'. NOTE the per-product action
  was already on the card face (not buried) — corrected that premise. RollupDimensionStat now unused (left).
- **Step 4 REFRAMED:** Step 1 LOCKED the action plan as an intentional PERSISTENT cross-audit workspace, so
  it SHOWING present-day tasks on a historical report is now BY DESIGN, not a leak. Step 2 deleted the
  confusing activity feed. So Step 4 shrinks to a CLARITY fix: when viewing a historical run, add a banner
  'You're viewing a past audit (date); your action plan + outreach below are your current live list.'
  (No re-scoping — that would contradict Step 1.)
- Remaining: Step 4 (historical-view clarity banner) + Step 5 (on-demand re-test loop — the bigger one).
