# Aurora Chat v2 Prompt Inventory

Generated: 2026-03-08T01:44:19.786Z

Aurora Chat v2 prompt surface in the Node BFF. Legacy routes.js prompt calls outside the v2 surface remain a follow-up audit scope.

## Summary

- Manifest templates: 13
- Inventory rows: 14
- Structured rows: 13
- Free-form rows: 1
- Manifest templates covered: 13/13

## Coverage

- Missing from inventory: none
- Extra inventory rows: chat.freeform

## Prompt Table

| Priority | Template / Call | Version | Mode | Schema | Entrypoint | Source |
| --- | --- | --- | --- | --- | --- | --- |
| P0 | diagnosis_v2_answer_blueprint | 1.1.0 | structured | DiagnosisBlueprintOutput | diagnosis_v2.answer | src/auroraBff/skills/diagnosis_v2_answer.js |
| P0 | ingredient_report | 2.1.0 | structured | IngredientReportOutput | ingredient.report | src/auroraBff/skills/ingredient_report.js |
| P0 | product_analyze | 1.1.0 | structured | ProductAnalysisOutput | product.analyze | src/auroraBff/skills/product_analyze.js |
| P0 | routine_audit_optimize | 1.1.0 | structured | RoutineAuditOutput | routine.audit_optimize | src/auroraBff/skills/routine_audit_optimize.js |
| P0 | tracker_checkin_insights | 1.1.0 | structured | CheckinInsightsOutput | tracker.checkin_insights | src/auroraBff/skills/tracker_checkin_insights.js |
| P0 | travel_apply_mode | 1.1.0 | structured | TravelModeOutput | travel.apply_mode | src/auroraBff/skills/travel_apply_mode.js |
| P1 | chat.freeform | inline_system_prompt_v2 | freeform_chat | - | skill_router._handleFreeFormChat | src/auroraBff/orchestrator/skill_router.js |
| P1 | ingredient_query_answer | 1.1.0 | structured | IngredientQueryOutput | ingredient.report | src/auroraBff/skills/ingredient_report.js |
| P1 | intent_classifier | 1.1.0 | structured | IntentClassifierOutput | skill_router._classifyIntent | src/auroraBff/orchestrator/skill_router.js |
| P1 | reco_step_based | 1.1.0 | structured | StepRecommendationOutput | reco.step_based | src/auroraBff/skills/reco_step_based.js |
| P2 | diagnosis_v2_start_personalized | 1.1.0 | structured | - | diagnosis_v2.start | src/auroraBff/skills/diagnosis_v2_start.js |
| P2 | dupe_compare | 1.1.0 | structured | DupeCompareOutput | dupe.compare | src/auroraBff/skills/dupe_compare.js |
| P2 | dupe_suggest | 1.1.0 | structured | DupeSuggestOutput | dupe.suggest | src/auroraBff/skills/dupe_suggest.js |
| P2 | routine_categorize_products | 1.1.0 | structured | ProductCategorizationOutput | routine.intake_products | src/auroraBff/skills/routine_intake_products.js |

## Audit Queue

### P0

- `diagnosis_v2_answer_blueprint` via `diagnosis_v2.answer` in `src/auroraBff/skills/diagnosis_v2_answer.js`
  Inputs: goals, profile, recent_logs, has_photo, safety_flags, locale
  Schema: DiagnosisBlueprintOutput | Task mode: diagnosis | Focus: Schema completeness, no-photo guardrails, question sequencing, and safety-first blueprinting.
- `ingredient_report` via `ingredient.report` in `src/auroraBff/skills/ingredient_report.js`
  Inputs: ingredient_query, ontology_match, profile, safety_flags, locale
  Schema: IngredientReportOutput | Task mode: ingredient | Focus: Ingredient-level claims only, uncertain-evidence wording, and guaranteed ingredient_claims coverage.
- `product_analyze` via `product.analyze` in `src/auroraBff/skills/product_analyze.js`
  Inputs: product_anchor, ingredient_list, profile, safety_flags, current_routine, locale
  Schema: ProductAnalysisOutput | Task mode: product_analysis | Focus: Structured usage guidance, SPF hard rules, retinoid caution, and no-guess ingredient reasoning.
- `routine_audit_optimize` via `routine.audit_optimize` in `src/auroraBff/skills/routine_audit_optimize.js`
  Inputs: routine, profile, audit_results, safety_flags, locale
  Schema: RoutineAuditOutput | Task mode: routine | Focus: Safety edits, strong-active reductions, and conservative optimization when routine data is incomplete.
- `tracker_checkin_insights` via `tracker.checkin_insights` in `src/auroraBff/skills/tracker_checkin_insights.js`
  Inputs: checkin_logs, profile, routine, has_photos, locale
  Schema: CheckinInsightsOutput | Task mode: tracker | Focus: No-photo visual-claim suppression, trend grounding, and conservative change summaries.
- `travel_apply_mode` via `travel.apply_mode` in `src/auroraBff/skills/travel_apply_mode.js`
  Inputs: travel_plan, climate_archetype, profile, current_routine, safety_flags, locale
  Schema: TravelModeOutput | Task mode: travel | Focus: High-UV adjustments, reduce_actives triggering, packing guidance, and climate uncertainty handling.

### P1

- `chat.freeform` via `skill_router._handleFreeFormChat` in `src/auroraBff/orchestrator/skill_router.js`
  Inputs: user_message, system_prompt, context, locale
  Schema: none | Task mode: chat | Focus: Answer quality, tone, safety, factual caution, and SSE chunk/result consistency.
- `ingredient_query_answer` via `ingredient.report` in `src/auroraBff/skills/ingredient_report.js`
  Inputs: user_question, profile, safety_flags, locale
  Schema: IngredientQueryOutput | Task mode: ingredient | Focus: Free-form ingredient education quality, concise directness, and follow-up ingredient grounding.
- `intent_classifier` via `skill_router._classifyIntent` in `src/auroraBff/orchestrator/skill_router.js`
  Inputs: user_message
  Schema: IntentClassifierOutput | Task mode: chat | Focus: Routing precision, false-positive skill jumps, and stable fallback to free-form chat.
- `reco_step_based` via `reco.step_based` in `src/auroraBff/skills/reco_step_based.js`
  Inputs: profile, routine, inventory, target_step, target_ingredient, concerns, safety_flags, locale
  Schema: StepRecommendationOutput | Task mode: recommendation | Focus: Recommendation relevance, empty-pool behavior, concern/ingredient routing, and next_actions quality.

### P2

- `diagnosis_v2_start_personalized` via `diagnosis_v2.start` in `src/auroraBff/skills/diagnosis_v2_start.js`
  Inputs: skin_type, concerns, locale
  Schema: none | Task mode: diagnosis | Focus: Opening personalization quality, user-history grounding, and over-claim avoidance.
- `dupe_compare` via `dupe.compare` in `src/auroraBff/skills/dupe_compare.js`
  Inputs: anchor, targets, profile, locale
  Schema: DupeCompareOutput | Task mode: dupe | Focus: Comparison fairness, tradeoff framing, and strict support in candidate evidence.
- `dupe_suggest` via `dupe.suggest` in `src/auroraBff/skills/dupe_suggest.js`
  Inputs: anchor, candidates, profile, locale
  Schema: DupeSuggestOutput | Task mode: dupe | Focus: Candidate quality ranking, empty-state behavior, and no fabricated similarity claims.
- `routine_categorize_products` via `routine.intake_products` in `src/auroraBff/skills/routine_intake_products.js`
  Inputs: products, routine, locale
  Schema: ProductCategorizationOutput | Task mode: routine | Focus: Step classification accuracy, duplicate assignment, and null-safe handling of unknown products.

## Production Review Fields

- QPS and user-facing traffic share per template/call
- Schema-fail rate, parse-fail rate, and quality-gate intervention rate
- Median and p95 latency, timeout rate, and retry frequency
- Empty-state rate, fallback rate, and safety-block rate
- Human review sample score for groundedness, usefulness, and tone
- Regression links to fixtures, live probes, and notable bad-case examples

## Next Scope

- Legacy `src/auroraBff/routes.js` prompt calls outside Aurora Chat v2 are not included here.
- Glow mirrors the v2 contract, but prompt authorship remains anchored in the Node BFF manifest and gateway registry.
