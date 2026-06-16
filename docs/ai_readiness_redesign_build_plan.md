# AI-Readiness Page Redesign — Build Plan & Tracker

_Single source of truth for the merchant AI-readiness page redesign. Update the status table as steps
land. Survives sessions; pairs with memory `ai-readiness-action-plan-integration-map.md`._

_Last updated: 2026-06-16 (re-baselined against real main + independent review)._

## North-star (the anti-drift anchor — re-read before starting any step)
A K-beauty merchant lands here and answers four questions **in order** — *Am I winning? → How do I
improve? → What do I do? → Is it working?* — then **acts**, gets cited, and **sees** the lift. The bar is
**merchant effectiveness, not feature count.** If a step doesn't move a merchant toward acting or seeing
proof, it's drift.

## ⚠️ Re-baseline note (read this before trusting any prior plan)
The first version of this plan was written against a **12-commit-stale** local checkout. Real `main`
already shipped most of the redesign. **Always `git fetch` + check real main before building** — this is
the lesson. An independent review (2026-06-16) corrected three things: (1) zones 1 & 2 already exist;
(2) the store-vs-Pivota split was already built for `request_enrichment` (complaint #3 only *partially*
fixed); (3) performance-over-time is **not** greenfield (the trend builder already exists on a sibling
surface). The plan below reflects real main.

## Status legend
☐ not started · ◐ in progress · ☑ done (code) · ✅ verified · ⏸ deferred · ✂️ won't build

## Already shipped on real main — do NOT rebuild
- **Zone 1 (How you're doing):** `BrandRollupCover` + `BrandModelStrip` + `MerchantNarrativePanel`
  (verdict, findability-vs-endorsement split, who-AI-cites-instead).
- **Zone 2 (Where you can win):** `WhereYouCanWinPanel` + `WinPlanPanel` (per-query win targets + pitch drafts).
- **Store-vs-Pivota action split** for `request_enrichment` (`PerSkuNextStep`).
- **Persisted open/done task store:** `merchant_tasks` + `MerchantTaskQueuePanel` (survives re-audit via supersession).
- **Run-history** (`RecentAuditsPanel`), **test-a-prompt** (custom-prompts input + `CustomPromptsPanel`),
  **provider-by-cost**, **GSC-connect** (`IntegrationCtaPanel`).

## Progress tracker (corrected priority — by merchant-impact / effort)

| ID | Step | Repo | Status | PR |
|----|------|------|--------|----|
| 1 | "Pivota handles this" lane for un-indexed SKUs (fixes complaint #3 for the common case) | merchants-portal | ✅ merged | pivota-merchants-portal #68 |
| 2 | Action surfaces write to the tracked queue → one unified "Action plan" (open/done × store/Pivota) | backend + portal | ✅ merged | pivota-backend #920 (2a) · pivota-merchants-portal #69 (2b) |
| 3 | Performance-over-time: persist per_sku run scores + thread trend + delta sparkline | backend + portal | ✅ merged | pivota-backend #921 (scores) · #922 (mode-purity/JSONB decode) · pivota-merchants-portal #70 (UI) |
| 4 | Label the Action plan as the live, cross-audit list (re-opened past runs) | portal | ✅ done | pivota-merchants-portal #71 |

**🎉 Redesign complete (2026-06-16).** All four steps shipped. The page now reads as a clean spine —
How you're doing → Where you can win → Action plan (store/Pivota, open/done) → per-SKU detail — with a
run-over-run "is it working?" trend. The merchant's two original complaints (action clarity store-vs-Pivota;
messy layout / no spine) are both resolved, plus the consolidation and the proof loop.

Step-3 hard-won lessons (kept here so they're not relearned): per_sku runs persisted NULL score columns
(finalize path read the legacy-only `aggregate`); the per_sku scoring model differs from legacy
(4 dimensions vs visibility/attribution → documented mapping: visibility = mean weakest-dimension overall,
attribution = mean citation); JSONB columns come back as STRINGS via asyncpg (must `_decode_jsonb_field`
before reading — the unit-test-masks-prod-bug pattern); and the trend must stay per_sku-pure (don't mix
legacy runs). Deferred (not built — see "Won't build"): per-SKU score-history table for per-SKU sparklines.

> **Step 3 grounding (2026-06-16) — load-bearing blocker found:** per_sku audit runs persist
> `visibility_score_avg = NULL` because `_record_final_report_fields` (`audit_run_worker.py:~1376`) reads
> `brand_report["aggregate"]`, which only the **legacy** branch sets — the per_sku response has no
> `aggregate`. So `_build_history_trend` filters those rows out and the trend is **permanently empty**
> unless we first persist real run-level scores for per_sku (from `brand_rollup` dimension medians).
> Plan: (a) persist per_sku run scores; (b) attach `tracking` to the per_sku response via the existing
> `_build_history_trend`/`_build_tracking_block` (no new math, no per-SKU history table); (c) types + one
> delta line + sparkline in `BrandRollupCover` (page.tsx:~2623). Run-level delta only — per-SKU trend
> needs a history table (deferred). Don't reuse `build_reaudit_delta` (legacy `merchant_view` shape).

## ✂️ Won't build (gold-plating — the independent review killed these)
- **Per-task "mark-done → re-crawl":** the full re-audit already supersedes/reconciles tasks; the trend
  sparkline (step 3) closes the loop. Don't build a per-SKU on-demand re-crawl.
- **Live "test a prompt" lab:** already exists as batch (custom prompts at launch). A live one duplicates
  it and invites per-keystroke probe cost.
- **Broad "draft this for me":** the valuable slice already exists (the enrichment form's premise is "you
  don't write the copy"; pitch drafts are pre-written).
- **Elaborate completion-mode system:** don't design one — just have the action surfaces create a queue row.

## Locked design decisions (the agreed spec — don't relitigate)
- **Positive tone, honest facts:** "where you can grow," not "where you're losing." Never mock data.
- **One source of truth for "what to do":** the persisted `merchant_tasks` queue. Every action surface
  feeds it; the page shows ONE action plan, not 5–6 scattered lists.
- **Two lanes per action:** on your store vs on Pivota. (Already done for enrichment + now indexing.)
- **Ambient billing:** a credit meter, no per-probe cost preview; interrupt only when empty.
- **Audit runs immutable.**

## Guardrails — check EVERY step against these before coding (this is where drift dies)
**Reuse, don't rebuild** (per `ai-readiness-action-plan-integration-map.md` + the real-main inventory above):
- Tasks → `merchant_tasks` (+ API + `MerchantTaskQueuePanel`). Pivota's done-work → `executor_runs`.
- Submit INCI → backend `POST /merchant/pdps/.../evidence` (already wired). NOT the Node backfill engine.
- Probe → `_probe_per_sku_ctx`. History/trend → `merchant_audit_runs` + `_build_history_trend` /
  `tracking.history.series` (already built on the URL-wedge `merchant_view` surface — thread it, don't rebuild).
- Citations-won → `attribution_score_avg` / `build_custom_prompt_results`.

**Duplication traps (a "no" to any):** parallel task store · parallel probe path (bypasses cost metering +
cited-vs-retrieved discipline) · parallel citation scorer · parallel trend builder · a third auth router.

**Keep distinct:** "cited claims" (publish side — `get_intel`/public claims) vs "citations won"
(measurement side — attribution). Never merge into one number.

**Per-step discipline:** write acceptance + verification BEFORE coding. ☑ only when code lands; ✅ only
when verification passes. Don't start step N+1 with N unverified unless noted parallel-safe.

---

## Phase steps

### 1 · "Pivota handles this" lane for un-indexed SKUs  ☑ done (PR #68)
**Done:** elevated `nba.pivota_assisted` into a proper parallel "Pivota handles this (Automatic)" lane in
`PerSkuNextStep` for `request_indexing`, so the common (un-indexed) starting state gets the same
store-vs-Pivota clarity enrichment had. Informational only (no hollow INCI form; the `request_indexing`
CTA is a no-op; GSC-connect lives in `IntegrationCtaPanel`). tsc + eslint clean.

### 2 · Action surfaces → tracked queue → one "Action plan"  ☐ next
**Why:** the real consolidation prize. "What to do" is scattered across ~5 surfaces (narrative "what to do
next", `WinPlanPanel` display-only, `PerSkuNextStep` lanes untracked, `WhereYouCanWinPanel` "Create the
answer", `MerchantTaskQueuePanel` persisted). The two surfaces that *do* work (enrichment form,
"Create the answer") don't write to the queue the merchant marks done in — acting and tracking are disjoint.
**Scope:** (a) make the enrichment-form submit + the per-SKU/indexing actions create/update a
`merchant_tasks` row (reuse `record_task_created` / the existing materializer — "Create the answer" already
does this, mirror it); (b) collapse the page's scattered guidance into ONE "Your action plan" reading the
queue (open highlighted, done checked, store/Pivota lanes). Keep zones 1/2 intact.
**Out of scope:** new completion-mode system, verification re-crawl, performance trend.
**Acceptance:** every action a merchant can take appears as one tracked queue row; the page shows a single
action plan; no orphan "do this" surface that isn't reflected in the queue.
**Verify:** submit the enrichment form / take an action → a `merchant_tasks` row appears and shows in the
unified plan; mark done → persists.

### 3 · Performance-over-time (thread existing trend + one sparkline)  ☐
**Why:** "is it working?" — genuinely absent on the per-SKU surface (only a snapshot + a run list).
**Scope:** thread the **already-built** `_build_history_trend` / `tracking.history.series` payload (today
only on the URL-wedge `merchant_view`) onto the per-SKU AI-readiness response, and render one delta +
sparkline in `BrandRollupCover` ("42 → 51 (+9) since last run"). Near-zero new backend.
**Out of scope:** per-SKU score history table (heavier; defer unless a per-SKU trend is explicitly needed).
**Acceptance:** a returning merchant sees their run-over-run score delta on the page.
**Verify:** two runs for a merchant → the second shows the delta vs the first.

### 4 · Scope/label the persisted queue per run  ☐
**Why:** the queue renders under whatever run is open but always shows the merchant's *current* queue —
confusing when viewing an old run.
**Scope:** either scope the queue to the opened audit run, or label it clearly ("your live queue — all audits").
**Acceptance:** viewing a past run no longer implies its tasks are that run's.
**Verify:** open an old run → the queue is clearly labeled / scoped.

## Decisions / change log
- 2026-06-16 (a) — design explored (4-zone spine, unified action plan, prompt-lab, etc.); integration
  audit run on a STALE local checkout → produced a plan that assumed much was unbuilt.
- 2026-06-16 (b) — **re-baselined against real main**: most zones already shipped; `MerchantNarrativePanel`
  rebuild was redundant (PR closed). Independent review re-prioritized to the 4 steps above and killed the
  gold-plating. Step 1 (Pivota indexing lane) shipped (PR #68).
