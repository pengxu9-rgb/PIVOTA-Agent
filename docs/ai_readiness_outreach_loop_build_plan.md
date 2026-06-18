# AI-Readiness Pitch-Outreach Lifecycle — Build Plan & Tracker

_Single source of truth for closing the loop on the win-plan: turn "we identified the exact host to
pitch" into "we sent it, tracked it, and proved you got cited." Update the status table as steps land.
Pairs with `ai_readiness_query_axes_build_plan.md` + memory `pivota-frontier-citation-architecture`._

_Created 2026-06-18._

## North-star (anti-drift anchor — re-read before any step)
A merchant sees they're cited **0% on discovery**. The audit already names the exact independent host
that would fix it, per losing query. The lifecycle's job: **draft → send/queue → track → re-verify
cited on the next audit** — so Pivota *moves* the number, not just measures it, and can prove the lift.
The bar is **a closed loop with honest proof** (the host now cites you), not more drafts. If a step
produces another un-tracked artifact, it's drift.

## The problem (code-grounded 2026-06-18)
Diagnosis is rich; **execution has no rail for the citation/endorsement problem the audit measures.**
- `win_plan_builder.py` names host + competitor + win-condition per losing query → **WIRED (compute)**.
- Pitch email drafts (`audit_playbook_engine.py:_build_pitch_draft`, subject/body/recipient_email) →
  **real text but merchant-manual + email-only**; submission-form hosts (e.g. Wirecutter) get NO draft.
- Content briefs → generate the brief, then **park it as a task**.
- `merchant_tasks` → real task list, but **no executable CTA** (tasks are text; `cta_url` ~never set).
- GSC "request indexing" (`gsc_url_submission.py`) → **real auto-execution**, but only helps
  *findability*, not *citation/endorsement*.
- **Pitch drafts die as text:** no send/track, no outreach record, no submitted→responded→cited
  lifecycle. Pivota identifies the host, renders the email, then loses the thread.

## What EXISTS — reuse, don't rebuild
- **Targeting:** `win_plan_builder.build_win_plan` → per-query `grounds_in[]` targets with `host`,
  `tier`, `outreach.state` (`draft_ready` / `submission_only` / `target_only`), `pitch_draft`
  (`subject`/`body`/`recipient_email`) for draft-ready; `rollup.pitch_ready_hosts`.
- **Task store + lifecycle + supersession:** `merchant_tasks` (`db/merchant_tasks.py`) — statuses
  pending/in_progress/done/dismissed/failed/superseded; `evidence_jsonb`; owner assigned_to_*; the
  unified Action plan already renders it.
- **Citation measurement (the verify engine):** the audit's per-query cited-hosts (authority_map /
  `_citation_by_intent` / win-plan host↔query) — already computes "is host H citing us for query Q?"
  Honors cited-vs-retrieved discipline. THIS is the re-verify oracle.
- **One-click email:** frontend already renders `pitch_draft` as a mailto (PerSkuNextStep / WinPlan UI).

## The gap = the only real new work
An **outreach record + state machine** keyed to (losing_query, host, sku) that persists across audits,
plus a **re-verify-on-next-audit** join that flips it to `cited`. Everything feeding it already exists.

## Proposed lifecycle (state machine)
`targeted` (win-plan named it) → `drafted` (pitch rendered) → **`queued`/`sent`** (merchant marks sent,
or Pivota submits for form hosts) → `awaiting` → **`cited`** (next audit: host now cites us for the
query) | `not_yet` (re-verify, still not cited) | `declined`/`expired` (closed). The win is the
`cited` transition — honest proof, drives the citation-demand north-star.

## Data-model decision (LOCK FIRST — Step 0)
Two options; pick before coding:
- **(A) Reuse `merchant_tasks`** with `lever="outreach_pitch"` + an `outreach` block in `evidence_jsonb`
  (host, tier, query, sku_key, recipient_email, draft, `outreach_status`, sent_at, verified_at). Pros:
  reuses store + Action-plan UI + supersession; no migration. Cons: outreach status lives in
  evidence_jsonb (not a column) — re-verify queries scan tasks.
- **(B) New `merchant_outreach` table** (outreach_id, merchant_id, sku_key, losing_query, host, tier,
  recipient_email, pitch_draft, status, created_at, sent_at, verified_at, parent_audit_run_id,
  cited_run_id). Pros: clean state machine, indexable re-verify, lifecycle timestamps. Cons: migration +
  new UI surface (or still render via the Action plan).
- **Recommendation:** start with **(A)** for the first slice (fastest, reuses the Action plan), and
  graduate to **(B)** only if the re-verify scan or reporting needs the indexed columns.

## Locked design decisions (the agreed spec)
- **Never fake "sent".** A pitch is `sent` only when the merchant marks it (or an explicit auto-send
  ships later) — no implied sends. Honesty over vanity.
- **`cited` is earned by re-verify**, using the SAME cited-vs-retrieved discipline as the audit (don't
  count retrieved-but-not-recommended as a win). The next audit is the oracle.
- **Submission-form hosts are first-class** — they get a `submitted` path (form URL + a record), not
  silently dropped like today.
- **Reuse the win-plan + merchant_tasks + audit verify** — no parallel targeting, no parallel scorer.
- **Close the loop visibly** — the merchant sees "you pitched X · still pending" → later "X now cites
  you (+N citations)". That proof is the product.

## Guardrails — check EVERY step
- No parallel task store / citation scorer / targeting (reuse win-plan, merchant_tasks, audit verify).
- Re-verify must match on (host, normalized_query) honestly; a host citing us for a DIFFERENT query is
  not this outreach's win.
- Don't auto-send anything without explicit merchant action + a real send path (email/API). First
  slices are merchant-marks-sent only.
- Outreach records must survive re-audits (supersession-aware, like merchant_tasks).

## Progress tracker
| ID | Step | Surface | Status | PR |
|----|------|---------|--------|----|
| 0 | Lock data model + state machine (this doc) — **DECIDED: (A) reuse `merchant_tasks`, `lever='outreach_pitch'`, outreach block in `evidence_jsonb`** | — | ✅ | — |
| 1 | Persist an outreach record on "mark pitch sent" (draft→sent), keyed to (sku, query, host) | backend + portal | ✅ done | backend #930 · portal #80 |
| 2 | Re-verify on next audit → flip pending outreach to `cited` when the pitched host now cites the merchant. **Oracle = endorsement-role host that ALSO cited the merchant's SKU** (NOT the bare endorsement_hosts roster — review caught that it includes competitor-endorsing hosts → false proof). `_norm_host` both sides. Best-effort in the audit worker. | backend | ✅ done | #932 |
| 3 | Surface the loop — `MerchantOutreachPanel` (Zone 4): per-pitch cited vs pending. | portal | ✅ done | portal #81 |
| 4 | Submission-form hosts get a `submitted` path — **already covered** by Step 1's actionable gate (button shows for submission_only+url, records channel='submission_form') + Step 2's host-based re-verify. | backend + portal | ✅ done | (Steps 1+2) |
| 5 | Outreach rollup 'N pitches sent · M now citing you' — in `MerchantOutreachPanel` (frontend-computed from the tasks; no backend change). | portal | ✅ done | portal #81 |
| 6 | Real auto-send (email API) | backend | ✂️ PARKED | — — recommendation: do NOT auto-blast cold pitches from Pivota's shared domain (deliverability/spam risk to transactional email). Merchant-sent (mailto) is safer. If ever wanted, send from merchant's OAuth-connected email (separate initiative). |

## Acceptance & verification (fill before coding each step)
- **Step 1:** marking a draft-ready pitch sent creates a persisted outreach record (sku/query/host/
  recipient + status=sent + sent_at); visible in the Action plan; survives a page reload + a re-audit.
- **Step 2:** after a second audit where the pitched host now cites the SKU for that query, the record
  flips to `cited` (and stays `not_yet` when it doesn't) — verified on a real 2-run sequence.
- **Step 3:** the merchant sees pending vs cited outreach in the UI; the `cited` transition is celebrated.
- **Step 4:** a submission-only host yields an actionable `submitted` record (form URL), not a dead end.
- **Step 5:** the brand cover shows the outreach lift count, honestly (only re-verified citations).

## Related / downstream
- Content-brief crash (`task_queue_service.py:365` / `db/merchant_tasks.py:322` JSONB-as-string) — being
  fixed in a separate spawned session; unblocks the "what Pivota did" panel. Independent of this loop.
- [[pivota-frontier-citation-architecture]] — the north-star this serves (frontier agents CITE Pivota
  merchants); the outreach loop is how a merchant earns those citations.
- Query-axis plan Steps 3-8 — deprioritized: measurement is good enough; this is the needle-mover.

## Decisions / change log
- 2026-06-18 (a) — plan created after a live audit showed 0% discovery citation + the action-loop map
  (only GSC auto-executes; pitch drafts die as text). Highest-leverage = the outreach lifecycle on top
  of the already-built win-plan. Data model + state machine to lock (Step 0) before coding.
- 2026-06-18 (b) — **Step 0 LOCKED: data model (A)** — reuse `merchant_tasks` (`lever='outreach_pitch'`,
  outreach state in `evidence_jsonb`), no migration; graduate to a table only if re-verify needs indexed
  columns. Starting Step 1 (persist on mark-sent).
- 2026-06-18 (c) — holistic review caught reverify was INERT (matrix_rows lacked cites_exact_sku → no flip ever); fixed via matrix aggregation + an integration test vs real build_authority_map (#933). Step 6 PARKED (auto-send unsafe; mailto is safer). Loop complete; only live 2-audit validation remains.
