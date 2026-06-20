# AI-Readiness — `canonical_pdp_enrichment` Executor — Build Scope

_The first REAL auto-dispatch node: on a Pivota-owned canonical PDP, auto-generate +
publish citable enrichment (frontier LLM as the content engine), tie it to the
serving/index gate + the re-measurement proof loop. Plus the competitive-insight
enhancements that feed its grounded brief. Code-grounded on origin/main (backend
192f5d5c). Scoped 2026-06-20._

## Architecture principle (confirmed — "am I right?")
YES. Don't rebuild content generation — Opus/Gemini/GPT do it better than any model we'd
own. The moat is NOT generation; it's **(a) the grounded brief** we feed the model (from
real competitive measurement), **(b) publishing to the surface we own** (the canonical
PDP), **(c) re-measuring as proof.** Two wiring modes, decided by surface:

- **Canonical PDP (`agent.pivota.cc`) — we own it → call the frontier model
  PROGRAMMATICALLY inside the executor and auto-publish.** No copy-paste. This is the
  auto-dispatch node. The model is a commodity engine; the brief + the owned surface are
  the moat.
- **Merchant's own Shopify PDP — we can't/shouldn't auto-write → chat-in-product or
  copy-back handoff** (generate the same brief+draft, merchant approves/pastes). The
  "copy back to ChatGPT/Opus/Gemini" mode the user described = this surface.
- **Chat-based revise** ("regenerate this bullet", "change tone") is good UX on BOTH
  surfaces and is still the frontier model + our grounded context. Wire it in.

## The de-risking finding — ~80% already exists
| Piece | Status | Where |
|---|---|---|
| Enrichment storage | ✅ EXISTS — `product_enrichment` table, exact columns we need | `db/product_enrichment.py:16`; PK `(merchant_id, platform, platform_product_id, geo_code)` |
| Writable fields | ✅ `title_override, summary_short, description_markdown, bullet_points, usage_scenarios, audience_tags, topic_tags` | same |
| Upsert (preserves merchant edits) | ✅ `upsert_enrichment` + `_merge_field` | `db/product_enrichment.py:196` |
| Enrichment pipeline (load→gen→compliance→upsert→quality) | ✅ EXISTS | `services/product_enrichment_pipeline.py:60` `run_enrichment_for_product` |
| Compliance guard (blocks medical/financial claims) | ✅ EXISTS (critical for collagen/supplement SKUs) | `product_enrichment_pipeline.py:36` `_simple_compliance_check` |
| Audit reads enrichment for the Content score | ✅ EXISTS | `agent_center_bd_report_service.py:~4053,2350` `compute_content_richness_score` |
| Executor framework (base, dispatch, durable queue, retries) | ✅ EXISTS | `services/executor_agents/base.py`, `dispatcher.py`, `executor_run_worker.py`, `executor_runs` table |
| Auto-dispatch on audit completion | ✅ EXISTS — new agent plugs in, no new trigger | `audit_run_worker.py:~1278` `dispatch_agents(...)` |
| LLM call pattern to copy | ✅ EXISTS | `executor_agents/content_brief.py:~306` (Gemini `generateContent`) |
| **Frontier-quality content generator** | ⚠️ HEURISTIC today | `product_enrichment_ai.generate_enrichment_draft` — **swap for a real frontier-LLM call** |
| **Served PDP reads enrichment (THE PUBLISH GAP)** | ❌ MISSING | `agent_pdp_view_assembler.assemble_row` reads `description` from `catalog_products`/seed only; never `product_enrichment` |

**So the build = a thin executor (swap the heuristic brain for a frontier LLM) + close
the publish gap.** Not a new subsystem.

## THE publish gap (the one wire that matters)
Writing to `product_enrichment` moves the **audit score** (the audit reads it) — but does
NOT move the **served canonical PDP** or the **`serving_eligible` gate**, because the
serving path (`agent_pdp_v1.py` → `agent_pdp_view` ← `agent_pdp_view_assembler.assemble_row`)
reads `description` from `catalog_products`/external-seed only, never `product_enrichment`.
This is exactly the long-standing "publish gap" in [[pivota-frontier-citation-architecture]]
(grounded claims that never reach the public PDP). Closing it has double value: it makes
this executor real AND fixes the citation thesis's core gap.

`serving_eligible=TRUE` requires (`nightly_index_health_job.py` / `index_pipeline_state_service.py`):
`content_quality_score >= 65` AND `has_image` AND `has_price` AND `description_length >= 50`
AND `identity_resolved` AND `sync_status='live'`. A generated long `description_markdown`
that reaches `agent_pdp_view.description` lifts the `short_description` + `low_quality`
blockers → flips eligibility on the realtime/nightly pass → next audit re-measures.

## Build slices

### E1 — the executor (`services/executor_agents/canonical_pdp_enrichment.py`)
- `class CanonicalPdpEnrichmentAgent(BaseExecutorAgent)`, `name="canonical_pdp_enrichment"`.
- `should_run(ctx)`: True iff the merchant has canonical PDPs that are content-thin /
  serving-blocked-on-content (low `enrichment_coverage`, or `serving_eligible` blocked by
  `short_description`/`low_quality`) AND an LLM key is configured. Read from
  `ctx.audit_report` (already has per-SKU enrichment coverage + index state) — cheap, no
  external call.
- `execute(ctx)`: for each candidate SKU (cap N for cost, like `content_brief` retries=3):
  1. **Build the grounded brief** from the audit's competitive data (§ Grounded brief).
  2. **Generate** via frontier LLM — reuse `content_brief.py:~306` call shape (or upgrade
     `product_enrichment_ai.generate_enrichment_draft`): `summary_short`,
     `description_markdown` (≥600 chars), `bullet_points` (≥3), `usage_scenarios`,
     `audience_tags`, `title_override`.
  3. **Compliance guard** (`_simple_compliance_check`) — non-negotiable for supplement/beauty.
  4. **Persist** → `upsert_enrichment(...)` (existing; `_merge_field` preserves merchant edits).
  5. **Publish** → `refresh_agent_pdp_view_for_content_key(content_key)` + IPS recompute (needs E2).
  6. Return `ExecutorResult(result_type=RESULT_TYPE_DIRECT_ACTION_COMPLETED, evidence={skus_enriched, fields_filled, serving_eligible_before/after})`.
- **Register**: `dispatcher.py` `_registry()` + `executor_agents/__init__.py` + `_AGENT_MAX_RETRIES["canonical_pdp_enrichment"]=3`. No schema change (`executor_runs` is generic).
- **Spine reuse**: `product_enrichment_pipeline.run_enrichment_for_product` already does
  load→generate→compliance→upsert→quality-eval; the executor becomes a thin candidate-walker
  over it, with the generator swapped to a frontier LLM. Model candidate-walking on
  `GscUrlSubmissionAgent` (`gsc_url_submission.py:61`).

### E2 — close the publish gap (the enabling wire; also the citation-thesis fix)
- Teach `agent_pdp_view_assembler.assemble_row` to read `product_enrichment` and coalesce
  `description_markdown` into the served `description` (and optionally project
  `summary_short`/`bullet_points`/`usage_scenarios` into new `agent_pdp_view` columns +
  `AGENT_PDP_VIEW_COLUMNS` in `agent_pdp_v1.py` so they serve as JSON-LD/structured).
  **Exact precedent**: mig `152_agent_pdp_view_evidence.sql` added `evidence_profile`/
  `required_disclaimers` columns the same way.
- After upsert, call `refresh_agent_pdp_view_for_content_key(content_key, refresh_source="canonical_pdp_enrichment")`.
- Without E2, enrichment moves the audit score but the served PDP (what AI grounds to) is
  unchanged → E2 is REQUIRED for the "make it citable" promise to be true.

### E3 — make the loop + the UI claim honest
- The "Pivota handles this — Automatic — make this page citable, buyable, agent-checkout-ready"
  card (`agent_center_bd_report_service.py:7719`) currently has NO executor behind it
  (aspirational). After E1+E2 it's backed for the citable/structured half → update the copy
  to reflect real execution + link to the enrichment evidence. ("buyable/agent-checkout"
  remains operator/offer work — don't over-claim.)
- The proof loop already exists: daily re-audit cron + R3c's "re-audit on/after {date}" +
  outreach re-verify (`task_queue_service.py:462`). Enrich → publish → re-measure → proof.

## Grounded brief — where directives 1+2 feed in
The executor's content is only defensible if the brief is grounded in real measurement
(not generic). Feed it, per SKU:
- the enrichment-coverage gaps the audit found (`compute_content_richness_score` missing fields);
- `competitor_benchmark` (the winning products AI names: "MDhair Marine Collagen" …) — `win_plan_builder.py:182`;
- the verbatim `cited_evidence.excerpt` (what AI literally said when it routed to a competitor) — `sku_opportunity.py:150`;
- the channels AI routes buyers to (`routed_to_instead`) + their `citation_role`.
Brief = "write the PDP that wins THIS query against THESE named competitors using THESE
claims you're missing." That brief is the moat; the generation is commodity.

## Directives 1 + 2 — competitive-insight enhancements (sharpen the brief AND the UI)
Both reuse data that already exists; the gaps are framing + advice + one new join.

**(1) Channels in Findability + how-to-compete advice**
- Data EXISTS: `cited_not_naming_hosts` (`:5934`), `competitor_hosts` (`:5995`),
  `routed_to_instead` (`:4450`) — each carries `citation_role`.
- Gaps: (a) `routed_to_instead` is reseller-gated (`page.tsx:2268`) — un-gate for brands or
  render `cited_not_naming_hosts` in the Findability box (`MerchantNarrativePanel.tsx:91`);
  (b) NO "how to compete" advice anywhere — all name lists. `citation_role` is the unused
  hook → role-typed advice (editorial→earn a review/pitch; marketplace→list there;
  competitor storefront→win the buy-path/match claims). Frontier model can draft the
  per-channel copy from the grounded data.

**(2) Two-axis competitiveness, framed by `merchant_type`** (already on `brand_rollup`)
| Data (exists) | **Brand** frame (improve product) | **Retailer** frame (expand coverage + win channel) |
|---|---|---|
| `competitor_benchmark` (winning products) | "Beat them: match these claims / earn these reviews." | **"Winning products you DON'T carry — add them."** ← biggest gap |
| `routed_to_instead` / `cited_not_naming_hosts` | "AI routes buyers to these channels — get listed/cited." | "AI sends buyers to these stores — win the buy-path (`store_as_destination.rate`)." (already framed) |
| `where_you_can_win.targets` | "Niches your attributes can own." | "Categories to stock + own the AI buy-path." |
- **The standout NEW insight (most defensible, biggest gap): "winning products you don't
  carry."** Today there is NO catalog-overlap — competitor names are never matched against
  the merchant's catalog (grep `catalog_overlap`/`do_you_carry` → nothing). New step:
  normalize `competitor_benchmark` names → fuzzy-match vs the merchant's vendors/products →
  emit "winning products you don't carry." Opus CANNOT do this (needs the merchant's catalog
  × the measured winners). Directly serves "retailers think how to expand brand coverage."
- **WHY competitors win**: only the verbatim `evidence_excerpt` hints at it (captured, shown
  raw). Near-term: have the frontier model extract "why they win" from the existing excerpt.
  Longer-term: extend the probe schema (`deepseek_probe.py:148` returns flat names) to
  return per-competitor claims.

## Recommended sequence
1. **E2 publish-gap bridge** (small, also fixes the citation thesis) → enrichment can reach the served PDP.
2. **E1 executor** (frontier-LLM generation → `product_enrichment` → publish) → first real auto-dispatch node; provably moves audit score AND `serving_eligible`.
3. **E3** truth-up the "Automatic" card + lean on the existing proof loop.
4. **Insight track (1+2)** in parallel — surfaces channels in Findability, the two-axis frame, and the "products you don't carry" join; doubles as richer brief inputs for E1.

## Open decisions (need the user)
1. Generation engine: Gemini (consistent with the audit probes, key already wired) vs Claude
   (best content) — recommend Gemini first (zero new infra), graduate to Claude.
2. Auto-publish autonomy: fully autonomous on the canonical PDP, or a "review before publish"
   gate for the first N runs? (Recommend autonomous — it's our owned surface, compliance-guarded.)
3. Candidate cap N per run (cost) — recommend small (e.g. 5) to start.

## Appendix — key files (origin/main)
`db/product_enrichment.py:16,196`; `services/product_enrichment_pipeline.py:60`,
`product_enrichment_ai.generate_enrichment_draft`; `services/agent_pdp_view_assembler.py`
(`assemble_row`, `refresh_agent_pdp_view_for_content_key`); `routes/agent_pdp_v1.py:28-90`;
`jobs/nightly_index_health_job.py`; `services/index_pipeline_state_service.py`;
`services/executor_agents/{base,dispatcher,content_brief,gsc_url_submission}.py`;
`services/executor_run_worker.py`; `services/audit_run_worker.py:~1278`;
`services/agent_center_bd_report_service.py:2350,4053,4412,5934,7719,9058`;
`services/win_plan_builder.py:182`; `services/sku_opportunity.py:150`;
portal `app/dashboard/agent-center/ai-readiness/page.tsx:2267`,
`components/audit/MerchantNarrativePanel.tsx:91`, `components/audit/WinPlanPanel.tsx:247`.

## Change log
- 2026-06-20 — scope created. canonical_pdp_enrichment = thin executor (frontier-LLM
  generator) + close the publish gap (E2). ~80% of the machinery already exists
  (`product_enrichment` table + pipeline + audit read-path + executor framework +
  auto-dispatch). Companion insight track (channels-in-findability, two-axis framing,
  "winning products you don't carry" catalog-overlap) feeds the grounded brief.
