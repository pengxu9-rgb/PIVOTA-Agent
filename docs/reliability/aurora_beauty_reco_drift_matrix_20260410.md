# Aurora Beauty Reco Drift Matrix

Date: 2026-04-10

## Scope

This inventory covers `Mainline + Compat` only.

Included:

- beauty-owned `/v1/chat` reco mainline
- beauty discovery local mainline search lane
- shared catalog grounding / canonical payload bridge
- explicit legacy / compat boundaries that can still affect beauty-owned traffic

Excluded for this round:

- full non-mainline beauty reco cleanup
- prompt/model tuning beyond contract-preserving fixes
- selection/scoring redesign outside parity/ownership cleanup

## Current Owner Map

| Path | Ingress | Planner owner | Retrieval executor | Supplement / recovery | Rewrite authority | Final response authority | Observable markers |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Chat beauty mainline hard path | `/v1/chat -> maybeHandleBeautyOwnedChatRecoForRoute -> maybeHandleBeautyOwnedChatReco` | `beautyChatMainlineEntry` planner branch, with deterministic target-context fallback only when planner is blocked/untrusted | `handoffRecoToBeautyMainlineSearch` | local primary path is `runBeautyMainlineLocalHandoffSearch`; proxy rescue is explicit and only runs after local strict-empty | `maybeRewriteRecoAssistantTextWithLlm` only; deterministic fallback prose is not user-visible | `buildRecoPayloadFromBeautyMainlineHandoff -> applyRecoCanonicalSearchResultToPayload` | `query_source`, `decision_owner`, `semantic_owner`, `contract_bridge.resolved_contract`, `search_stage_ledger.final_selection`, `search_stage_ledger.primary_search`, `search_stage_ledger.local_handoff`, `search_stage_ledger.chat_mainline_timing` |
| Chat local handoff retrieval sublane | `handoffRecoToBeautyMainlineSearch -> runBeautyMainlineLocalHandoffSearch` | framework or step-aware target context derived before retrieval | `collectRecoCandidatesFromQueryLevels`, now routed through `executeRecoRecallPlanEntry` instead of a bespoke internal-only branch | stage A primary internal + stage B primary external-seed coverage only; support levels are skipped and recorded, not silently run | none | `buildBeautyMainlineLocalSearchResult` | `search_stage_ledger.primary_search.query_pack_attempts`, `search_stage_ledger.local_handoff.query_pack_attempts`, `transport_policy_mode`, `skipped_support_levels`, `skipped_external_seed_levels`, `semantic_owner_query_attempts` |
| Search-side beauty discovery mainline | `/agent/v1/products/search` / gateway surfaces gated by `shouldUseLocalBeautyDiscoveryMainline` | semantic contract from direct search lane | `runLocalBeautyDiscoveryMainline` in `findProductsBeautyDiscoveryLocalMainline.js` | explicit direct child recall and supplement traces; no hidden legacy owner switch | none | local beauty search authority / metadata authority path | `query_source=beauty_discovery_local_mainline`, `search_stage_ledger.primary_search.query_pack_attempts`, `search_execution_trace`, `source_observability`, `primary_failure_stage`, `supplement_traces` |
| Shared catalog grounding / payload bridge | search result entering chat payload assembly | none; authoritative snapshot only | none | none | none | `extractRecoCanonicalSearchResultSnapshot` + `applyRecoCanonicalSearchResultToPayload` | `final_selection`, `mainline_status`, `source_breakdown.source_tier_counts`, `top_candidate_provenance`, `contract_bridge`, `selection_signature` |
| Legacy / compat quarantine | `maybeHandleLegacyChatRecoRouteEntryForRoute`, `legacyChatReco*`, `/v1/reco/generate` | legacy planner stack | legacy reco execution paths | compatibility only | legacy prompt stack | legacy envelope assembly | `request_class=legacy_compat`, compat-only route entry, non-mainline DTOs |

## Drift Inventory

| Priority | Drift class | Live path | Symptom | Cleanup in this round | Post-cleanup invariant |
| --- | --- | --- | --- | --- | --- |
| P0 | stage label and runtime mismatch | chat local handoff `collectRecoCandidatesFromQueryLevels` | stage B was labeled `external_seed`, but the runtime call still forced `allowExternalSeed=false` and `step_aware` internal transport | removed the bespoke query-level search branch; local handoff now calls `executeRecoRecallPlanEntry` and propagates `source_scope`, `deadlineMs`, external strategy, and transport policy through the same executor used by recall-plan mainline | every stage B query emits `allowExternalSeed=true`, direct-only external transport settings, and `source_scope=external_seed` in the local handoff query ledger |
| P1 | duplicate retrieval executor | chat local handoff | query-level collector had a parallel implementation with different defaults from recall-plan execution | local handoff query execution now reuses `executeRecoRecallPlanEntry` | framework/step-aware/external stages share one retrieval-stage executor contract |
| P1 | observability drift | chat local handoff vs search-side mainline | local handoff exposed only level counts, while search-side mainline exposed per-query `primary_search.query_pack_attempts` | local handoff now emits both `search_stage_ledger.primary_search` and back-compat `search_stage_ledger.local_handoff`, each carrying `query_pack_attempts`, `executed_query_count`, and `transport_policy_mode` | prod responses can show planned vs executed stages and per-query source scope without reconstructing from ad hoc fields |
| P1 | supplement can appear to own primary | chat local handoff framework path | support lanes could look like part of the primary path if not explicitly accounted for | local handoff keeps only stage A internal plus stage B primary external coverage; support stages are skipped and written into the ledger | support only repairs coverage and never silently replaces the primary owner |
| P1 | hidden owner switch into legacy | `/v1/chat` beauty-owned reco | beauty-owned traffic can degrade if legacy route entry is reached after mainline ownership was already established | existing hard-stop behavior retained and re-verified: beauty-owned chat resolves or fail-closes before the legacy route entry can take over | beauty-owned chat never enters legacy reco lane unless the request is explicitly outside beauty-owned mainline scope |
| P2 | proxy rescue can hide local failure origin | chat hard path after local strict-empty | proxy rescue is valid, but without a preflight snapshot it can obscure which stage actually failed | existing `local_handoff_preflight` snapshot retained as the explicit boundary marker | when proxy rescue happens, the original local handoff outcome remains inspectable in the final response metadata |

## Cleanup Applied In This Round

1. Local handoff query execution now uses the recall-plan executor path.
2. External-stage runtime semantics are preserved all the way to the primitive call.
3. Local handoff search-stage observability is normalized into:
   - `search_stage_ledger.primary_search`
   - `search_stage_ledger.local_handoff`
   - `semantic_owner_query_attempts`
4. Local handoff now preserves horizontal comparison for multiple primary-role products across internal and external sources instead of collapsing to a single visible winner.

## Verification

Targeted checks added or refreshed:

- `tests/aurora_bff_beauty_mainline_handoff.node.test.cjs`
  - verifies stage B external-seed queries carry the real external runtime contract
  - verifies local handoff emits `primary_search.query_pack_attempts` plus `local_handoff.query_pack_attempts`
  - verifies internal + external primary-role candidates can both survive into final selection
- existing `tests/find_products_beauty_discovery_local_mainline.node.test.cjs`
  - already covers direct external-seed child recall and search-side mainline query-pack observability
- existing `tests/aurora_bff_reco_relevance.node.test.cjs`
  - keeps the beauty-owned `/v1/chat` vs legacy boundary guarded

## Known Remaining Work

- `find_products_beauty_discovery_local_mainline.node.test.cjs` still has pre-existing red tests around `catalog_child_recall` and one timeout-floor case; those failures were reproduced in this round but are not introduced by the local handoff cleanup.
- Search-side mainline and chat local handoff now expose comparable `primary_search` query ledgers, but they still originate from different ingress functions. A later cleanup pass can extract a shared ledger builder if we want byte-for-byte parity.
- Rewrite reliability remains a separate quality track after retrieval/ownership drift is cleaned. This round only removes and isolates retrieval drift so rewrite failures are no longer masking a search-side contract bug.
