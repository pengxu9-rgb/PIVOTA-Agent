# Aurora Stability Audit Report

- generated_at_utc: 2026-02-26T03:31:38Z
- workspace_root: /Users/pengchydan/Desktop/Pivota Infra/Pivota-cursor-create-project-directory-structure-8344

## Repo Summary

| repo | branch | commit | tracked_changes | untracked_files | staged_changes | total_changes |
|---|---|---|---:|---:|---:|---:|
| PIVOTA-Agent-hotfix | hotfix/photo-quality-soft-fallback-20260223 | 70d3331 | 28 | 31 | 0 | 28 |
| pivota-aurora-chatbox | hotfix/aurora-product-lowinfo-20260225 | 68ac241 | 24 | 13 | 0 | 24 |

## Modified/Untracked Details

### Backend
 M .dockerignore
 M .github/workflows/routine-expert-benchmark-gate.yml
 M .gitignore
 M Dockerfile
 M README.md
 M datasets/routine_expert_multiturn_seed.json
 M docs/deployment.md
 M package.json
 M reports/photo_modules_production_smoke.md
 M scripts/export_routine_multiturn_scoring_packets.cjs
 M scripts/gate_routine_expert_benchmark.sh
 M scripts/run_routine_multiturn_seed_cases.cjs
 M scripts/smoke_aurora_bff_runtime.sh
 M scripts/smoke_photo_modules_production.sh
 M src/auroraBff/competitorBlockRouter.js
 M src/auroraBff/memoryStore.js
 M src/auroraBff/productMatcherV1.js
 M src/auroraBff/qaPlanner.js
 M src/auroraBff/safetyEngineV1.js
 M src/auroraBff/schemas.js
 M src/server.js
 M src/services/missingCatalogProductsStore.js
 M src/telemetry/uiEvents.js
 M tests/aurora_bff.node.test.cjs
 M tests/aurora_bff_analysis_story_v2.node.test.cjs
 M tests/aurora_bff_routine_multiturn_contract_v2.node.test.cjs
 M tests/aurora_bff_routine_upgrade.node.test.cjs
 M tests/aurora_competitor_block_router.test.js
?? .railwayignore
?? datasets/routine_expert_multiturn_biotherm_cn_en.json
?? docs/runbooks/deploy_via_github_push_only.md
?? reports/aurora-stability-audit/Aurora_Routes_Risk_Inventory_20260226_003210.md
?? reports/aurora-stability-audit/Aurora_Stability_Audit_Report_20260225_160717.md
?? reports/aurora-stability-audit/Aurora_Stability_Audit_Report_20260225_160806.md
?? reports/aurora-stability-audit/Aurora_Stability_Audit_Report_20260226_033138.md
?? reports/photo_modules_production_smoke_20260226.md
?? reports/photo_modules_production_smoke_20260226_after_redeploy.md
?? reports/photo_modules_production_smoke_latest.md
?? scripts/audit_aurora_dirty_changes.sh
?? scripts/batch_photo_llm_review_pack.mjs
?? scripts/build_product_intel_fallback_baseline.mjs
?? scripts/verify_deployed_commit_matches.sh
?? src/auroraBff/gatePolicyRegistry.js
?? src/db/migrations/022_missing_catalog_products_reject_context.sql
?? src/db/migrations/023_aurora_safety_prompt_state.sql
?? tests/aurora_bff_analysis_story_single_model.node.test.cjs
?? tests/aurora_bff_dupe_suggest_sanitize.node.test.cjs
?? tests/aurora_bff_external_seed_contract.node.test.cjs
?? tests/aurora_bff_ingredient_filter_guardrails.node.test.cjs
?? tests/aurora_bff_photo_full_chain_e2e.node.test.cjs
?? tests/aurora_bff_product_open_contract.node.test.cjs
?? tests/aurora_bff_products_vs_discovery_schema.node.test.cjs
?? tests/aurora_bff_reco_generate_guardrails.node.test.cjs
?? tests/aurora_bff_reject_reason_persistence.node.test.cjs
?? tests/aurora_bff_relevance_qa_mode.node.test.cjs
?? tests/aurora_bff_timeout_budget_skip_qa.node.test.cjs
?? tests/aurora_chat_safety_advisory.node.test.cjs
?? tests/aurora_qa_safety_gate.node.test.cjs
?? tests/batch_photo_llm_review_pack.node.test.cjs

### Frontend
 M package.json
 M src/components/aurora/cards/PhotoModulesCard.tsx
 M src/components/chat/cards/AnalysisSummaryCard.tsx
 M src/components/chat/cards/DiagnosisCard.tsx
 M src/components/chat/cards/QuickProfileFlow.tsx
 M src/components/chat/cards/RoutineCompatibilityFooter.tsx
 M src/index.css
 M src/lib/auroraAnalytics.ts
 M src/lib/i18n.ts
 M src/lib/photoModulesContract.ts
 M src/lib/pivotaApi.ts
 M src/lib/recoGate.ts
 M src/lib/types.ts
 M src/main.tsx
 M src/pages/BffChat.tsx
 M src/pages/Plans.tsx
 M src/pages/Routine.tsx
 M src/specs/agent_state_machine.json
 M src/test/bffchat_product_parse_degrade.test.tsx
 M src/test/photoModules.acceptance.test.tsx
 M src/test/photo_modules_contract.test.ts
 M src/test/plans_page_behavior.test.tsx
 M src/test/recoGate.test.ts
 M src/test/routineCompatibilityFooter.render.test.tsx
?? _worktrees/
?? src/components/aurora/cards/AnalysisStoryCard.tsx
?? "src/components/aurora/cards/EnvStressCard 2.tsx"
?? src/components/aurora/cards/IngredientPlanCard.tsx
?? src/lib/productImage.ts
?? src/test/analysis_story_v2_ui.test.tsx
?? src/test/analysis_summary_card_routine_expert_v11.test.tsx
?? src/test/bffchat_routine_entry_stability.test.tsx
?? src/test/discovery_card_tracking.test.tsx
?? src/test/ingredient_plan_products_vs_discovery_ui.test.tsx
?? src/test/ingredient_plan_v2_open_link.test.tsx
?? src/test/photoModules.mask_overlay_priority.test.tsx
?? src/test/product_image_fallback.test.ts

## Suspicious File Names (* 2.*)

### Backend

### Frontend
/Users/pengchydan/Desktop/Pivota Infra/Pivota-cursor-create-project-directory-structure-8344/pivota-aurora-chatbox/src/components/aurora/cards/EnvStressCard 2.tsx

## _worktrees Pollution Scan

### Backend

### Frontend
/Users/pengchydan/Desktop/Pivota Infra/Pivota-cursor-create-project-directory-structure-8344/pivota-aurora-chatbox/_worktrees

## Merge Conflict Marker Scan

### Backend

### Frontend

