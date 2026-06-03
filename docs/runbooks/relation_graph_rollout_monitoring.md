# Relation Graph + Similar-Widget Rollout & Monitoring Runbook

Covers the family-collapse buildout (PRs #1604–#1608). Satisfies **Condition 3** of
`docs/PRODUCTION_READINESS_REVIEW.md`. All runtime behavior is flag-gated and **default-off** — merging
is inert; this runbook is for the operator who turns it on.

## Flags (env vars on the `PIVOTA-Agent` service)

| Flag | Default | What it does |
|---|---|---|
| `AURORA_BFF_RELATIONSHIP_GRAPH_ENABLED` | off | **Master.** Serves curated relationship-graph "similar" cards. Pre-launch pilot gate. |
| `AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED` | off | Read-time collapse of served edges to the parent-family key. No-op while master is off. |
| `AURORA_BFF_SIMILAR_FAMILY_DEDUPE_ENABLED` | off | Family-dedupes the whole "similar" widget (curated + dynamic recall). Independent of master. |
| `AURORA_BFF_RELATIONSHIP_GRAPH_PG_COLLAPSE_ENABLED` | off | Legacy alias for the collapse flag. |

Flag-off is byte-identical to pre-buildout behavior on every path.

## Prerequisites before any flip
1. Target env deployed at ≥ `45f95892` (#1608) — **migration 051 applied** (view exposes `label_state`,
   serves `human_approved`+`ai_approved`). Verify: `SELECT count(*) FROM information_schema.columns WHERE
   table_name='product_relationship_edges' AND column_name='label_state';` returns 1.
2. Dashboards/alerts below are live.
3. **Condition 4 decision** made: the pilot runbook
   (`docs/runbooks/product_relationship_graph_v1_pilot.md`) requires ≥100 `niche_specialist` served edges;
   current served data has **zero**. Either generate them, amend the criteria, or explicitly accept
   dogfood without them.

## Metrics to dashboard (all already emitted in logs as `kind: 'metric'`)

| Metric name | Watch | Healthy |
|---|---|---|
| `aurora_bff_relationship_graph_family_collapse` | `collapsed_edge_count`/`raw_edge_count` ratio; `dropped_self_edge_count`; `unresolved_ref_count`; `fallback_ref_count` | collapse ratio steady; fallback/unresolved low |
| `aurora_bff_similar_family_resolution_failed` | rate | < ~1–2% (else recall items fall back to title-only dedupe) |
| `aurora_bff_relationship_graph_sibling_expansion_failed` | rate | ~0 (spikes = `product_group_members` DB trouble; collapse degrades to base refs, never breaks PDP) |
| `relationship_graph_curated_count` / `relationship_graph_served_count` | curated cards fetched vs served per PDP | served > 0 when master on |
| PDP `get_pdp_v2` route health | total latency; `similar_status` (`success`/`empty`/`deferred`); deferred rate | deferred rate stable (first-paint budget 1.2s) |
| DB query latency | the ref resolver + edge-fetch queries | within PDP budget; sibling-expansion is **uncached** (known follow-up) |
| Edge expiry | served edges expiring within 7/14/30 days | **4,827 edges expire within ~45d** — alert if a wave nears expiry with no refresh |

## Suggested alerts
- `…_resolution_failed` rate > 5% sustained → resolver/DB issue.
- `…_sibling_expansion_failed` rate > 1% → `product_group_members` DB issue.
- `fallback_ref_count` / `unresolved_ref_count` climbing → catalog resolution gaps (collapse weakening).
- PDP `similar` empty rate or `deferred` rate spike → latency/serving regression.
- Served edge count drops sharply, or > N edges expire within 7d unrefreshed → graph staleness.

## Rollout sequence (prod, dogfood-first)
1. All flags off; confirm prerequisites.
2. `AURORA_BFF_SIMILAR_FAMILY_DEDUPE_ENABLED=true` → internal/dogfood. Watch `…_resolution_failed`,
   similar empty/deferred, card diversity.
3. `AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED=true` (no-op while master off — validates config
   propagation).
4. `AURORA_BFF_RELATIONSHIP_GRAPH_ENABLED=true` → dogfood/internal. Watch curated/served counts, collapse
   metrics, PDP route health, similar deferred rate, DB latency.
5. Validate vs pilot acceptance before broadening; broaden to public only after Conditions 3 & 4 are met.

### Per-stage smoke check
For a serving-eligible, shade-heavy anchor, `POST /agent/shop/v1/invoke` with
`{operation:"get_pdp_v2", payload:{product_ref:{merchant_id:"external_seed", product_id:"<ext_id>"},
include:["similar"], similar:{limit:12}, options:{debug:true,cache_bypass:true}}}` (auth: `x-agent-api-key`).
Confirm `response.modules[type=similar].data.items` are one card per product family (no shade duplication,
no self-product). Reference: validated on staging 2026-06-03 (a Pro Filt'r concealer anchor, 19 edges → 6
distinct family cards; whole widget shade-clean).

## Rollback
Flip flags off independently — each is reversible and effective immediately:
- master off → no curated graph cards; recall-only similar.
- `…_SIMILAR_FAMILY_DEDUPE` off → recall family-dedupe removed.
- `…_FAMILY_COLLAPSE` off → serve raw (uncollapsed) edges if master stays on.
Migration 051 is additive (no rollback needed); no label/catalog data is rewritten by serving.
