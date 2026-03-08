# Aurora Prompt Node Spec Matrix

Generated: 2026-03-08T01:44:19.349Z

This file is the implementation-ready prompt spec library for Aurora v2 plus legacy Node prompt nodes. It is the source of truth for node goals, consumer contracts, rewrite priorities, and the best matching prompt archetype.

## Summary

- Total nodes: 28
- Surfaces: Aurora v2=14, legacy Node=14
- Priorities: P0=11, P1=9, P2=8
- Clusters: Aurora v2 router + skills=14 | legacy diagnosis / gating=2 | legacy skin analysis=3 | legacy product intel / fit check=1 | legacy reco selection=4 | legacy ingredient research=2 | legacy analysis story generation / review=2

## Archetype Library

| Archetype | Purpose | Required Sections |
| --- | --- | --- |
| classifier | Map a user utterance or structured input into a small set of deterministic downstream routes. | role/system block, classification task block, allowed labels / enums, confidence contract, entity extraction contract, hard disambiguation rules, missing-data / low-confidence policy, forbidden routing behavior, locale policy |
| structured analyzer / planner | Turn contextual skincare inputs into schema-bound structured guidance or plan objects. | role/system block, task block, output contract block, field semantics block, hard rules block, missing-data policy, forbidden behavior block, locale policy, deterministic post-processing boundary |
| strict selector / ranker | Select, rank, or filter candidates under hard grounding constraints. | role/system block, selection task block, candidate grounding block, output contract block, hard rules block, ranking priorities, missing-data policy, forbidden behavior block, locale policy |
| reviewer / patcher | Review a candidate payload against evidence and patch it without expanding scope. | role/system block, review task block, patch output contract, approval / rejection criteria, hard rules block, evidence boundary block, forbidden behavior block, locale policy |
| conversational answerer | Produce concise user-facing answers while optionally attaching lightweight structured hints for follow-up actions. | role/system block, answering task block, tone and safety rules, optional structured attachment contract, missing-data policy, forbidden behavior block, locale policy, free-form example policy |
| multimodal extractor / report synthesizer | Convert image or multimodal evidence into grounded canonical cosmetic-skin outputs. | role/system block, multimodal evidence scope block, output contract block, grounding rules, quality / insufficiency rubric, hard rules block, forbidden behavior block, locale policy, deterministic rendering boundary |

## Node Index

| Priority | Node ID | Cluster | Archetype | Consumer | Prompt Source |
| --- | --- | --- | --- | --- | --- |
| P2 | v2.diagnosis_v2_start_personalized | Aurora v2 router + skills | conversational answerer | DiagnosisStartSkill | src/auroraBff/services/llm_gateway.js::diagnosis_v2_start_personalized |
| P0 | v2.diagnosis_v2_answer_blueprint | Aurora v2 router + skills | structured analyzer / planner | DiagnosisAnswerSkill | src/auroraBff/services/llm_gateway.js::diagnosis_v2_answer_blueprint |
| P2 | v2.routine_categorize_products | Aurora v2 router + skills | structured analyzer / planner | RoutineIntakeProductsSkill | src/auroraBff/services/llm_gateway.js::routine_categorize_products |
| P0 | v2.routine_audit_optimize | Aurora v2 router + skills | structured analyzer / planner | RoutineAuditOptimizeSkill | src/auroraBff/services/llm_gateway.js::routine_audit_optimize |
| P1 | v2.reco_step_based | Aurora v2 router + skills | structured analyzer / planner | RecoStepBasedSkill | src/auroraBff/services/llm_gateway.js::reco_step_based |
| P0 | v2.tracker_checkin_insights | Aurora v2 router + skills | structured analyzer / planner | TrackerCheckinInsightsSkill | src/auroraBff/services/llm_gateway.js::tracker_checkin_insights |
| P0 | v2.product_analyze | Aurora v2 router + skills | structured analyzer / planner | ProductAnalyzeSkill | src/auroraBff/services/llm_gateway.js::product_analyze |
| P0 | v2.ingredient_report | Aurora v2 router + skills | structured analyzer / planner | IngredientReportSkill._handleSpecificIngredient | src/auroraBff/services/llm_gateway.js::ingredient_report |
| P1 | v2.ingredient_query_answer | Aurora v2 router + skills | conversational answerer | IngredientReportSkill._handleIngredientQuestion | src/auroraBff/services/llm_gateway.js::ingredient_query_answer |
| P1 | v2.intent_classifier | Aurora v2 router + skills | classifier | SkillRouter | src/auroraBff/services/llm_gateway.js::intent_classifier |
| P2 | v2.dupe_suggest | Aurora v2 router + skills | structured analyzer / planner | DupeSuggestSkill | src/auroraBff/services/llm_gateway.js::dupe_suggest |
| P2 | v2.dupe_compare | Aurora v2 router + skills | structured analyzer / planner | DupeCompareSkill | src/auroraBff/services/llm_gateway.js::dupe_compare |
| P0 | v2.travel_apply_mode | Aurora v2 router + skills | structured analyzer / planner | TravelApplyModeSkill | src/auroraBff/services/llm_gateway.js::travel_apply_mode |
| P1 | v2.chat.freeform | Aurora v2 router + skills | conversational answerer | SkillRouter | src/auroraBff/services/llm_gateway.js::buildFreeformChatSystemPrompt + chat() |
| P2 | legacy.diagnosis_gate.prompt | legacy diagnosis / gating | conversational answerer | legacy /v1/chat diagnosis gate | src/auroraBff/gating.js::buildDiagnosisPrompt |
| P2 | legacy.fit_check.anchor_gate | legacy diagnosis / gating | conversational answerer | legacy fit-check anchor collection | src/auroraBff/routes.js::buildFitCheckAnchorPrompt |
| P1 | legacy.skin.vision_mainline | legacy skin analysis | multimodal extractor / report synthesizer | skinLlmGateway vision layer | src/auroraBff/skinLlmPrompts.js::buildSkinVisionPromptBundle |
| P0 | legacy.skin.report_mainline | legacy skin analysis | multimodal extractor / report synthesizer | skinLlmGateway report layer | src/auroraBff/skinLlmPrompts.js::buildSkinReportPromptBundle |
| P1 | legacy.skin.deepening_mainline | legacy skin analysis | multimodal extractor / report synthesizer | skinLlmGateway deepening layer | src/auroraBff/skinLlmPrompts.js::buildSkinDeepeningPromptBundle |
| P0 | legacy.product_intel.deep_scan | legacy product intel / fit check | structured analyzer / planner | legacy product intel / fit-check routes | src/auroraBff/routes.js::buildProductDeepScanPrompt(V2/V3/V4) |
| P0 | legacy.reco.main_selector | legacy reco selection | strict selector / ranker | legacy reco main route | src/auroraBff/routes.js::reco_main_v1_0 system + user payload |
| P1 | legacy.reco.alternatives_selector | legacy reco selection | strict selector / ranker | legacy reco alternatives flow | src/auroraBff/routes.js::reco_alternatives_v1_0 system + payload |
| P1 | legacy.reco.product_lookup_fallback | legacy reco selection | strict selector / ranker | recoverProductsWithLlmFallbackFromQueries | src/auroraBff/routes.js::buildProductLookupLlmFallbackPrompt |
| P2 | legacy.ingredient.lookup_upstream | legacy ingredient research | conversational answerer | legacy ingredient lookup upstream call | src/auroraBff/routes.js::buildIngredientLookupUpstreamPrompt |
| P2 | legacy.ingredient.reco_upstream | legacy reco selection | strict selector / ranker | legacy ingredient recommendation upstream call | src/auroraBff/routes.js::buildIngredientRecoUpstreamPrompt |
| P0 | legacy.ingredient.research_sync | legacy ingredient research | structured analyzer / planner | runIngredientResearchSync | src/auroraBff/routes.js::buildIngredientResearchPrompts |
| P0 | legacy.analysis_story.generate | legacy analysis story generation / review | structured analyzer / planner | generateAnalysisStoryV2JsonWithLlm | src/auroraBff/routes.js::buildAnalysisStoryGenerationPrompt |
| P1 | legacy.analysis_story.review | legacy analysis story generation / review | reviewer / patcher | reviewAnalysisStoryV2JsonWithLlm | src/auroraBff/routes.js::buildAnalysisStoryReviewPrompt |

## Detailed Specs

### Aurora v2 router + skills

#### v2.diagnosis_v2_start_personalized

- Priority: P2
- Runtime surface: Aurora Chat v2
- Call mode: structured_llm
- Entrypoint: diagnosis_v2.start
- Consumer: DiagnosisStartSkill
- Prompt source: src/auroraBff/services/llm_gateway.js::diagnosis_v2_start_personalized
- Current version/variant: 1.1.0
- Dormant variants: none
- Provider path: LlmGateway.call -> Gemini structured JSON
- Archetype: conversational answerer
- Goal: Ask a short, personalized set of follow-up diagnosis questions without sounding generic or over-medicalized.
- Output contract: schema=none | schema_required=none | consumer_required=follow_up_questions[]; localized question text; options[]
- Deterministic boundary: Skill decides card wiring and next_actions.; Prompt only proposes follow-up questions and options.
- Hard rules: Questions must stay cosmetic-skincare scoped.; Do not ask for photos unless the route specifically needs them.; Keep question count short.
- Missing-data policy: Use concerns and skin_type when present.; If profile is sparse, ask broad but still concrete follow-up questions.
- Forbidden behaviors: No disease diagnosis.; No product recommendations.; No long questionnaire dumps.
- Best prompt skeleton: Role: concise diagnosis onboarding assistant.; Task: ask 2-3 personalized follow-up questions.; Output contract: follow_up_questions[] with localized labels and options.; Hard rules: short, relevant, non-medical.
- Locale policy: English prompt body; output question_en/question_zh, localized by locale.
- Example policy: One short example question block is enough.
- Eval assets: tests/skills/test_skill_contract.js::gf_diagnosis_start_basic

#### v2.diagnosis_v2_answer_blueprint

- Priority: P0
- Runtime surface: Aurora Chat v2
- Call mode: structured_llm
- Entrypoint: diagnosis_v2.answer
- Consumer: DiagnosisAnswerSkill
- Prompt source: src/auroraBff/services/llm_gateway.js::diagnosis_v2_answer_blueprint
- Current version/variant: 1.1.0
- Dormant variants: none
- Provider path: LlmGateway.call -> Gemini structured JSON
- Archetype: structured analyzer / planner
- Goal: Synthesize a conservative diagnosis blueprint from goals, profile, logs, and photo availability, without hallucinating visual evidence.
- Output contract: schema=DiagnosisBlueprintOutput | schema_required=blueprint_id; inferred_skin_type; primary_concerns | consumer_required=severity_scores; confidence; visual_observations|null; nudge|null; next_recommended_skills[]
- Deterministic boundary: Skill suppresses visual_analysis when no photo.; Prompt still needs to keep visual_observations null/empty when has_photo=false.
- Hard rules: If has_photo=false, visual_observations must be null or [].; Primary concerns must align with goals/profile; max 3.; Severity scores must map to primary concerns only.; No medical diagnosis language.
- Missing-data policy: If profile skin type is missing, use "unknown" instead of guessing.; If logs are sparse, keep confidence conservative and nudge optional.; If no clear nudge exists, return null.
- Forbidden behaviors: No claims based on unseen photos.; No treatment promises.; No repeated profile recap in every field.
- Best prompt skeleton: Role: evidence-aware skin blueprint planner.; Task: infer a diagnosis blueprint from goals/profile/logs/photo availability.; Output contract: blueprint JSON with optional visual_observations and nudge.; Hard rules: no-photo guardrail, conservative confidence, concern alignment.
- Locale policy: English prompt body; localized fields only where the schema explicitly allows *_zh or localized nudge text.
- Example policy: Use one compact JSON shape example, not prose examples.
- Eval assets: tests/skills/test_skill_contract.js::gf_diagnosis_answer_no_photo; tests/aurora_chat_v2_prompt_contract.node.test.cjs

#### v2.routine_categorize_products

- Priority: P2
- Runtime surface: Aurora Chat v2
- Call mode: structured_llm
- Entrypoint: routine.intake_products
- Consumer: RoutineIntakeProductsSkill
- Prompt source: src/auroraBff/services/llm_gateway.js::routine_categorize_products
- Current version/variant: 1.1.0
- Dormant variants: none
- Provider path: LlmGateway.call -> Gemini structured JSON
- Archetype: structured analyzer / planner
- Goal: Categorize user-provided products into routine steps without over-classifying unknown items.
- Output contract: schema=ProductCategorizationOutput | schema_required=categorized_products | consumer_required=step assignment; dedupe-safe categorization
- Deterministic boundary: Skill handles routine card shaping.; Prompt only assigns categories and reasons.
- Hard rules: Do not duplicate the same product across conflicting steps unless uncertainty is explicit.; Unknown products should stay conservative.; No brand guessing beyond the provided text.
- Missing-data policy: If the product function is unclear, categorize as other/unknown instead of guessing.; Return empty arrays rather than fabricating categories.
- Forbidden behaviors: No new products.; No efficacy promises.; No routine optimization advice.
- Best prompt skeleton: Role: routine intake classifier.; Task: assign products to routine steps.; Output contract: categorized_products[].; Hard rules: conservative categorization and dedupe.
- Locale policy: English prompt body; localized text only when explicitly requested by the schema.
- Example policy: Prefer one compact array example.
- Eval assets: tests/aurora_bff_skills_orchestrator.node.test.cjs

#### v2.routine_audit_optimize

- Priority: P0
- Runtime surface: Aurora Chat v2
- Call mode: structured_llm
- Entrypoint: routine.audit_optimize
- Consumer: RoutineAuditOptimizeSkill
- Prompt source: src/auroraBff/services/llm_gateway.js::routine_audit_optimize
- Current version/variant: 1.1.0
- Dormant variants: none
- Provider path: LlmGateway.call -> Gemini structured JSON
- Archetype: structured analyzer / planner
- Goal: Translate deterministic audit findings and user context into a safer, simpler optimized routine.
- Output contract: schema=RoutineAuditOutput | schema_required=changes; compatibility_issues | consumer_required=optimized_am_steps; optimized_pm_steps
- Deterministic boundary: Deterministic audit precomputes SPF/retinoid/interaction issues.; Prompt should propose optimized steps and human-readable change rationale, not override audit facts.
- Hard rules: Safety fixes beat cosmetic optimization.; Respect pregnancy / barrier / sensitivity flags.; If routine data is incomplete, prefer minimal safe edits over elaborate rewrites.
- Missing-data policy: If a step cannot be confidently optimized, keep the original step shape.; If compatibility issues are unclear, return them conservatively rather than inventing new conflicts.
- Forbidden behaviors: No aggressive escalation of actives.; No replacing products with invented items.; No contradicting deterministic safety fixes.
- Best prompt skeleton: Role: conservative routine auditor.; Task: optimize routine using deterministic audit findings.; Output contract: optimized steps, changes, compatibility issues.; Hard rules: safety-first and no fabricated replacements.
- Locale policy: English prompt body; localized user-facing text only when the schema allows it.
- Example policy: One compact before/after JSON example is sufficient.
- Eval assets: tests/skills/test_skill_contract.js::gf_post_procedure_recovery; tests/aurora_bff_routine_multiturn_contract_v2.node.test.cjs

#### v2.reco_step_based

- Priority: P1
- Runtime surface: Aurora Chat v2
- Call mode: structured_llm
- Entrypoint: reco.step_based
- Consumer: RecoStepBasedSkill
- Prompt source: src/auroraBff/services/llm_gateway.js::reco_step_based
- Current version/variant: 1.1.0
- Dormant variants: none
- Provider path: LlmGateway.call -> Gemini structured JSON
- Archetype: structured analyzer / planner
- Goal: Recommend products or steps from context with concern/ingredient awareness and graceful empty-state behavior.
- Output contract: schema=StepRecommendationOutput | schema_required=step_recommendations | consumer_required=reasoning per recommendation; next_actions-compatible recommendation shape
- Deterministic boundary: Skill and quality gates sanitize candidate pools and next_actions.; Prompt should rank and justify recommendations only from supplied context.
- Hard rules: If evidence or candidates are weak, return fewer items.; Respect target_ingredient and concerns when present.; Avoid stale "start tracking" style calls to action in recommendation content.
- Missing-data policy: When profile/routine is sparse, stay concern-first and conservative.; If no good match exists, return an explainable empty result.
- Forbidden behaviors: No invented catalog products.; No hard claims without support.; No dumping generic routines when asked for product picks.
- Best prompt skeleton: Role: recommendation planner.; Task: produce step-based recommendations from supplied context.; Output contract: step_recommendations[].; Hard rules: groundedness, empty-state behavior, concern/ingredient fidelity.
- Locale policy: English prompt body; localized user-facing text only where the schema allows.
- Example policy: Use one compact recommendation array example.
- Eval assets: tests/aurora_chat_v2_routes.node.test.cjs; tests/skills/test_skill_contract.js::gf_dupe_suggest_no_candidates

#### v2.tracker_checkin_insights

- Priority: P0
- Runtime surface: Aurora Chat v2
- Call mode: structured_llm
- Entrypoint: tracker.checkin_insights
- Consumer: TrackerCheckinInsightsSkill
- Prompt source: src/auroraBff/services/llm_gateway.js::tracker_checkin_insights
- Current version/variant: 1.1.0
- Dormant variants: none
- Provider path: LlmGateway.call -> Gemini structured JSON
- Archetype: structured analyzer / planner
- Goal: Summarize check-in trends and next actions conservatively, especially when there are no photos.
- Output contract: schema=CheckinInsightsOutput | schema_required=trend_summary; suggested_action | consumer_required=sensation_trend; days_tracked; attribution|null; detailed_review|null
- Deterministic boundary: Skill validator blocks visual references when no photos exist.; Prompt should already avoid photo-grounded wording unless has_photos=true.
- Hard rules: If has_photos=false, do not describe visible changes.; Trend summaries must stay grounded in logs, not imagined progress.; Suggested action must be one the skill knows how to route.
- Missing-data policy: If attribution is weak, use uncertain attribution or null.; If logs are noisy, keep the summary cautious and short.
- Forbidden behaviors: No visual claims without photos.; No fabricated causal certainty.; No judgmental tone.
- Best prompt skeleton: Role: progress insights analyst.; Task: summarize check-in trends and suggest the next best action.; Output contract: trend_summary, attribution, detailed_review, suggested_action.; Hard rules: no-photo guardrail and conservative causality.
- Locale policy: English prompt body; output localized text only when explicitly allowed.
- Example policy: Use one short structured output example.
- Eval assets: tests/skills/test_skill_contract.js::gf_checkin_insights_no_photo

#### v2.product_analyze

- Priority: P0
- Runtime surface: Aurora Chat v2
- Call mode: structured_llm
- Entrypoint: product.analyze
- Consumer: ProductAnalyzeSkill
- Prompt source: src/auroraBff/services/llm_gateway.js::product_analyze
- Current version/variant: 1.1.0
- Dormant variants: none
- Provider path: LlmGateway.call -> Gemini structured JSON
- Archetype: structured analyzer / planner
- Goal: Provide a grounded product suitability verdict and usage guidance that deterministic safety rules can safely refine.
- Output contract: schema=ProductAnalysisOutput | schema_required=product_name; product_type; suitability; usage | consumer_required=brand|null; has_spf; key_ingredients[]; risk_flags[]
- Deterministic boundary: Deterministic layer enforces SPF, retinoid, pregnancy, and high-acid hard overrides.; Prompt should still return a coherent baseline usage object and grounded risk flags.
- Hard rules: SPF must be AM only with reapply guidance.; Retinoids should bias PM-only and gradual onboarding.; Do not fabricate ingredients when ingredient_list is weak or missing.
- Missing-data policy: Use null or [] for unknown ingredient facts.; Keep verdict cautious when formulation evidence is incomplete.
- Forbidden behaviors: No brand hallucination.; No concentration guessing.; No PM-first sunscreen guidance.
- Best prompt skeleton: Role: objective product analyst.; Task: analyze product suitability from anchor + ingredient context.; Output contract: product verdict JSON.; Hard rules: SPF / retinoid / pregnancy / uncertainty.
- Locale policy: English prompt body; *_zh fields only when locale justifies them.
- Example policy: One compact JSON example is enough.
- Eval assets: tests/skills/test_skill_contract.js::gf_product_analyze_spf; tests/aurora_chat_v2_prompt_contract.node.test.cjs

#### v2.ingredient_report

- Priority: P0
- Runtime surface: Aurora Chat v2
- Call mode: structured_llm
- Entrypoint: ingredient.report
- Consumer: IngredientReportSkill._handleSpecificIngredient
- Prompt source: src/auroraBff/services/llm_gateway.js::ingredient_report
- Current version/variant: 2.1.0
- Dormant variants: none
- Provider path: LlmGateway.call -> Gemini structured JSON
- Archetype: structured analyzer / planner
- Goal: Generate a conservative ingredient report that always contains ingredient-level claims and never turns uncertainty into product marketing.
- Output contract: schema=IngredientReportOutput | schema_required=ingredient_name; claims | consumer_required=inci_name|null; category; description_en; benefits[]; how_to_use|null; watchouts[]; interactions[]; related_ingredients[]
- Deterministic boundary: Skill injects a cautious ingredient_claims section when claims are empty.; Prompt should still return well-formed claims and watchouts whenever possible.
- Hard rules: Unknown or unverified ingredients must not be framed as confirmed facts.; Claims must stay ingredient-level only.; Every claim needs an evidence badge.
- Missing-data policy: If ontology is missing, keep claims generic and uncertain.; If INCI is unknown, return null instead of guessing.
- Forbidden behaviors: No "products containing X".; No branded examples.; No medical certainty.
- Best prompt skeleton: Role: evidence-aware ingredient analyst.; Task: produce a structured ingredient report.; Output contract: overview, benefits, claims, usage, watchouts, interactions.; Hard rules: uncertain evidence and no productization.
- Locale policy: English prompt body; description_zh/text_zh may be null when locale is not Chinese.
- Example policy: One short JSON example is enough.
- Eval assets: tests/skills/test_skill_contract.js::gf_ingredient_unverified; tests/aurora_chat_v2_skill_guards.node.test.cjs; tests/aurora_chat_v2_prompt_contract.node.test.cjs

#### v2.ingredient_query_answer

- Priority: P1
- Runtime surface: Aurora Chat v2
- Call mode: structured_llm
- Entrypoint: ingredient.report::_handleIngredientQuestion
- Consumer: IngredientReportSkill._handleIngredientQuestion
- Prompt source: src/auroraBff/services/llm_gateway.js::ingredient_query_answer
- Current version/variant: 1.1.0
- Dormant variants: none
- Provider path: LlmGateway.call -> Gemini structured JSON
- Archetype: conversational answerer
- Goal: Answer open ingredient questions directly while optionally surfacing a short ingredient list for follow-up exploration.
- Output contract: schema=IngredientQueryOutput | schema_required=answer_en; ingredients_mentioned | consumer_required=answer_zh|null; safety_notes[]; followup_suggestions[]|optional
- Deterministic boundary: Skill maps ingredients_mentioned into cards and next_actions.; Prompt must keep the answer concise and the ingredient list grounded.
- Hard rules: Answer the asked question before listing ingredients.; If safety_notes are relevant, include them succinctly.; Do not overstate evidence.
- Missing-data policy: If evidence is weak, say so briefly and stay useful.; If no ingredients fit, return an empty list rather than guessing.
- Forbidden behaviors: No product marketing.; No unnecessary long essay.; No medical diagnosis language.
- Best prompt skeleton: Role: concise ingredient educator.; Task: answer the user question and optionally attach ingredient mentions.; Output contract: answer + safety notes + ingredients_mentioned.; Hard rules: directness, caution, no marketing.
- Locale policy: English prompt body; answer_zh only when locale is zh-CN.
- Example policy: Use micro examples only.
- Eval assets: tests/aurora_chat_v2_routes.node.test.cjs

#### v2.intent_classifier

- Priority: P1
- Runtime surface: Aurora Chat v2
- Call mode: structured_llm
- Entrypoint: skill_router._classifyIntent
- Consumer: SkillRouter
- Prompt source: src/auroraBff/services/llm_gateway.js::intent_classifier
- Current version/variant: 1.1.0
- Dormant variants: none
- Provider path: LlmGateway.call -> Gemini structured JSON
- Archetype: classifier
- Goal: Classify a skincare message into the right Aurora skill intent and extract lightweight entities for routing.
- Output contract: schema=IntentClassifierOutput | schema_required=intent; confidence; entities | consumer_required=entities.ingredients[]; entities.products[]; entities.concerns[]; entities.user_question
- Deterministic boundary: Router owns confidence threshold, intent-to-skill mapping, and fallback to freeform.; Prompt only classifies and extracts entities.
- Hard rules: Return only supported intent labels.; Low-confidence routine advice or general chat should stay general_chat / routine_advice.; Entity extraction must be conservative.
- Missing-data policy: If uncertain, lower confidence instead of guessing a strong intent.; Use empty arrays / null entities rather than fabricating them.
- Forbidden behaviors: No direct policy decisions.; No invented product names or ingredients.; No overconfident routing.
- Best prompt skeleton: Role: route classifier.; Task: map user message to intent + confidence + entities.; Output contract: strict intent JSON.; Hard rules: conservative confidence and entity extraction.
- Locale policy: English prompt body; intent labels and entity keys remain canonical English.
- Example policy: Use 1-2 tricky routing counterexamples.
- Eval assets: tests/aurora_chat_v2_routes.node.test.cjs

#### v2.dupe_suggest

- Priority: P2
- Runtime surface: Aurora Chat v2
- Call mode: structured_llm
- Entrypoint: dupe.suggest
- Consumer: DupeSuggestSkill
- Prompt source: src/auroraBff/services/llm_gateway.js::dupe_suggest
- Current version/variant: 1.1.0
- Dormant variants: none
- Provider path: LlmGateway.call -> Gemini structured JSON
- Archetype: structured analyzer / planner
- Goal: Suggest plausible dupes from a provided candidate pool without fabricating similarity claims.
- Output contract: schema=DupeSuggestOutput | schema_required=anchor_summary; candidates | consumer_required=tradeoffs; empty_state-safe behavior
- Deterministic boundary: Preconditions and quality gates own empty-state behavior.; Prompt should compare only the supplied candidates.
- Hard rules: Never invent candidates.; If candidate pool is empty, return an explainable empty result.; Tradeoffs must be evidence-like, not hype.
- Missing-data policy: Prefer fewer candidates when signal is weak.; Keep anchor summary short and concrete.
- Forbidden behaviors: No fabricated equivalence claims.; No shopping hype.; No hidden candidate invention.
- Best prompt skeleton: Role: dupe selector.; Task: rank supplied candidates against an anchor.; Output contract: anchor_summary + candidates[].; Hard rules: candidate-only grounding and empty-state safety.
- Locale policy: English prompt body; localized text only when supported by the schema.
- Example policy: Prefer one compact ranking example.
- Eval assets: tests/skills/test_skill_contract.js::gf_dupe_suggest_no_candidates

#### v2.dupe_compare

- Priority: P2
- Runtime surface: Aurora Chat v2
- Call mode: structured_llm
- Entrypoint: dupe.compare
- Consumer: DupeCompareSkill
- Prompt source: src/auroraBff/services/llm_gateway.js::dupe_compare
- Current version/variant: 1.1.0
- Dormant variants: none
- Provider path: LlmGateway.call -> Gemini structured JSON
- Archetype: structured analyzer / planner
- Goal: Compare an anchor product against supplied targets fairly and concretely.
- Output contract: schema=DupeCompareOutput | schema_required=anchor_summary; comparisons | consumer_required=fair tradeoff framing; comparison-safe reasoning
- Deterministic boundary: Skill renders the compare card; prompt should only compare supplied items.
- Hard rules: Stay anchored to the provided products.; Highlight tradeoffs, not absolute winners.; Do not overstate ingredient parity.
- Missing-data policy: If evidence is thin, say which comparison fields are uncertain.; Return fewer comparison bullets rather than vague filler.
- Forbidden behaviors: No fabricated benefits.; No marketing language.; No unsupported "identical formula" claims.
- Best prompt skeleton: Role: fair comparator.; Task: compare anchor and targets.; Output contract: anchor_summary + comparisons[].; Hard rules: tradeoffs and groundedness.
- Locale policy: English prompt body; localized text only where the schema supports it.
- Example policy: One compact comparison example is enough.
- Eval assets: tests/aurora_bff_product_intel.test.js

#### v2.travel_apply_mode

- Priority: P0
- Runtime surface: Aurora Chat v2
- Call mode: structured_llm
- Entrypoint: travel.apply_mode
- Consumer: TravelApplyModeSkill
- Prompt source: src/auroraBff/services/llm_gateway.js::travel_apply_mode
- Current version/variant: 1.1.0
- Dormant variants: none
- Provider path: LlmGateway.call -> Gemini structured JSON
- Archetype: structured analyzer / planner
- Goal: Translate travel conditions into a safe travel-mode adjustment object with strong UV and irritation safeguards.
- Output contract: schema=TravelModeOutput | schema_required=uv_level; humidity | consumer_required=reduce_irritation; packing_list[]; inferred_climate|null
- Deterministic boundary: Skill deterministically adds reduce_actives when high UV overlaps with strong actives or sensitivity.; Prompt should still set reduce_irritation correctly when evidence is clear.
- Hard rules: High UV must trigger SPF-minded guidance.; Strong actives or sensitivity flags should set reduce_irritation=true.; Packing list should stay practical.
- Missing-data policy: If destination certainty is low, use the archetype conservatively.; If humidity is unclear, default to medium instead of guessing extreme values.
- Forbidden behaviors: No weather hallucination.; No aggressive treatment escalation during travel.; No omission of reduce_irritation.
- Best prompt skeleton: Role: travel routine planner.; Task: infer travel conditions and adjustments.; Output contract: uv_level, humidity, reduce_irritation, packing_list, inferred_climate.; Hard rules: high UV, active reduction, practical packing.
- Locale policy: English prompt body; packing reasons can include localized text only when schema allows.
- Example policy: One compact travel JSON example is enough.
- Eval assets: tests/skills/test_skill_contract.js::gf_travel_high_uv; tests/aurora_chat_v2_skill_guards.node.test.cjs; tests/aurora_chat_v2_prompt_contract.node.test.cjs

#### v2.chat.freeform

- Priority: P1
- Runtime surface: Aurora Chat v2
- Call mode: freeform_chat
- Entrypoint: skill_router._handleFreeFormChat
- Consumer: SkillRouter
- Prompt source: src/auroraBff/services/llm_gateway.js::buildFreeformChatSystemPrompt + chat()
- Current version/variant: inline_system_prompt_v2
- Dormant variants: none
- Provider path: LlmGateway.chat -> Gemini chat -> SSE chunk/result adapter
- Archetype: conversational answerer
- Goal: Answer unresolved skincare chat questions helpfully and safely while remaining compatible with SSE chunk/result behavior.
- Output contract: schema=none | schema_required=none | consumer_required=text answer; optional ingredients_mentioned[]; optional safety_notes[]; optional followup_suggestions[]
- Deterministic boundary: Router owns SSE event ordering and next_action mapping.; Prompt owns final answer quality and optional lightweight structure.
- Hard rules: Answer directly before suggesting follow-ups.; Respect safety wording.; If ingredient mentions are included, keep them grounded and sparse.
- Missing-data policy: State uncertainty plainly when needed.; If structured extras are not needed, omit them instead of padding.
- Forbidden behaviors: No over-medicalized claims.; No fake confidence.; No mismatch between streamed chunks and final answer intent.
- Best prompt skeleton: Role: evidence-aware skincare advisor.; Task: answer the user directly and optionally attach lightweight structured hints.; Hard rules: safety, caution, SSE-consistent tone.
- Locale policy: English system prompt body; final answer language follows locale.
- Example policy: No long few-shot examples; preserve flexible conversation tone.
- Eval assets: tests/aurora_chat_v2_routes.node.test.cjs

### legacy diagnosis / gating

#### legacy.diagnosis_gate.prompt

- Priority: P2
- Runtime surface: legacy Node chat routes
- Call mode: deterministic_gate_prompt
- Entrypoint: buildDiagnosisPrompt
- Consumer: legacy /v1/chat diagnosis gate
- Prompt source: src/auroraBff/gating.js::buildDiagnosisPrompt
- Current version/variant: diagnosis_gate_prompt_v2
- Dormant variants: none
- Provider path: none (deterministic gate prompt)
- Archetype: conversational answerer
- Goal: Collect the next missing profile field with minimum friction before unlocking recommendation flows.
- Output contract: schema=none | schema_required=none | consumer_required=single gate prompt string; compatible with diagnosis chips
- Deterministic boundary: All routing, missing-field ordering, and chips stay deterministic.; This node is tracked because its wording affects gate completion quality.
- Hard rules: Ask only the current missing field.; Keep the gate brief.; Do not ask product or medical questions.
- Missing-data policy: If current field metadata is missing, fall back to the generic prefix.
- Forbidden behaviors: No long explanation.; No guilt language.; No unlocking recommendations prematurely.
- Best prompt skeleton: Role: concise gate prompt.; Task: ask for one missing profile field only.; Hard rules: brief, non-judgmental, deterministic.
- Locale policy: Prompt copy localizes fully by request language.
- Example policy: No examples needed; this is deterministic copy.
- Eval assets: tests/aurora_legacy_gate_prompt_contract.node.test.cjs; tests/aurora_bff.node.test.cjs; tests/aurora_bff_chat_v2_policy.node.test.cjs

#### legacy.fit_check.anchor_gate

- Priority: P2
- Runtime surface: legacy Node fit-check routes
- Call mode: deterministic_gate_prompt
- Entrypoint: buildFitCheckAnchorPrompt
- Consumer: legacy fit-check anchor collection
- Prompt source: src/auroraBff/routes.js::buildFitCheckAnchorPrompt
- Current version/variant: fit_check_anchor_gate_v2
- Dormant variants: none
- Provider path: none (deterministic gate prompt)
- Archetype: conversational answerer
- Goal: Request a concrete product anchor before product-fit analysis without confusing the user about what qualifies as an anchor.
- Output contract: schema=none | schema_required=none | consumer_required=anchor request text; chips for name/link/INCI
- Deterministic boundary: Parsing and anchor validation stay deterministic.; This node only supplies wording and chips.
- Hard rules: Ask for link, full name, or INCI only.; Do not begin analysis before an anchor exists.; Stay actionable.
- Missing-data policy: If the route lacks anchor data, use the generic anchor request prompt.
- Forbidden behaviors: No pseudo-analysis.; No vague "tell me more" copy.; No brand guessing.
- Best prompt skeleton: Role: anchor collection gate.; Task: request one of link/name/INCI.; Hard rules: brief, concrete, non-analytical.
- Locale policy: Fully localized deterministic copy.
- Example policy: No examples needed.
- Eval assets: tests/aurora_legacy_gate_prompt_contract.node.test.cjs; tests/aurora_bff.node.test.cjs; tests/cases_shopping_focus.jsonl

### legacy skin analysis

#### legacy.skin.vision_mainline

- Priority: P1
- Runtime surface: /v1/analysis/skin mainline
- Call mode: multimodal_llm
- Entrypoint: buildSkinVisionPromptBundle -> runGeminiVisionStrategy
- Consumer: skinLlmGateway vision layer
- Prompt source: src/auroraBff/skinLlmPrompts.js::buildSkinVisionPromptBundle
- Current version/variant: skin_report_v2_hardened
- Dormant variants: skin_vision_v3_canonical
- Provider path: skinLlmGateway.runGeminiVisionStrategy -> Gemini multimodal JSON
- Archetype: multimodal extractor / report synthesizer
- Goal: Extract only grounded visible skin cues from photos and explicitly distinguish sufficient, limited, and insufficient evidence.
- Output contract: schema=SkinVisionCanonicalSchema or legacy observation JSON | schema_required=visibility status / observations; quality-aware insufficiency signaling | consumer_required=grounded cue extraction only; quality_note / limits behavior
- Deterministic boundary: Photo quality classification and semantic validation stay deterministic.; Prompt owns grounded cue extraction only.
- Hard rules: No product advice.; No medical diagnosis.; If evidence is insufficient, say so structurally and keep observations empty/minimal.
- Missing-data policy: Low-quality photos should trigger insufficient/limited outputs, not guessed cues.; Use canonical enums only.
- Forbidden behaviors: No routines.; No brands.; No disease labels.
- Best prompt skeleton: Role: cosmetic skin cue extractor.; Task: extract grounded cues from the face photo only.; Output contract: canonical observation JSON.; Hard rules: insufficiency rubric and no advice.
- Locale policy: English-first canonical outputs; localization happens later in rendering.
- Example policy: Use tiny canonical examples for sufficient vs insufficient cases.
- Eval assets: tests/aurora_bff_skin_prompt_v3.node.test.cjs; tests/aurora_bff_vision_policy.node.test.cjs; tests/aurora_bff_photo_full_chain_e2e.node.test.cjs; tests/aurora_legacy_skin_prompt_contract.node.test.cjs

#### legacy.skin.report_mainline

- Priority: P0
- Runtime surface: /v1/analysis/skin mainline
- Call mode: structured_llm
- Entrypoint: buildSkinReportPromptBundle -> runGeminiReportStrategy
- Consumer: skinLlmGateway report layer
- Prompt source: src/auroraBff/skinLlmPrompts.js::buildSkinReportPromptBundle
- Current version/variant: skin_vision_v2_hardened
- Dormant variants: skin_report_v3_canonical
- Provider path: skinLlmGateway.runGeminiReportStrategy -> Gemini structured JSON
- Archetype: multimodal extractor / report synthesizer
- Goal: Transform deterministic signals and optional visual cues into a conservative, structured cosmetic skincare plan.
- Output contract: schema=SkinReportCanonicalSchema or legacy report strategy JSON | schema_required=strategy; primary_question; routine_expert; guidance_brief | consumer_required=findings[]; two_week_focus[]; next_step_options[]
- Deterministic boundary: Routes and validators normalize findings, confidence, and rendering.; Prompt owns plan synthesis, not product recommendation.
- Hard rules: No brands or specific products.; Routine steps must reference observed cues/signals.; Use non-medical guidance only.
- Missing-data policy: If cues are weak, keep strategy conservative and explicit about limited grounding.; If routine context is missing, do not invent a detailed routine history.
- Forbidden behaviors: No disease diagnoses.; No repeated template filler.; No unsupported confidence escalation.
- Best prompt skeleton: Role: conservative report synthesizer.; Task: turn signals into a structured plan.; Output contract: strategy JSON with findings and routine_expert.; Hard rules: cue-linked routine steps and no product recs.
- Locale policy: English-first canonical output even when downstream renderer localizes later.
- Example policy: Use compact schema-first examples only.
- Eval assets: tests/aurora_bff_skin_prompt_v3.node.test.cjs; tests/aurora_bff_vision_policy.node.test.cjs; tests/aurora_bff_photo_full_chain_e2e.node.test.cjs; tests/aurora_legacy_skin_prompt_contract.node.test.cjs

#### legacy.skin.deepening_mainline

- Priority: P1
- Runtime surface: /v1/analysis/skin deepening
- Call mode: structured_llm
- Entrypoint: buildSkinDeepeningPromptBundle -> runGeminiDeepeningStrategy
- Consumer: skinLlmGateway deepening layer
- Prompt source: src/auroraBff/skinLlmPrompts.js::buildSkinDeepeningPromptBundle
- Current version/variant: skin_deepening_v1_hardened
- Dormant variants: skin_deepening_v2_canonical
- Provider path: skinLlmGateway.runGeminiDeepeningStrategy -> Gemini structured JSON
- Archetype: multimodal extractor / report synthesizer
- Goal: Pick the correct deepening phase and next question so the skin analysis flow advances without redundant or mistimed asks.
- Output contract: schema=SkinDeepeningCanonicalSchema or legacy deepening JSON | schema_required=phase; question_intent | consumer_required=narrative / reasoning; deepening_question; deepening_options
- Deterministic boundary: Phase planning and renderer behavior stay deterministic around the model output.; Prompt chooses phase/question content within canonical limits.
- Hard rules: Question must match the current phase.; Do not output long prose in canonical mode.; Keep next-step options renderable and specific.
- Missing-data policy: If context is weak, choose the safest earlier phase instead of over-committing.; Use empty advice arrays rather than filler narrative in canonical mode.
- Forbidden behaviors: No unrelated routine advice.; No medical diagnosis.; No phase skipping without evidence.
- Best prompt skeleton: Role: deepening flow planner.; Task: choose phase + next question intent.; Output contract: canonical deepening JSON.; Hard rules: renderable options and no phase drift.
- Locale policy: English-first canonical output; localized rendering occurs downstream.
- Example policy: Use tiny phase-selection examples only.
- Eval assets: tests/aurora_bff_skin_deepening.node.test.cjs; tests/aurora_bff_skin_prompt_v3.node.test.cjs; tests/aurora_legacy_skin_prompt_contract.node.test.cjs

### legacy product intel / fit check

#### legacy.product_intel.deep_scan

- Priority: P0
- Runtime surface: legacy fit-check + routine autoscan
- Call mode: upstream_prompt
- Entrypoint: buildProductDeepScanPrompt -> auroraChat
- Consumer: legacy product intel / fit-check routes
- Prompt source: src/auroraBff/routes.js::buildProductDeepScanPrompt(V2/V3/V4)
- Current version/variant: v3_default_hardened
- Dormant variants: v2; v3_legacy; v4; strictNarrative_retry; escalation_route
- Provider path: auroraDecisionClient.auroraChat -> upstream Aurora decision service
- Archetype: structured analyzer / planner
- Goal: Evaluate a specific product against the user profile with grounded fit, risk, and usage reasoning.
- Output contract: schema=legacy assessment/evidence/confidence/missing_info JSON | schema_required=assessment; evidence; confidence; missing_info | consumer_required=assessment.summary; formula_intent; how_to_use; reasons; watchouts
- Deterministic boundary: Normalizer, gap contract, narrative retry, and escalation selection stay deterministic.; Prompt owns the structured assessment and evidence pack.
- Hard rules: Do not guess a brand when the anchor is unresolved.; SPF / retinoid / fragrance verification rules must stay conservative.; Assessment fields must be non-repetitive and product-level.
- Missing-data policy: If INCI verification is weak, downgrade verdict level and flag verification needs.; If anchor is unresolved, stay category-level rather than brand-specific.
- Forbidden behaviors: No brand hallucination.; No profile-echo filler in formula_intent.; No fabricated sources or clinical certainty.
- Best prompt skeleton: Role: objective product analyst.; Task: deep-scan a product for suitability.; Output contract: assessment/evidence/confidence JSON.; Hard rules: non-repetition, no brand guessing, conservative verification.
- Locale policy: English prompt body; upstream can localize later if needed.
- Example policy: One structure-only JSON example plus a no-anchor negative example.
- Eval assets: tests/aurora_bff_product_intel.test.js; tests/aurora_product_analysis_v4.test.js; tests/aurora_legacy_product_intel_prompt_contract.node.test.cjs; tests/cases_shopping_focus.jsonl

### legacy reco selection

#### legacy.reco.main_selector

- Priority: P0
- Runtime surface: legacy recommendation flow
- Call mode: upstream_prompt
- Entrypoint: buildAuroraProductRecommendationsQuery
- Consumer: legacy reco main route
- Prompt source: src/auroraBff/routes.js::reco_main_v1_0 system + user payload
- Current version/variant: reco_main_v1_0_hardened
- Dormant variants: product_relevance_dual_qa_off_default
- Provider path: auroraDecisionClient.auroraChat -> upstream Aurora decision service
- Archetype: strict selector / ranker
- Goal: Rank skincare candidates into grounded product picks without inventing SKU facts or exceeding candidate constraints.
- Output contract: schema=reco_main_v1_0 output_schema | schema_required=recommendations; confidence; missing_info; warnings | consumer_required=sku grounding copied from candidates; reasons[]; evidence_pack
- Deterministic boundary: Guardrails, prompt contract verification, and catalog sanitation remain deterministic.; Prompt only ranks and justifies candidates.
- Hard rules: Select only from candidates when provided.; Never invent SKU IDs or URLs.; If fewer than 5 safe items exist, return fewer.
- Missing-data policy: Use warnings for missing profile fields.; Return empty or short recommendation lists instead of guessy filler.
- Forbidden behaviors: No checkout links.; No clarifying questions.; No generic routine dump.
- Best prompt skeleton: Role: skincare ranking engine.; Task: rank supplied candidates into product picks.; Output contract: recommendation list JSON.; Hard rules: candidate-only grounding and concise reasons.
- Locale policy: English prompt body; meta.lang in the payload controls downstream language.
- Example policy: Prefer schema and one candidate-grounding counterexample.
- Eval assets: tests/aurora_bff.node.test.cjs; tests/aurora_bff_reco_catalog.node.test.cjs; tests/aurora_legacy_reco_prompt_contract.node.test.cjs; scripts/aurora_reco_prod_manual_suite.cjs

#### legacy.reco.alternatives_selector

- Priority: P1
- Runtime surface: legacy alternatives / dupe selection
- Call mode: upstream_prompt
- Entrypoint: buildAuroraRecoAlternativesQuery
- Consumer: legacy reco alternatives flow
- Prompt source: src/auroraBff/routes.js::reco_alternatives_v1_0 system + payload
- Current version/variant: reco_alternatives_v1_0_hardened
- Dormant variants: none
- Provider path: auroraDecisionClient.auroraChat -> upstream Aurora decision service
- Archetype: strict selector / ranker
- Goal: Pick a small set of grounded alternatives for an anchor product from a supplied candidate list.
- Output contract: schema=alternatives selector JSON | schema_required=alternatives / recommendations | consumer_required=candidate ids copied from provided candidates; short reasons
- Deterministic boundary: Candidate normalization and quality gates stay deterministic.; Prompt only selects from normalized candidates.
- Hard rules: Select only from context.candidates.; Keep reasons short.; Do not invent product details.
- Missing-data policy: If no alternatives are good enough, return fewer items.; Do not pad with weak matches.
- Forbidden behaviors: No fake dupes.; No new URLs.; No verbose marketing copy.
- Best prompt skeleton: Role: strict alternatives selector.; Task: choose up to N alternatives from candidates.; Output contract: alternative list JSON.; Hard rules: groundedness and brevity.
- Locale policy: English prompt body; localized display is a downstream concern.
- Example policy: Schema-only examples are sufficient.
- Eval assets: tests/dupe_suggest_p0_regression.test.js; tests/aurora_bff_reco_catalog.node.test.cjs; tests/aurora_legacy_reco_prompt_contract.node.test.cjs

#### legacy.reco.product_lookup_fallback

- Priority: P1
- Runtime surface: legacy purchasable fallback
- Call mode: structured_llm
- Entrypoint: buildProductLookupLlmFallbackPrompt -> callGeminiJsonObject
- Consumer: recoverProductsWithLlmFallbackFromQueries
- Prompt source: src/auroraBff/routes.js::buildProductLookupLlmFallbackPrompt
- Current version/variant: inline_selector_v2
- Dormant variants: none
- Provider path: callGeminiJsonObject -> Gemini structured JSON
- Archetype: strict selector / ranker
- Goal: Recover purchasable skincare products from an allowed candidate set when catalog search is empty or degraded.
- Output contract: schema=products[] selector JSON | schema_required=products[] | consumer_required=name; brand; category; pdp_url; why
- Deterministic boundary: URL allowlists, strict candidate filtering, and fallback reason codes remain deterministic.; Prompt only selects allowed products.
- Hard rules: Use only context.product_candidates.; Return direct PDP URLs only.; Skincare only.
- Missing-data policy: If no valid candidate fits, return empty products[] rather than reaching outside context.
- Forbidden behaviors: No search URLs.; No invented products.; No non-skincare items.
- Best prompt skeleton: Role: strict fallback product selector.; Task: select purchasable skincare products from candidate context.; Output contract: products[].; Hard rules: candidate-only URLs and skincare filter.
- Locale policy: English prompt body only.
- Example policy: One negative example for search URLs is useful.
- Eval assets: tests/aurora_bff_purchasable_fallback_chain.node.test.cjs; tests/aurora_legacy_purchasable_fallback_prompt_contract.node.test.cjs

#### legacy.ingredient.reco_upstream

- Priority: P2
- Runtime surface: legacy ingredient-constrained recommendations
- Call mode: upstream_prompt
- Entrypoint: buildIngredientRecoUpstreamPrompt
- Consumer: legacy ingredient recommendation upstream call
- Prompt source: src/auroraBff/routes.js::buildIngredientRecoUpstreamPrompt
- Current version/variant: inline_ingredient_reco_v2
- Dormant variants: none
- Provider path: auroraDecisionClient.auroraChat -> upstream Aurora decision service
- Archetype: strict selector / ranker
- Goal: Force upstream recommendation generation to respect ingredient constraints instead of falling back to generic skincare picks.
- Output contract: schema=upstream product recommendation answer | schema_required=none | consumer_required=ingredient-constrained picks or an explainable empty result
- Deterministic boundary: Candidate filters and entry-source routing are deterministic.; Prompt only states the hard ingredient constraints.
- Hard rules: Select only from product candidates when supplied.; If no constrained match exists, explain and return empty.; Tie every pick to the ingredient goal.
- Missing-data policy: If goal or candidates are weak, prefer an empty result over generic recs.
- Forbidden behaviors: No generic recommendations.; No inventing product candidates.; No ignoring ingredient context.
- Best prompt skeleton: Role: ingredient-constrained selector.; Task: generate recommendations under hard ingredient constraints.; Hard rules: no generic recs and explainable empty state.
- Locale policy: Prompt localizes by route language when needed.
- Example policy: One negative example for empty constrained results is enough.
- Eval assets: tests/aurora_bff_ingredient_report_individualization.node.test.cjs; tests/aurora_bff_reco_catalog.node.test.cjs; tests/aurora_legacy_reco_prompt_contract.node.test.cjs

### legacy ingredient research

#### legacy.ingredient.lookup_upstream

- Priority: P2
- Runtime surface: legacy ingredient lookup route
- Call mode: upstream_prompt
- Entrypoint: buildIngredientLookupUpstreamPrompt
- Consumer: legacy ingredient lookup upstream call
- Prompt source: src/auroraBff/routes.js::buildIngredientLookupUpstreamPrompt
- Current version/variant: inline_lookup_v2
- Dormant variants: none
- Provider path: auroraDecisionClient.auroraChat -> upstream Aurora decision service
- Archetype: conversational answerer
- Goal: Ask the upstream model for a compact ingredient lookup answer when the user wants a quick explanation.
- Output contract: schema=upstream free-form answer | schema_required=none | consumer_required=1-minute ingredient report qualities: benefits, evidence, watchouts, risk by profile
- Deterministic boundary: Routing and follow-up cards stay deterministic.; Prompt only shapes the upstream answer request.
- Hard rules: Keep the report compact.; Focus on benefits, evidence, watchouts, risk by profile.; No generic shopping pitch.
- Missing-data policy: If the ingredient is ambiguous, keep the report generic and brief.
- Forbidden behaviors: No product list dumping.; No medical diagnosis.; No long essay.
- Best prompt skeleton: Role: compact ingredient explainer.; Task: request a 1-minute ingredient report.; Hard rules: benefits, evidence, watchouts, risk by profile.
- Locale policy: Prompt is English or Chinese depending on route language.
- Example policy: No examples needed.
- Eval assets: tests/aurora_bff_ingredient_report_individualization.node.test.cjs; tests/aurora_legacy_ingredient_research_prompt_contract.node.test.cjs

#### legacy.ingredient.research_sync

- Priority: P0
- Runtime surface: legacy ingredient sync research
- Call mode: structured_llm
- Entrypoint: buildIngredientResearchPrompts -> callGeminiJsonObject
- Consumer: runIngredientResearchSync
- Prompt source: src/auroraBff/routes.js::buildIngredientResearchPrompts
- Current version/variant: ingredient_research_v2_lite_hardened
- Dormant variants: none
- Provider path: callGeminiJsonObject -> Gemini structured JSON
- Archetype: structured analyzer / planner
- Goal: Produce a compact, evidence-bounded ingredient research packet that can be sanitized into the legacy ingredient research card.
- Output contract: schema=ingredient_research_v2_lite JSON | schema_required=ingredient; overview; benefits; safety; usage; confidence; evidence | consumer_required=citations limited to context.sources; top_products optional buckets
- Deterministic boundary: Sanitizer enforces citation allowlists, unknown handling, and fallback watchouts.; Prompt should still return near-schema-complete JSON.
- Hard rules: Only cite context.sources.; Use null/[] instead of "unknown".; Stay brief and non-medical.
- Missing-data policy: If no sources exist, citations must be [].; If evidence is weak, set low confidence and limited claims.
- Forbidden behaviors: No hallucinated citations.; No diagnosis or treatment instructions.; No bloated prose.
- Best prompt skeleton: Role: ingredient research analyst.; Task: analyze only the named ingredient.; Output contract: v2-lite research JSON.; Hard rules: citation allowlist and concise fields.
- Locale policy: English prompt body; language is passed in context and should control output strings.
- Example policy: Use schema-only examples and a fail-safe short-circuit rule.
- Eval assets: tests/aurora_bff.node.test.cjs; tests/aurora_bff_ingredient_kb_v2.node.test.cjs; tests/aurora_bff_ingredient_report_individualization.node.test.cjs; tests/aurora_legacy_ingredient_research_prompt_contract.node.test.cjs

### legacy analysis story generation / review

#### legacy.analysis_story.generate

- Priority: P0
- Runtime surface: analysis_story_v2
- Call mode: structured_llm
- Entrypoint: buildAnalysisStoryGenerationPrompt -> callDualQaProvider
- Consumer: generateAnalysisStoryV2JsonWithLlm
- Prompt source: src/auroraBff/routes.js::buildAnalysisStoryGenerationPrompt
- Current version/variant: aurora.analysis_story.v2.generate_v2
- Dormant variants: none
- Provider path: callDualQaProvider -> Gemini single by default; OpenAI optional fallback in QA mode
- Archetype: structured analyzer / planner
- Goal: Generate a readable, evidence-bounded skincare story card that turns analysis evidence into prioritized actions.
- Output contract: schema=aurora.analysis_story.v2 | schema_required=schema_version; confidence_overall; priority_findings; am_plan; pm_plan; ui_card_v1; disclaimer_non_medical | consumer_required=routine_bridge when routine missing; profile-aware AM/PM plan; timeline; safety_notes
- Deterministic boundary: Local deterministic generation and review still exist as fallback.; Prompt must stay within provided evidence and schema.
- Hard rules: Conclusion first, evidence second, actions third.; AM/PM plan must be profile-aware.; Include routine_bridge when routine is missing.
- Missing-data policy: If evidence is sparse, use lower confidence and explicit routine bridge.; Do not pad with generic placeholder routines.
- Forbidden behaviors: No medical diagnosis.; No brand-specific recs.; No fixed-template AM/PM plan for every user.
- Best prompt skeleton: Role: skincare story generator.; Task: turn evidence into aurora.analysis_story.v2 JSON.; Output contract: schema-complete analysis story.; Hard rules: profile-aware plan and non-medical disclaimer.
- Locale policy: English prompt body; downstream may localize card display later.
- Example policy: Use structure-only schema reference, never copyable content examples.
- Eval assets: tests/aurora_bff_analysis_story_v2.node.test.cjs; tests/aurora_legacy_analysis_story_prompt_contract.node.test.cjs; scripts/smoke_aurora_bff_runtime.sh

#### legacy.analysis_story.review

- Priority: P1
- Runtime surface: analysis_story_v2
- Call mode: structured_llm
- Entrypoint: buildAnalysisStoryReviewPrompt -> callDualQaProvider
- Consumer: reviewAnalysisStoryV2JsonWithLlm
- Prompt source: src/auroraBff/routes.js::buildAnalysisStoryReviewPrompt
- Current version/variant: aurora.analysis_story.v2.review_v2
- Dormant variants: none
- Provider path: callDualQaProvider -> Gemini/OpenAI QA reviewer
- Archetype: reviewer / patcher
- Goal: Review and patch an analysis story so it stays factually consistent, safe, and schema-valid.
- Output contract: schema=review JSON with approved, issues, patched_story | schema_required=approved; issues; patched_story | consumer_required=patched_story stays inside evidence boundaries
- Deterministic boundary: Local reviewAnalysisStoryV2Json revalidates the patched story.; Prompt reviewer must not introduce new evidence.
- Hard rules: patched_story must stay within evidence.; Keep disclaimer and routine_bridge rules intact.; Return strict JSON only.
- Missing-data policy: If a safe patch is not possible, reject with issues instead of inventing content.
- Forbidden behaviors: No new evidence.; No extra keys.; No stylistic rewrites that change meaning.
- Best prompt skeleton: Role: strict JSON reviewer.; Task: approve or patch a story against evidence.; Output contract: approved/issues/patched_story.; Hard rules: no new evidence and schema safety.
- Locale policy: English prompt body; review output stays canonical JSON.
- Example policy: Structure-only examples only.
- Eval assets: tests/aurora_bff_analysis_story_v2.node.test.cjs; tests/aurora_legacy_analysis_story_prompt_contract.node.test.cjs

## Rewrite Policy

- Do not rewrite multiple P0 nodes in one change.
- For v2 nodes, update runtime prompt text, manifest version, and prompt contract tests together.
- For legacy nodes, add or preserve stable prompt tracing before changing prompt behavior.
- Use English prompt bodies with locale-controlled outputs; do not introduce full bilingual prompt bodies by default.
