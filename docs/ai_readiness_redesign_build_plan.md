# AI-Readiness Page Redesign — Build Plan & Tracker

_Single source of truth for the merchant AI-readiness page redesign. Update the status table as steps
land. Survives sessions; pairs with memory `ai-readiness-action-plan-integration-map.md`._

_Last updated: 2026-06-16._

## North-star (the anti-drift anchor — re-read before starting any step)
A K-beauty merchant lands here and answers four questions **in order** — *Am I winning? → How do I
improve? → What do I do? → Is it working?* — then **acts**, gets cited, and **sees** the lift. The bar is
**merchant effectiveness, not feature count.** If a step doesn't move a merchant toward acting or seeing
proof, it's drift.

## Status legend
☐ not started · ◐ in progress · ☑ done (code) · ✅ verified (acceptance met) · ⏸ deferred

## Progress tracker

| ID | Step | Repo | Status | PR |
|----|------|------|--------|----|
| Z1-a | `MerchantNarrativePanel` (Zone 1 lead / unblock) | merchants-portal | ☑ built, uncommitted | — |
| **A1** | **NBA prescriptions → `merchant_tasks` (+ surface/completion_mode)** | **backend** | **☐ next** | — |
| A2 | Frontend unified "Your action plan" (open/done, 2 lanes) | merchants-portal | ☐ | — |
| A3 | Mark-done → enqueue `verification_run` (re-crawl) | backend | ☐ | — |
| A4 | "Request indexing" merchant wrapper + CTA dispatcher | PIVOTA-Agent + backend | ☐ | — |
| B1 | Zone 1/2 restructure (narrative spine + opportunities) | merchants-portal | ☐ | — |
| C1 | `audit_sku_scores` projection + Zone 4 per-SKU trend | backend | ⏸ | — |
| D1 | Prompt-lab (reuse `_probe_per_sku_ctx`, `subject_type=prompt_lab`) | backend + portal | ⏸ | — |
| E1 | "Draft this for me" generative help on store-lane actions | backend + portal | ⏸ | — |

## Locked design decisions (the agreed spec — don't relitigate)
- **4-zone positive spine:** How you're doing → Where you can win → Your action plan → Performance tracking.
- **Positive tone, honest facts:** "where you can grow," not "where you're losing." Never mock data.
- **Unified action plan:** one list; open items highlighted, done checked. Two lanes per action:
  **on your store** vs **on Pivota**. Two completion modes: `system_tracked` vs `merchant_confirmed`.
- **Verify-on-done loop:** marking a store action done triggers a Pivota re-crawl to confirm, then tracks lift.
- **Integrated prompt-lab** (in Zone 2, not a 5th zone); a test = one probe on the SKU timeline.
- **Ambient billing:** a credit meter, no per-probe cost preview; interrupt only when empty.
- **"Draft this for me"** generative help on store-lane actions — fast-follow after Zone 3 core.
- **Audit runs immutable;** ad-hoc tests append to the SKU timeline.

## Guardrails — check EVERY step against these before coding (this is where drift dies)
**Reuse, don't rebuild** (per `ai-readiness-action-plan-integration-map.md`):
- Tasks → `merchant_tasks` (+ API + `MerchantTaskQueuePanel`). Pivota's done-work → `executor_runs`.
- Re-crawl/verify → `verification_runs` + `enqueue_verification_run` + `pdp_renders` verifier.
- Submit INCI → backend `POST /merchant/pdps/.../evidence` (already wired). NOT the Node backfill engine.
- Probe → `_probe_per_sku_ctx`. History → `merchant_audit_runs` (+ `subject_type`). Citations-won →
  `attribution_score_avg` / `build_custom_prompt_results`.

**Duplication traps (a "no" to any of these):** building a parallel task store · a parallel probe path
(bypasses cost metering + the cited-vs-retrieved discipline) · a parallel citation scorer · a parallel
`prompt_lab_runs` table · a third auth-scoped router.

**Keep distinct:** "cited claims" (publish side — `get_intel`/public claims) vs "citations won"
(measurement side — attribution). Never merge into one number.

**Per-step discipline:** write the acceptance criteria + verification BEFORE coding the step. A step isn't
☑ until code lands; not ✅ until its verification passes. No starting step N+1 with step N unverified
unless explicitly noted as parallel-safe.

---

## Phase A — Zone 3 (the active work)

### A1 · NBA prescriptions → `merchant_tasks`  ☐ next
**Why:** the disconnect everything hangs off — per-SKU `next_best_action` recommendations never become
tasks today, so the action plan has no single backing store.
**Scope:** materialize NBA per-SKU prescriptions into `merchant_tasks` via the existing
`services/task_queue_service.py` materializer (same path as the audit-ladder). Tag each with `surface`
(`storefront`|`pivota_pdp`) and `completion_mode` (`system_tracked`|`merchant_confirmed`); reword
ambiguous "page" copy to name the surface.
**Decision:** store `surface`/`completion_mode` in `evidence_jsonb` (no migration) — promote to columns
only if we later need to query by them.
**Files:** `pivota-backend/services/next_best_action.py`, `services/task_queue_service.py`,
`db/merchant_tasks.py` (read-only/evidence shape).
**Out of scope:** frontend, verification trigger, indexing fulfillment.
**Acceptance:** after an audit completes, each per-SKU NBA prescription exists as an open `merchant_tasks`
row with `surface` + `completion_mode` in `evidence_jsonb`, owner set, linked to the audit run.
**Verify:** run/replay an audit in staging (or a unit test over the materializer) → assert task rows +
tags via the tasks API. No parallel store created (reused `record_task_created`).

### A2 · Frontend unified "Your action plan"  ☐
**Scope:** one Zone-3 component reading `merchant_tasks`: open highlighted (two lanes from `surface`),
done checked (union with `executor_runs`), progress bar, "Mark done" on `merchant_confirmed`. Retire the
three scattered surfaces (per-SKU next-step block, Fix-these-first, standalone task queue).
**Files:** `pivota-merchants-portal/app/dashboard/agent-center/ai-readiness/page.tsx`,
reuse `components/audit/MerchantTaskQueuePanel` data + api-client; lanes reuse `PerSkuNextStep` pattern.
**Acceptance:** plan renders real open/done with correct lanes; mark-done flips status; no duplicate
"next step" surfaces remain.
**Verify:** load the page for the pilot merchant; mark an item done → status persists via the tasks API.

### A3 · Mark-done → verify re-crawl  ☐
**Scope:** completing a `merchant_confirmed` + `storefront` task enqueues a `verification_run`; result
stamps the task ("live ✓" / "not found yet"). Reuse `enqueue_verification_run` + `pdp_renders`.
**Files:** backend task PATCH / `update_task_status` → enqueue; add `task_id`↔verifier link.
**Acceptance:** marking a store action done enqueues a verification_run for that product URL; the result
is reflected on the item.
**Verify:** mark done in staging → verification_run row appears → item shows verified/not-found.

### A4 · "Request indexing" merchant wrapper + CTA dispatcher  ☐
**Scope:** new merchant-authed per-product endpoint wrapping
`catalogRowTrustUpserter.upsertCatalogRowTrustForSourceListingRefs` (scoped to caller's own merchant);
a CTA dispatcher on `cta.action`; fix the misleading no-op comment (`next_best_action.py:52-55`).
("Submit INCI" already works — no build.)
**Files:** `PIVOTA-Agent/src/services/catalogRowTrustUpserter.js` (new merchant endpoint + scoping),
backend dispatcher, `pivota-backend/services/next_best_action.py` (comment).
**Acceptance:** a merchant can recompute serving-eligibility for their OWN SKU; other merchants' SKUs are
rejected (per-merchant scoping enforced).
**Verify:** call as merchant A on A's SKU → recompute runs; on B's SKU → 403.

## Decisions / change log
- 2026-06-16 — design locked (4-zone positive spine, unified action plan, verify-on-done, prompt-lab,
  ambient billing). Integration audit done (3 code audits) → reuse map + 4 glue points. `MerchantNarrativePanel`
  built to unblock the page. Plan created.
