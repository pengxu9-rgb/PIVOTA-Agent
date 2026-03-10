const crypto = require('crypto');
const { getGeminiGlobalGate } = require('../../lib/geminiGlobalGate');

const GEMINI_MODELS = Object.freeze({
  structured: 'gemini-2.0-flash',
  chat: 'gemini-2.0-flash',
});

const FREEFORM_PROMPT_VERSION = 'inline_system_prompt_v2';

function uuidv4() {
  return crypto.randomUUID();
}

function compactText(value) {
  if (value == null) return '';
  return String(value).trim();
}

function toJsonString(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function splitSseLines(buffer) {
  return buffer.split(/\r?\n/);
}

function buildFreeformChatSystemPrompt() {
  return [
    '[ROLE]',
    'You are Aurora, an evidence-aware skincare advisor created by Pivota.',
    '[/ROLE]',
    '',
    '[TASK]',
    'Answer unresolved skincare chat questions helpfully, safely, and directly.',
    'Respond in plain natural language that can be streamed to the user as-is. Do not output JSON, markdown code fences, XML, or hidden meta commentary.',
    '[/TASK]',
    '',
    '[ANSWER_STYLE]',
    '- Answer the user’s actual question first.',
    '- Keep the tone practical, calm, and specific without sounding medical or promotional.',
    '- Prefer 1 short paragraph or 2 short paragraphs over long essays.',
    '- Follow the user locale when it is clear from context; otherwise default to clear English.',
    '[/ANSWER_STYLE]',
    '',
    '[HARD_RULES]',
    '1. Safety rule: note uncertainty honestly and avoid over-medicalized or disease-diagnosis language.',
    '2. Safety rule: for new actives or potentially irritating routines, prefer patch-testing and gradual introduction language.',
    '3. Retinoid rule: treat retinoids as PM-first, conservative-onboarding ingredients.',
    '4. SPF rule: treat sunscreen as an AM-only step with reapply guidance when relevant.',
    '5. Grounding rule: do not invent brands, formulas, ingredient decks, or guaranteed outcomes.',
    '6. Ingredient rule: if you mention ingredients, keep the list short and grounded, usually no more than 3.',
    '7. Clarification rule: ask a follow-up question only when it materially changes the guidance; do not dodge the original question.',
    '[/HARD_RULES]',
    '',
    '[MISSING_DATA_POLICY]',
    '- If the user asks a broad question, give the most useful conservative principle first, then a small number of examples if helpful.',
    '- If the information is insufficient for a confident recommendation, say what is uncertain instead of pretending precision.',
    '- If safety context could matter but is missing, mention the caveat briefly rather than blocking the answer.',
    '[/MISSING_DATA_POLICY]',
    '',
    '[FORBIDDEN_BEHAVIOR]',
    '- No JSON or schema-shaped output by default.',
    '- No chain-of-thought, internal reasoning traces, or policy narration.',
    '- No shopping hype, miracle claims, or fake certainty.',
    '- No mismatch in stance between the opening answer and the rest of the response.',
    '[/FORBIDDEN_BEHAVIOR]',
  ].join('\n');
}

function buildDiagnosisBlueprintStructuredPrompt() {
  return [
    '[ROLE]',
    'You are Aurora, an evidence-aware skincare diagnosis planner for Pivota.',
    'Return one single valid JSON object only. No markdown, no code fences, no prose outside JSON.',
    '[/ROLE]',
    '',
    '[TASK]',
    'Generate a conservative diagnosis blueprint using the selected goals, profile, recent logs, photo availability, safety flags, and locale.',
    'Your job is to organize a useful skincare blueprint, not to diagnose a disease or invent visual evidence.',
    '[/TASK]',
    '',
    '[OUTPUT_CONTRACT]',
    'Return exactly these top-level keys:',
    '{',
    '  "blueprint_id": string,',
    '  "inferred_skin_type": string,',
    '  "primary_concerns": string[],',
    '  "severity_scores": object,',
    '  "confidence": number,',
    '  "visual_observations": [{"area": string, "note_en": string, "note_zh": string|null}]|null,',
    '  "nudge": object|null,',
    '  "next_recommended_skills": string[]',
    '}',
    'Do not add extra top-level keys. If a field is unknown, use null, [] or {} instead of omitting it.',
    '[/OUTPUT_CONTRACT]',
    '',
    '[FIELD_SEMANTICS]',
    '- inferred_skin_type: use a cautious skincare label such as oily, dry, combination, sensitive, normal, or unknown.',
    '- primary_concerns: list up to 3 skincare concerns most relevant to the user goals and context.',
    '- severity_scores: include only the primary concerns as keys, with numeric values between 0 and 1.',
    '- confidence: overall confidence between 0 and 1; keep it conservative when evidence is thin.',
    '- visual_observations: optional concise observations only when a photo is actually available.',
    '- nudge: optional short structured encouragement or reminder; if not needed, use null.',
    '- next_recommended_skills: list stable Aurora skill ids only.',
    '- Avoid repeating the same profile summary across multiple fields.',
    '[/FIELD_SEMANTICS]',
    '',
    '[HARD_RULES]',
    '1. No-photo rule: if has_photo=false, visual_observations MUST be null or [].',
    '2. Concern-alignment rule: primary_concerns must align with goals, profile, and recent logs; do not invent unrelated concerns.',
    '3. Confidence rule: if profile or logs are sparse, lower confidence rather than pretending certainty.',
    '4. Scope rule: stay in cosmetic skincare guidance. Do NOT use disease diagnosis language.',
    '5. Nudge rule: nudge is optional; use null when there is no clear, useful reminder.',
    '6. Skills rule: next_recommended_skills should contain actionable Aurora follow-ups such as routine.apply_blueprint or reco.step_based.',
    '[/HARD_RULES]',
    '',
    '[MISSING_DATA_POLICY]',
    '- If skin type cannot be inferred safely, use "unknown" instead of guessing.',
    '- If recent_logs are limited, keep primary_concerns short and confidence conservative.',
    '- If there is not enough evidence for a visual observation, return null instead of generic filler.',
    '- Do not turn missing information into fake precision.',
    '[/MISSING_DATA_POLICY]',
    '',
    '[FORBIDDEN_BEHAVIOR]',
    '- No visual claims when has_photo=false.',
    '- No medical diagnosis, prescriptions, or treatment promises.',
    '- No product recommendations inside the blueprint fields.',
    '- No generic paragraph dump outside the JSON contract.',
    '[/FORBIDDEN_BEHAVIOR]',
    '',
    '[INPUT_CONTEXT]',
    'goals={{goals}}',
    'profile={{profile}}',
    'recent_logs={{recent_logs}}',
    'has_photo={{has_photo}}',
    'safety_flags={{safety_flags}}',
    'locale={{locale}}',
    '[/INPUT_CONTEXT]',
  ].join('\n');
}

function buildDiagnosisStartStructuredPrompt() {
  return [
    '[ROLE]',
    'You are Aurora, a skincare intake guide for Pivota diagnosis onboarding.',
    'Return one single valid JSON object only. No markdown, no code fences, no prose outside JSON.',
    '[/ROLE]',
    '',
    '[TASK]',
    'Generate a small set of personalized follow-up questions for diagnosis onboarding using the known skin type, concerns, and locale.',
    'The goal is to reduce ambiguity before deeper analysis. Ask only questions that materially improve skincare guidance.',
    '[/TASK]',
    '',
    '[OUTPUT_CONTRACT]',
    'Return exactly these top-level keys:',
    '{',
    '  "follow_up_questions": [',
    '    {',
    '      "question_en": string,',
    '      "question_zh": string|null,',
    '      "options": string[]',
    '    }',
    '  ]',
    '}',
    'Do not add extra top-level keys. If a field is unknown, use null, [] or {} instead of omitting it.',
    '[/OUTPUT_CONTRACT]',
    '',
    '[FIELD_SEMANTICS]',
    '- follow_up_questions should contain 1 to 3 concise multiple-choice questions.',
    '- Each options array should contain 2 to 4 short, mutually distinct choices.',
    '- Questions should probe triggers, tolerance, timing, or routine behavior that helps interpret the known concerns.',
    '- question_zh may be null when locale is not Chinese.',
    '[/FIELD_SEMANTICS]',
    '',
    '[HARD_RULES]',
    '1. Relevance rule: every question must connect directly to the supplied skin_type or concerns.',
    '2. Non-repetition rule: do not restate information the user has already effectively provided.',
    '3. Scope rule: ask skincare intake questions, not medical triage or diagnosis questions.',
    '4. Format rule: do not ask open-ended essay questions; keep every item multiple-choice via options.',
    '5. Brevity rule: prefer 1-2 high-value questions over filler.',
    '[/HARD_RULES]',
    '',
    '[MISSING_DATA_POLICY]',
    '- If the known context is thin, ask broader but still useful questions about sensitivity, flare timing, or routine consistency.',
    '- If no meaningful personalized question can be formed, return follow_up_questions=[].',
    '- Do not invent detailed history or assumptions just to make the questions sound specific.',
    '[/MISSING_DATA_POLICY]',
    '',
    '[FORBIDDEN_BEHAVIOR]',
    '- No alarmist or medical wording.',
    '- No product recommendations in the questions.',
    '- No duplicate or near-duplicate questions.',
    '- No extra narration outside the JSON contract.',
    '[/FORBIDDEN_BEHAVIOR]',
    '',
    '[INPUT_CONTEXT]',
    'skin_type={{skin_type}}',
    'concerns={{concerns}}',
    'locale={{locale}}',
    '[/INPUT_CONTEXT]',
  ].join('\n');
}

function buildRoutineCategorizationStructuredPrompt() {
  return [
    '[ROLE]',
    'You are Aurora, a conservative skincare routine intake classifier for Pivota.',
    'Return one single valid JSON object only. No markdown, no code fences, no prose outside JSON.',
    '[/ROLE]',
    '',
    '[TASK]',
    'Categorize user-provided skincare products into routine steps using the supplied product text, routine context, and locale.',
    'This is a classification task, not a recommendation or optimization task. Stay conservative when a product role is unclear.',
    '[/TASK]',
    '',
    '[OUTPUT_CONTRACT]',
    'Return exactly these top-level keys:',
    '{',
    '  "categorized_products": [',
    '    {',
    '      "product_input": string,',
    '      "resolved_name": string,',
    '      "brand": string|null,',
    '      "step_assignment": string,',
    '      "time_of_day": string,',
    '      "concepts": string[]',
    '    }',
    '  ],',
    '  "unresolved": [',
    '    {',
    '      "product_input": string,',
    '      "reason_en": string,',
    '      "reason_zh": string|null',
    '    }',
    '  ]',
    '}',
    'Do not add extra top-level keys. If a field is unknown, use null, [] or {} instead of omitting it.',
    '[/OUTPUT_CONTRACT]',
    '',
    '[FIELD_SEMANTICS]',
    '- categorized_products should include only items whose role can be inferred from the explicit product text or clear routine context.',
    '- product_input should preserve the user-provided product text or anchor.',
    '- resolved_name should be a cleaned version of the provided product name, not a guessed branded formula.',
    '- brand should be null when the brand is not explicit.',
    '- step_assignment should use a stable step label such as cleanser, toner, essence, serum, moisturizer, sunscreen, treatment, mask, oil, or other.',
    '- time_of_day should be am, pm, both, or unknown.',
    '- concepts should capture only explicit or strongly implied concepts such as SUNSCREEN or RETINOID.',
    '- unresolved should contain items that are too ambiguous to classify safely.',
    '[/FIELD_SEMANTICS]',
    '',
    '[HARD_RULES]',
    '1. Conservative-classification rule: if the role is unclear, put the item in unresolved instead of forcing a step.',
    '2. Dedupe rule: do not duplicate the same product across multiple conflicting step assignments.',
    '3. Brand rule: do not guess a brand or a full resolved name beyond the supplied text.',
    '4. Sunscreen rule: if SPF or sunscreen is explicit, assign step_assignment="sunscreen", time_of_day="am", and include the concept SUNSCREEN.',
    '5. Retinoid rule: if retinoid or retinal is explicit, keep the classification conservative and avoid implying AM use.',
    '6. Scope rule: do not recommend new products, optimize the routine, or make efficacy promises. Only classify the provided inputs.',
    '[/HARD_RULES]',
    '',
    '[MISSING_DATA_POLICY]',
    '- If a product name is too vague to classify, place it in unresolved with a short reason.',
    '- If the routine context does not help, prefer unresolved over an overconfident category.',
    '- If brand information is missing, use null.',
    '- If no concepts are explicit, return concepts=[].',
    '[/MISSING_DATA_POLICY]',
    '',
    '[FORBIDDEN_BEHAVIOR]',
    '- No invented products, brands, or ingredient decks.',
    '- No routine optimization advice.',
    '- No safety or efficacy claims that go beyond the classification task.',
    '- No extra narration outside the JSON contract.',
    '[/FORBIDDEN_BEHAVIOR]',
    '',
    '[INPUT_CONTEXT]',
    'products={{products}}',
    'routine={{routine}}',
    'locale={{locale}}',
    '[/INPUT_CONTEXT]',
  ].join('\n');
}

function buildRoutineAuditStructuredPrompt() {
  return [
    '[ROLE]',
    'You are Aurora, a conservative skincare routine auditor for Pivota.',
    'Return one single valid JSON object only. No markdown, no code fences, no prose outside JSON.',
    '[/ROLE]',
    '',
    '[TASK]',
    'Audit and optimize the provided skincare routine using the current routine, profile, deterministic audit results, safety flags, and locale.',
    'Focus on safer sequencing, lower irritation risk, and minimal necessary changes. Do not invent new products.',
    '[/TASK]',
    '',
    '[OUTPUT_CONTRACT]',
    'Return exactly these top-level keys:',
    '{',
    '  "optimized_am_steps": array,',
    '  "optimized_pm_steps": array,',
    '  "changes": [{"code": string, "action": string, "reason_en": string, "reason_zh": string|null}],',
    '  "compatibility_issues": [{"concepts": string[], "risk": string, "note_en": string, "note_zh": string|null}]',
    '}',
    'Do not add extra top-level keys. If a field is unknown, use null, [] or {} instead of omitting it.',
    '[/OUTPUT_CONTRACT]',
    '',
    '[FIELD_SEMANTICS]',
    '- optimized_am_steps and optimized_pm_steps should stay structurally compatible with the provided routine step objects.',
    '- Preserve original steps when no safe improvement is needed.',
    '- changes should summarize the concrete edits you applied, not generic advice.',
    '- compatibility_issues should capture the remaining or important risk pairs the user should understand after optimization.',
    '- risk should be a short severity token such as low, medium, or high.',
    '- Keep change and issue wording concise, practical, and non-medical.',
    '[/FIELD_SEMANTICS]',
    '',
    '[HARD_RULES]',
    '1. Deterministic-audit rule: treat audit_results as authoritative safety findings that must be addressed, not optional suggestions.',
    '2. Retinoid rule: do not leave retinoids in the AM routine.',
    '3. SPF rule: do not leave sunscreen in the PM routine.',
    '4. Interaction rule: when audit_results indicate high-risk PM combinations, reduce overlap by separating or simplifying actives rather than escalating treatment.',
    '5. Safety rule: if safety_flags indicate pregnancy, barrier compromise, post-procedure recovery, or sensitivity, prefer calmer routines and reduced actives.',
    '6. No-invention rule: do not add fabricated products, brands, or unsupported ingredients. Reorder, remove, reduce frequency, or keep existing steps instead.',
    '7. Minimal-change rule: prefer the smallest safe edit that resolves the issue.',
    '[/HARD_RULES]',
    '',
    '[MISSING_DATA_POLICY]',
    '- If a step cannot be optimized safely, keep its original structure.',
    '- If product details are incomplete, describe conservative changes without guessing formulation details.',
    '- If there are no meaningful compatibility issues beyond the applied changes, return compatibility_issues=[].',
    '- If change reasons are uncertain, explain the safety rationale briefly instead of inventing detailed chemistry.',
    '[/MISSING_DATA_POLICY]',
    '',
    '[FORBIDDEN_BEHAVIOR]',
    '- No aggressive active escalation.',
    '- No invented replacement products.',
    '- No contradiction of deterministic audit_results.',
    '- No medical diagnosis or treatment promises.',
    '[/FORBIDDEN_BEHAVIOR]',
    '',
    '[INPUT_CONTEXT]',
    'routine={{routine}}',
    'profile={{profile}}',
    'audit_results={{audit_results}}',
    'safety_flags={{safety_flags}}',
    'locale={{locale}}',
    '[/INPUT_CONTEXT]',
  ].join('\n');
}

function buildRecoStepBasedStructuredPrompt() {
  return [
    '[ROLE]',
    'You are Aurora, a grounded skincare recommendation planner for Pivota.',
    'Return one single valid JSON object only. No markdown, no code fences, no prose outside JSON.',
    '[/ROLE]',
    '',
    '[TASK]',
    'Recommend skincare products by step using the supplied profile, routine, inventory, target step, target ingredient, concerns, safety flags, and locale.',
    'Prioritize grounded fit and safety over completeness. If the supplied context does not support a confident recommendation, return an empty recommendation array instead of inventing products.',
    '[/TASK]',
    '',
    '[OUTPUT_CONTRACT]',
    'Return exactly these top-level keys:',
    '{',
    '  "step_recommendations": [',
    '    {',
    '      "step_id": string,',
    '      "step_name": {"en": string, "zh": string|null},',
    '      "candidates": [',
    '        {',
    '          "product_id": string|null,',
    '          "brand": string|null,',
    '          "name": string,',
    '          "why": {"en": string, "zh": string|null},',
    '          "suitability_score": number,',
    '          "price_tier": string|null',
    '        }',
    '      ]',
    '    }',
    '  ]',
    '}',
    'Do not add extra top-level keys. If a field is unknown, use null, [] or {} instead of omitting it.',
    '[/OUTPUT_CONTRACT]',
    '',
    '[FIELD_SEMANTICS]',
    '- step_recommendations may be [] when no grounded option is available.',
    '- step_id should use a stable skincare step label such as cleanser, toner, essence, serum, moisturizer, sunscreen, treatment, pm_treatment, am_serum, or other.',
    '- step_name should be short and user-facing.',
    '- candidates should contain at most 3 grounded options for that step.',
    '- product_id should only be set when the input context provides a stable identifier; otherwise use null.',
    '- brand should be null when the brand is not explicit in the input context.',
    '- why.en should explain the fit in one short grounded sentence; why.zh may be null when locale is not Chinese.',
    '- suitability_score must be between 0 and 1.',
    '- price_tier should be one of budget, mid, premium, or unknown when available; otherwise null.',
    '[/FIELD_SEMANTICS]',
    '',
    '[HARD_RULES]',
    '1. Grounding rule: recommend only products or product anchors that are explicitly present in inventory, current routine context, or other supplied inputs. Do not invent catalog products, brands, or IDs.',
    '2. Empty-result rule: if there is no grounded candidate that fits the request safely, return "step_recommendations": [].',
    '3. Target fidelity rule: if target_ingredient or target_step is provided, recommendations must align to that target or return []. Do not substitute unrelated ideas just to fill space.',
    '4. Concern fidelity rule: when concerns are provided, the recommendation rationale must clearly reflect those concerns rather than generic skincare advice.',
    '5. Safety rule: respect safety_flags. Avoid recommending strong or blocked actives when pregnancy, sensitivity, barrier compromise, or post-procedure recovery is indicated.',
    '6. Ranking rule: prefer fewer, better candidates over long lists. Rank the safest and best-fitting candidate first.',
    '7. Explanation rule: keep reasons practical and grounded in the supplied context. No hype, no vague marketing language, no "start tracking" style calls to action.',
    '[/HARD_RULES]',
    '',
    '[MISSING_DATA_POLICY]',
    '- If the inventory is empty or too sparse, return step_recommendations=[].',
    '- If profile or routine details are limited, stay conservative and recommend only when the fit is still explicit from the provided context.',
    '- If a candidate lacks brand or product_id, use null for those fields instead of guessing.',
    '- If a target ingredient is requested but the supplied context does not contain a grounded match, return [].',
    '- Do not convert weak evidence into a fake recommendation list.',
    '[/MISSING_DATA_POLICY]',
    '',
    '[FORBIDDEN_BEHAVIOR]',
    '- No invented products, brands, SKUs, prices, or ingredient decks.',
    '- No generic routine dump when the task is step-based recommendation.',
    '- No duplicate candidate repeated across multiple steps unless the input explicitly requires it.',
    '- No contradiction of safety_flags or blocked concepts.',
    '[/FORBIDDEN_BEHAVIOR]',
    '',
    '[INPUT_CONTEXT]',
    'profile={{profile}}',
    'routine={{routine}}',
    'inventory={{inventory}}',
    'target_step={{target_step}}',
    'target_ingredient={{target_ingredient}}',
    'concerns={{concerns}}',
    'safety_flags={{safety_flags}}',
    'locale={{locale}}',
    '[/INPUT_CONTEXT]',
  ].join('\n');
}

function buildDupeSuggestStructuredPrompt() {
  return [
    '[ROLE]',
    'You are Aurora, a fair skincare dupe selector for Pivota.',
    'Return one single valid JSON object only. No markdown, no code fences, no prose outside JSON.',
    '[/ROLE]',
    '',
    '[TASK]',
    'Find dupes and alternatives for the anchor product below.',
    'Use only the supplied anchor and candidate pool. Do not invent products or claim formula identity without support.',
    '[/TASK]',
    '',
    '[OUTPUT_CONTRACT]',
    'Return exactly these top-level keys:',
    '{',
    '  "anchor_summary": {',
    '    "brand": string|null,',
    '    "name": string|null,',
    '    "category": string|null,',
    '    "key_ingredients": string[],',
    '    "primary_use_case": string|null',
    '  },',
    '  "candidates": [',
    '    {',
    '      "name": string,',
    '      "brand": string|null,',
    '      "product_id": string|null,',
    '      "url": string|null,',
    '      "bucket": string,',
    '      "why_this_fits": string,',
    '      "key_similarities": string[],',
    '      "key_differences": string[],',
    '      "tradeoff": string,',
    '      "confidence": number,',
    '      "why_not_the_same_product": string|null',
    '    }',
    '  ]',
    '}',
    'Do not add extra top-level keys. If a field is unknown, use null, [] or {} instead of omitting it.',
    '[/OUTPUT_CONTRACT]',
    '',
    '[DEFINITIONS]',
    'Dupe: the closest substitute to the anchor in the same category or use-case with minimal tradeoffs. Bucket value: "dupe".',
    'Alternative: a viable substitute that serves the same primary goal but has clear differences.',
    '- Use "cheaper_alternative" for lower-price substitutes.',
    '- Use "premium_alternative" for higher-price substitutes.',
    '- Use "price_unknown_alternative" when price is unavailable.',
    '- Use "functional_alternative" for similar function but different approach or category.',
    '[/DEFINITIONS]',
    '',
    '[HARD_RULES]',
    '1. Candidate-pool-only rule: never invent or introduce a product that is not in candidates.',
    '2. Self-reference prohibition: NEVER include the anchor product itself as a candidate.',
    '3. Self-reference prohibition: reject any candidate that matches the anchor by same canonical product reference, same normalized URL, same normalized brand + same normalized product name, or same normalized brand + very high product-name similarity.',
    '4. Same-brand rule: same-brand candidates are allowed only when they are clearly a different product line or use-case. Any same-brand candidate MUST include why_not_the_same_product.',
    '5. Minimum explanation rule: every returned candidate must include why_this_fits, 1-2 key_similarities, 2-3 key_differences, and one concrete tradeoff.',
    '6. Ranking rule: prefer fewer, stronger candidates over a longer weak list.',
    '7. Tone rule: keep comparison language factual, non-marketing, and grounded in the supplied context.',
    '[/HARD_RULES]',
    '',
    '[MISSING_DATA_POLICY]',
    '- If candidates[] is empty, return candidates=[].',
    '- If the candidate pool is weak, return fewer items rather than weak placeholders.',
    '- If a candidate lacks enough evidence to explain similarities, differences, and tradeoff, omit it.',
    '- If price information is missing, use bucket="price_unknown_alternative".',
    '- Confidence must be between 0 and 1.',
    '[/MISSING_DATA_POLICY]',
    '',
    '[FORBIDDEN_BEHAVIOR]',
    '- No invented candidates, brands, or formula details.',
    '- No shopping hype or conversion language.',
    '- No unsupported "same formula" or "perfect dupe" claims.',
    '- No extra narration outside the JSON contract.',
    '[/FORBIDDEN_BEHAVIOR]',
    '',
    '[INPUT_CONTEXT]',
    'anchor_identity={{anchor_identity}}',
    'anchor_fingerprint={{anchor_fingerprint}}',
    'candidates={{candidates}}',
    'profile={{profile}}',
    'locale={{locale}}',
    '[/INPUT_CONTEXT]',
  ].join('\n');
}

function buildDupeCompareStructuredPrompt() {
  return [
    '[ROLE]',
    'You are Aurora, a balanced skincare product comparator for Pivota.',
    'Return one single valid JSON object only. No markdown, no code fences, no prose outside JSON.',
    '[/ROLE]',
    '',
    '[TASK]',
    'Compare the supplied anchor product against the provided targets fairly and concretely.',
    'Stay anchored to the supplied products only. Highlight meaningful differences and tradeoffs instead of declaring simplistic winners.',
    '[/TASK]',
    '',
    '[OUTPUT_CONTRACT]',
    'Return exactly these top-level keys:',
    '{',
    '  "anchor_summary": {',
    '    "name": string,',
    '    "brand": string|null,',
    '    "key_ingredients": string[]',
    '  },',
    '  "comparisons": [',
    '    {',
    '      "target": {"name": string, "brand": string|null},',
    '      "key_ingredients_match": number,',
    '      "texture_comparison": {"en": string, "zh": string|null},',
    '      "suitability_comparison": {"en": string, "zh": string|null},',
    '      "price_comparison": string,',
    '      "verdict_en": string,',
    '      "verdict_zh": string|null',
    '    }',
    '  ],',
    '  "mode": string',
    '}',
    'Do not add extra top-level keys. If a field is unknown, use null, [] or {} instead of omitting it.',
    '[/OUTPUT_CONTRACT]',
    '',
    '[FIELD_SEMANTICS]',
    '- anchor_summary should stay concise and grounded in the supplied anchor only.',
    '- comparisons should include only the supplied targets, in the original order unless a very clear comparison order improves readability.',
    '- key_ingredients_match must be a conservative number between 0 and 1.',
    '- texture_comparison and suitability_comparison should be short, practical comparison statements.',
    '- price_comparison should be one of cheaper, same, more_expensive, or unknown.',
    '- verdict_en should summarize the main tradeoff in one short sentence; verdict_zh may be null when locale is not Chinese.',
    '- mode should be full when multiple useful fields are available, otherwise limited.',
    '[/FIELD_SEMANTICS]',
    '',
    '[HARD_RULES]',
    '1. Grounding rule: compare only the supplied anchor and targets. Do not invent extra products, missing brands, or ingredient decks.',
    '2. Tradeoff rule: each comparison must surface a real difference or uncertainty, not just generic praise.',
    '3. Fairness rule: do not claim two formulas are identical or guaranteed substitutes unless the supplied data explicitly supports it.',
    '4. Completeness rule: every comparison must include key_ingredients_match, texture_comparison, suitability_comparison, price_comparison, and verdict fields.',
    '5. Uncertainty rule: when evidence is thin, keep scores conservative and say what remains uncertain instead of overstating parity.',
    '[/HARD_RULES]',
    '',
    '[MISSING_DATA_POLICY]',
    '- If ingredient detail is sparse, keep key_ingredients_match conservative rather than guessing.',
    '- If price information is missing, use price_comparison="unknown".',
    '- If texture or suitability differences are uncertain, state that uncertainty briefly while still filling the required fields.',
    '- Return fewer emphatic claims, not more, when comparison evidence is limited.',
    '[/MISSING_DATA_POLICY]',
    '',
    '[FORBIDDEN_BEHAVIOR]',
    '- No invented benefits, prices, or hidden formulation claims.',
    '- No marketing language or absolute winner language.',
    '- No unsupported statements that a target is the exact same product.',
    '- No extra narration outside the JSON contract.',
    '[/FORBIDDEN_BEHAVIOR]',
    '',
    '[INPUT_CONTEXT]',
    'anchor={{anchor}}',
    'targets={{targets}}',
    'profile={{profile}}',
    'locale={{locale}}',
    '[/INPUT_CONTEXT]',
  ].join('\n');
}

function buildCheckinInsightsStructuredPrompt() {
  return [
    '[ROLE]',
    'You are Aurora, a conservative skincare progress analyst for Pivota.',
    'Return one single valid JSON object only. No markdown, no code fences, no prose outside JSON.',
    '[/ROLE]',
    '',
    '[TASK]',
    'Analyze recent skincare check-in logs and return a grounded progress summary using checkin logs, profile, routine, photo availability, and locale.',
    'Focus on stable trends, plausible attribution, and the safest next action.',
    '[/TASK]',
    '',
    '[OUTPUT_CONTRACT]',
    'Return exactly these top-level keys:',
    '{',
    '  "trend_summary": {"en": string, "zh": string|null},',
    '  "sensation_trend": string|null,',
    '  "days_tracked": number,',
    '  "attribution": {',
    '    "likely_positive": string[],',
    '    "likely_negative": string[],',
    '    "uncertain": string[]',
    '  }|null,',
    '  "suggested_action": string,',
    '  "detailed_review": object|null',
    '}',
    'Do not add extra top-level keys. If a field is unknown, use null, [] or {} instead of omitting it.',
    '[/OUTPUT_CONTRACT]',
    '',
    '[FIELD_SEMANTICS]',
    '- trend_summary should be a short, user-facing summary of what the logs suggest.',
    '- sensation_trend can be tokens such as improving, stable, fluctuating, worsening, or null.',
    '- days_tracked should reflect the observed tracking span conservatively.',
    '- attribution should separate likely_positive, likely_negative, and uncertain factors; use null when there is no useful attribution.',
    '- suggested_action must be one of continue, optimize, or dupe.',
    '- detailed_review is optional and should stay concise, structured, and grounded in the logs.',
    '[/FIELD_SEMANTICS]',
    '',
    '[HARD_RULES]',
    '1. No-photo rule: if has_photos=false, do not describe visible changes, photo evidence, appearance shifts, or anything that implies the model can see the skin.',
    '2. Grounding rule: trend_summary and attribution must be grounded in the supplied checkin_logs and routine only.',
    '3. Causality rule: do not claim certainty when the data only supports a weak or mixed pattern; use attribution.uncertain or attribution=null instead.',
    '4. Action rule: suggested_action must stay within continue, optimize, or dupe so downstream routing remains valid.',
    '5. Tone rule: keep the summary calm, practical, and non-judgmental.',
    '[/HARD_RULES]',
    '',
    '[MISSING_DATA_POLICY]',
    '- If the logs are noisy or inconsistent, say the trend is stable or mixed rather than overstating change.',
    '- If attribution is weak, keep likely_positive and likely_negative sparse and place the rest in uncertain or null.',
    '- If there is no clear reason to optimize or explore dupes, use suggested_action="continue".',
    '- Do not fill detailed_review unless it adds grounded value beyond the short summary.',
    '[/MISSING_DATA_POLICY]',
    '',
    '[FORBIDDEN_BEHAVIOR]',
    '- No visual claims when has_photos=false.',
    '- No medical diagnosis or treatment claims.',
    '- No invented causes, ingredients, or routine changes.',
    '- No alarmist or shaming language.',
    '[/FORBIDDEN_BEHAVIOR]',
    '',
    '[INPUT_CONTEXT]',
    'checkin_logs={{checkin_logs}}',
    'profile={{profile}}',
    'routine={{routine}}',
    'has_photos={{has_photos}}',
    'locale={{locale}}',
    '[/INPUT_CONTEXT]',
  ].join('\n');
}

function buildIntentClassifierStructuredPrompt() {
  return [
    '[ROLE]',
    'You are Aurora, a routing classifier for skincare chat requests in Pivota.',
    'Return one single valid JSON object only. No markdown, no code fences, no prose outside JSON.',
    '[/ROLE]',
    '',
    '[TASK]',
    'Classify the user message into the best Aurora chat intent and extract lightweight routing entities.',
    'The goal is safe routing. If the message is ambiguous, use a conservative fallback label instead of forcing a skill route.',
    '[/TASK]',
    '',
    '[OUTPUT_CONTRACT]',
    'Return exactly these top-level keys:',
    '{',
    '  "intent": string,',
    '  "confidence": number,',
    '  "entities": {',
    '    "ingredients": string[],',
    '    "products": string[],',
    '    "concerns": string[],',
    '    "user_question": string',
    '  }',
    '}',
    'Do not add extra top-level keys. If a field is unknown, use null, [] or {} instead of omitting the key.',
    '[/OUTPUT_CONTRACT]',
    '',
    '[ALLOWED_INTENTS]',
    'Use exactly one of these labels:',
    '- general_chat',
    '- routine_advice',
    '- skin_diagnosis',
    '- recommend_products',
    '- product_analysis',
    '- ingredient_report',
    '- ingredient_query',
    '- dupe_suggest',
    '- dupe_compare',
    '- travel_mode',
    '- tracker_trends',
    '- checkin_log',
    '[/ALLOWED_INTENTS]',
    '',
    '[FIELD_SEMANTICS]',
    '- confidence must be between 0 and 1.',
    '- entities.ingredients: ingredient names only, max 3.',
    '- entities.products: product names or product anchors only, max 3.',
    '- entities.concerns: skincare concerns only, max 3.',
    '- entities.user_question: echo the original user message in a clean form.',
    '- Use empty arrays when no ingredient, product, or concern is clearly present.',
    '[/FIELD_SEMANTICS]',
    '',
    '[HARD_RULES]',
    '1. Conservative-routing rule: if the message is broad, ambiguous, or mostly conversational, prefer general_chat or routine_advice rather than a narrow skill label.',
    '2. Ingredient-query rule: use ingredient_query for open questions like "what ingredient is best for acne?" and ingredient_report for direct ingredient lookups like "tell me about niacinamide".',
    '3. Product-analysis rule: use product_analysis only when the user is asking to analyze or evaluate a specific product.',
    '4. Recommendation rule: use recommend_products only when the user is clearly asking for products, not just education.',
    '5. Entity rule: do not invent entities that are not explicit in the user message.',
    '6. Confidence rule: keep confidence below 0.5 when routing is weak enough that free-form fallback is safer.',
    '[/HARD_RULES]',
    '',
    '[MISSING_DATA_POLICY]',
    '- If more than one intent looks plausible and there is no clear winner, choose the broader fallback intent and lower confidence.',
    '- If the user mentions a concern without a clear request type, capture the concern in entities.concerns but keep the intent conservative.',
    '- If product or ingredient identity is vague, use broad entity strings only when they are explicit in the text.',
    '[/MISSING_DATA_POLICY]',
    '',
    '[FORBIDDEN_BEHAVIOR]',
    '- Do not decide rollout behavior or downstream thresholds.',
    '- Do not fabricate brands, INCI names, or diagnoses.',
    '- Do not map routine_advice or general_chat into a narrower intent unless the request is explicit.',
    '[/FORBIDDEN_BEHAVIOR]',
    '',
    '[INPUT_CONTEXT]',
    'user_message={{user_message}}',
    '[/INPUT_CONTEXT]',
  ].join('\n');
}

function buildIngredientQueryAnswerStructuredPrompt() {
  return [
    '[ROLE]',
    'You are Aurora, an evidence-aware skincare ingredient educator for Pivota.',
    'Return one single valid JSON object only. No markdown, no code fences, no prose outside JSON.',
    '[/ROLE]',
    '',
    '[TASK]',
    'Answer the user’s open ingredient question directly and concisely, then optionally name a small number of relevant ingredients for follow-up exploration.',
    'Prioritize usefulness, safety, and conservative evidence wording over comprehensiveness.',
    '[/TASK]',
    '',
    '[OUTPUT_CONTRACT]',
    'Return exactly these top-level keys:',
    '{',
    '  "answer_en": string,',
    '  "answer_zh": string|null,',
    '  "ingredients_mentioned": [',
    '    {',
    '      "name": string,',
    '      "inci": string|null,',
    '      "relevance": string|null,',
    '      "pros_en": string[],',
    '      "pros_zh": string[],',
    '      "cons_en": string[],',
    '      "cons_zh": string[],',
    '      "evidence_level": string|null,',
    '      "best_for": string[]',
    '    }',
    '  ],',
    '  "safety_notes": string[],',
    '  "followup_suggestions": string[]',
    '}',
    'Do not add extra top-level keys. If a field is unknown, use null, [] or {} instead of omitting it.',
    '[/OUTPUT_CONTRACT]',
    '',
    '[FIELD_SEMANTICS]',
    '- answer_en should directly answer the question in 1-3 concise sentences.',
    '- answer_zh may be null when locale is not Chinese.',
    '- ingredients_mentioned should list at most 3 ingredient options or examples relevant to the question.',
    '- pros_* and cons_* should stay short, practical, and ingredient-level.',
    '- evidence_level should be a brief token such as strong, moderate, limited, or uncertain.',
    '- safety_notes should be generic safe-use reminders only when useful.',
    '- followup_suggestions should be short prompts for deeper ingredient exploration, max 2.',
    '[/FIELD_SEMANTICS]',
    '',
    '[HARD_RULES]',
    '1. Answer-first rule: answer the user question directly before expanding into ingredient options.',
    '2. Ingredient rule: mention only a small number of relevant ingredients; do not dump long lists.',
    '3. Evidence rule: keep claims conservative and cosmetic-skincare scoped; do not promise results or speak with medical certainty.',
    '4. Commerce rule: do not turn the answer into product recommendations or shopping language.',
    '5. Safety rule: if the question touches irritation, strong actives, pregnancy, or sensitivity, include practical safety_notes.',
    '[/HARD_RULES]',
    '',
    '[MISSING_DATA_POLICY]',
    '- If the question is broad, answer with a principle and 1-3 representative ingredients rather than pretending there is one perfect ingredient.',
    '- If evidence is mixed, say so briefly and use a lower evidence_level.',
    '- If no ingredient should be singled out confidently, ingredients_mentioned may be [].',
    '- Do not guess INCI names when they are not clear or not needed.',
    '[/MISSING_DATA_POLICY]',
    '',
    '[FORBIDDEN_BEHAVIOR]',
    '- No product lists or branded examples.',
    '- No diagnosis or treatment instructions.',
    '- No exaggerated certainty or cure-style wording.',
    '- No long essay response outside the JSON contract.',
    '[/FORBIDDEN_BEHAVIOR]',
    '',
    '[INPUT_CONTEXT]',
    'user_question={{user_question}}',
    'profile={{profile}}',
    'safety_flags={{safety_flags}}',
    'locale={{locale}}',
    '[/INPUT_CONTEXT]',
  ].join('\n');
}

function buildProductAnalyzeStructuredPrompt() {
  return [
    '[ROLE]',
    'You are Aurora, an objective skincare product analyst for Pivota.',
    'Return one single valid JSON object only. No markdown, no code fences, no prose outside JSON.',
    '[/ROLE]',
    '',
    '[TASK]',
    'Analyze the product for broad skincare suitability using the provided anchor, optional ingredient list, profile, safety flags, routine context, and locale.',
    'Stay conservative when data is incomplete. Do not invent ingredients, claims, brand facts, or usage instructions.',
    '[/TASK]',
    '',
    '[OUTPUT_CONTRACT]',
    'Return exactly these top-level keys:',
    '{',
    '  "product_name": string,',
    '  "brand": string|null,',
    '  "product_type": string,',
    '  "has_spf": boolean,',
    '  "suitability": {',
    '    "score": number,',
    '    "summary_en": string,',
    '    "summary_zh": string|null',
    '  },',
    '  "usage": {',
    '    "time_of_day": string,',
    '    "frequency": string,',
    '    "reapply": string|null,',
    '    "application_note_en": string,',
    '    "application_note_zh": string|null',
    '  },',
    '  "key_ingredients": [',
    '    {"name": string, "concept": string|null, "role": string|null, "strength": string|null}',
    '  ],',
    '  "risk_flags": [',
    '    {"code": string, "message_en": string, "message_zh": string|null}',
    '  ]',
    '}',
    'Do not add extra top-level keys. If a field is unknown, use null, [] or {} instead of omitting it.',
    '[/OUTPUT_CONTRACT]',
    '',
    '[FIELD_SEMANTICS]',
    '- product_name: use the anchored product name when provided. If unknown, use a short generic label.',
    '- brand: use the anchored brand when provided; otherwise null. Do not guess a brand.',
    '- product_type: prefer one of sunscreen, serum, moisturizer, cleanser, toner, essence, treatment, mask, oil, other.',
    '- has_spf: true only when SPF/sunscreen is explicit from the anchor or provided ingredient context.',
    '- suitability.score: numeric score between 0 and 1.',
    '- suitability.summary_en: concise evidence-aware verdict for the user profile.',
    '- suitability.summary_zh: Chinese summary when confident; otherwise null.',
    '- usage: describe timing and frequency conservatively and practically.',
    '- key_ingredients: list only ingredients that are explicit in the anchor/context or strongly implied by a verified ingredient list. If not known, return [].',
    '- risk_flags: include only meaningful risks supported by explicit inputs. If no clear risk, return [].',
    '- No repetition across suitability.summary_en, usage notes, and risk flags.',
    '[/FIELD_SEMANTICS]',
    '',
    '[HARD_RULES]',
    '1. SPF / sunscreen rule: if the product is sunscreen or has_spf=true, usage.time_of_day MUST be "AM only".',
    '2. SPF / sunscreen rule: if the product is sunscreen or has_spf=true, usage.frequency MUST be "daily".',
    '3. SPF / sunscreen rule: if the product is sunscreen or has_spf=true, usage.reapply MUST be present with outdoor reapplication guidance.',
    '4. SPF / sunscreen rule: NEVER suggest "PM first", "2-3x/week", or "every other day" for sunscreen usage.',
    '5. Retinoid rule: if the product clearly contains retinoids, prefer PM-only framing and conservative onboarding frequency.',
    '6. Pregnancy rule: if safety_flags indicate pregnancy blocking and the product clearly contains retinoids, be conservative and include a blocking risk flag.',
    '7. Unknown-ingredient rule: if ingredient_list is missing, incomplete, or unverified, do not fabricate key ingredients or confirmed risk statements.',
    '8. Evidence rule: when uncertainty is high, keep the verdict cautious rather than assertive.',
    '[/HARD_RULES]',
    '',
    '[MISSING_DATA_POLICY]',
    '- Do not hallucinate product composition.',
    '- Do not guess unprovided actives, allergens, or concentration.',
    '- Do not infer a specific branded formula beyond the supplied anchor.',
    '- If the ingredient list is unavailable, key_ingredients may be [].',
    '- If a risk is plausible but not confirmed, describe it conservatively in summary or risk_flags without claiming certainty.',
    '[/MISSING_DATA_POLICY]',
    '',
    '[INPUT_CONTEXT]',
    'product_anchor={{product_anchor}}',
    'ingredient_list={{ingredient_list}}',
    'profile={{profile}}',
    'safety_flags={{safety_flags}}',
    'current_routine={{current_routine}}',
    'locale={{locale}}',
    '[/INPUT_CONTEXT]',
  ].join('\n');
}

function buildIngredientReportStructuredPrompt() {
  return [
    '[ROLE]',
    'You are Aurora, an evidence-aware skincare ingredient analyst for Pivota.',
    'Return one single valid JSON object only. No markdown, no code fences, no prose outside JSON.',
    '[/ROLE]',
    '',
    '[TASK]',
    'Generate a structured ingredient report using the ingredient query, optional ontology match, profile, safety flags, and locale.',
    'Keep all claims ingredient-level and conservative. Do not invent product examples, brand references, or commercialization claims.',
    '[/TASK]',
    '',
    '[OUTPUT_CONTRACT]',
    'Return exactly these top-level keys:',
    '{',
    '  "ingredient_name": string,',
    '  "inci_name": string|null,',
    '  "category": string,',
    '  "description_en": string,',
    '  "description_zh": string|null,',
    '  "benefits": [{"benefit_en": string, "benefit_zh": string|null, "evidence_level": string|null}],',
    '  "claims": [{"text_en": string, "text_zh": string|null, "evidence_badge": string}],',
    '  "how_to_use": object|null,',
    '  "watchouts": array,',
    '  "interactions": array,',
    '  "related_ingredients": array',
    '}',
    'Do not add extra top-level keys. If a field is unknown, use null, [] or {} instead of omitting it.',
    '[/OUTPUT_CONTRACT]',
    '',
    '[FIELD_SEMANTICS]',
    '- ingredient_name: the queried ingredient name or the best normalized ingredient label.',
    '- claims: keep this as ingredient-level statements, not product recommendations or shopping claims.',
    '- Every claims item MUST include text_en, text_zh (or null), and evidence_badge.',
    '- evidence_badge should be one of strong, moderate, limited, uncertain.',
    '- If the ingredient identity is unverified, claims should be cautious and may use evidence_badge="uncertain".',
    '- benefits can be empty, but claims must still be present as an array.',
    '- Avoid repetition across description_en, benefits, claims, and watchouts.',
    '[/FIELD_SEMANTICS]',
    '',
    '[HARD_RULES]',
    '1. Unknown-ingredient rule: if ontology_match is missing, null, or unverified, do not present claims as confirmed facts.',
    '2. Unknown-ingredient rule: if ontology_match is missing, do not mention "products containing", "products with this ingredient", or any branded product examples.',
    '3. Claims rule: claims must be ingredient-level only and must not contain marketing promises or medical certainty.',
    '4. Claims rule: each claim must include an evidence_badge; if uncertain, use "uncertain" rather than omitting the claim.',
    '5. Safety rule: include watchouts when irritation, interaction, or caution is plausible from the provided context.',
    '[/HARD_RULES]',
    '',
    '[MISSING_DATA_POLICY]',
    '- Do not hallucinate an INCI, ontology concept, or exact mechanism when not provided.',
    '- If the ingredient appears synthetic, novel, or unresolved, keep the report cautious and generic.',
    '- If evidence is weak or unknown, say so briefly and keep claims conservative.',
    '- Do not convert uncertainty into product advice or shopping guidance.',
    '[/MISSING_DATA_POLICY]',
    '',
    '[INPUT_CONTEXT]',
    'ingredient_query={{ingredient_query}}',
    'ontology_match={{ontology_match}}',
    'profile={{profile}}',
    'safety_flags={{safety_flags}}',
    'locale={{locale}}',
    '[/INPUT_CONTEXT]',
  ].join('\n');
}

function buildTravelApplyModeStructuredPrompt() {
  return [
    '[ROLE]',
    'You are Aurora, a skincare travel routine planner for Pivota.',
    'Return one single valid JSON object only. No markdown, no code fences, no prose outside JSON.',
    '[/ROLE]',
    '',
    '[TASK]',
    'Analyze the travel environment and return structured travel routine guidance using the trip details, climate archetype, profile, current routine, safety flags, and locale.',
    'Focus on UV, humidity, irritation risk, and practical packing adjustments.',
    '[/TASK]',
    '',
    '[OUTPUT_CONTRACT]',
    'Return exactly these top-level keys:',
    '{',
    '  "uv_level": string,',
    '  "humidity": string,',
    '  "reduce_irritation": boolean,',
    '  "packing_list": [{"product_type": string, "reason_en": string, "reason_zh": string|null}],',
    '  "inferred_climate": string|null',
    '}',
    'Do not add extra top-level keys. If a field is unknown, use null, [] or {} instead of omitting it.',
    '[/OUTPUT_CONTRACT]',
    '',
    '[FIELD_SEMANTICS]',
    '- uv_level should prefer low, moderate, high, or extreme.',
    '- humidity should prefer low, medium, or high.',
    '- reduce_irritation indicates whether the user should scale back strong actives during travel.',
    '- packing_list should be practical essentials, not a long catalog.',
    '- inferred_climate should summarize the likely climate or echo the provided archetype.',
    '[/FIELD_SEMANTICS]',
    '',
    '[HARD_RULES]',
    '1. High-UV rule: if climate_archetype or destination clearly implies high UV or tropical exposure, uv_level should be "high" or "extreme".',
    '2. Packing rule: when uv_level is high or extreme, packing_list should include sunscreen with explicit UV-protection reasoning.',
    '3. Active-management rule: if the current routine includes retinoids, exfoliating acids, or strong actives, set reduce_irritation=true.',
    '4. Safety rule: if safety_flags imply irritation, barrier compromise, recent procedures, or sensitivity, set reduce_irritation=true.',
    '5. Do not omit reduce_irritation. Use false only when there is no good reason to scale back actives.',
    '[/HARD_RULES]',
    '',
    '[MISSING_DATA_POLICY]',
    '- Do not guess destination-specific weather beyond the provided archetype and obvious broad travel cues.',
    '- If climate certainty is low, stay conservative and practical.',
    '- Prefer safe routine simplification over aggressive treatment escalation during travel.',
    '[/MISSING_DATA_POLICY]',
    '',
    '[INPUT_CONTEXT]',
    'travel_plan={{travel_plan}}',
    'climate_archetype={{climate_archetype}}',
    'profile={{profile}}',
    'current_routine={{current_routine}}',
    'safety_flags={{safety_flags}}',
    'locale={{locale}}',
    '[/INPUT_CONTEXT]',
  ].join('\n');
}

class LlmGateway {
  constructor(config = {}) {
    const provider = compactText(config.primaryProvider) || 'gemini';
    if (provider !== 'gemini') {
      throw new Error(`Aurora Chat v2 supports only the Gemini provider, received "${provider}"`);
    }
    this._provider = provider;
    this._geminiGate = config.geminiGate
      && typeof config.geminiGate.getApiKey === 'function'
      && typeof config.geminiGate.withGate === 'function'
      ? config.geminiGate
      : null;
    this._useStubResponses = config.stubResponses === true;
    this._promptRegistry = new Map();
    this._schemaRegistry = new Map();
    this._callLog = [];

    this._registerDefaultPrompts();
    this._registerDefaultSchemas();
  }

  async call({ templateId, taskMode, params, schema }) {
    const template = this._promptRegistry.get(templateId);
    if (!template) {
      throw new Error(`LlmGateway: unknown template "${templateId}"`);
    }

    const prompt = this._interpolate(template.text, params);
    const promptHash = this._hash(prompt);
    const callId = uuidv4();
    const startMs = Date.now();

    const provider = this._useStubResponses ? 'stub' : this._provider;
    let text;

    if (this._useStubResponses) {
      text = JSON.stringify(this._buildStubStructuredResponse({ templateId, taskMode, params }));
    } else {
      ({ text } = await this._callStructuredProvider(prompt, { templateId, schemaId: schema, params }));
    }

    let parsed = null;
    if (schema) {
      parsed = this._validateAndParse(text, schema);
      if (!parsed) {
        throw new LlmQualityError(
          `LLM output failed schema validation: ${schema}`,
          { templateId, schema, provider }
        );
      }
    } else {
      parsed = this._tryParseJson(text);
    }

    this._callLog.push({
      call_id: callId,
      template_id: templateId,
      prompt_hash: promptHash,
      task_mode: taskMode || template.taskMode || null,
      provider,
      elapsed_ms: Date.now() - startMs,
      schema_valid: parsed !== null,
    });

    return {
      parsed: parsed || {},
      raw: text,
      promptHash,
      provider,
    };
  }

  async chat({ userMessage, systemPrompt, context, locale, onChunk, priorMessages }) {
    const callId = uuidv4();
    const promptHash = this._hash(compactText(userMessage));
    const startMs = Date.now();
    const messages = this._buildChatMessages(userMessage, systemPrompt, context, locale, priorMessages);

    const provider = this._useStubResponses ? 'stub' : this._provider;
    let text;

    if (this._useStubResponses) {
      const stub = this._buildStubChatResponse(userMessage, context);
      text = JSON.stringify(stub);
      if (typeof onChunk === 'function' && compactText(stub.answer_en)) {
        const chunks = this._chunkText(stub.answer_en, 3);
        for (const chunk of chunks) {
          onChunk(chunk);
        }
      }
    } else {
      if (typeof onChunk === 'function') {
        ({ text } = await this._callChatProviderStream(messages, onChunk));
      } else {
        ({ text } = await this._callChatProvider(messages));
      }
    }

    this._callLog.push({
      call_id: callId,
      template_id: '_chat',
      prompt_hash: promptHash,
      task_mode: 'chat',
      provider,
      elapsed_ms: Date.now() - startMs,
      schema_valid: true,
    });

    return {
      text,
      parsed: this._tryParseJson(text),
      provider,
    };
  }

  async _callStructuredProvider(prompt, { templateId, schemaId, params } = {}) {
    const schema = schemaId ? this._schemaRegistry.get(schemaId) : null;
    const requiredKeys = Array.isArray(schema?.required) ? schema.required : [];
    const systemParts = [
      'Return valid JSON only. Do not use markdown fences or commentary outside the JSON object.',
      requiredKeys.length > 0
        ? `Return exactly one JSON object with all required top-level fields present: ${requiredKeys.join(', ')}.`
        : '',
      'If a field is unknown, return null, [] or {} instead of omitting the key.',
    ].filter(Boolean);

    const messages = [
      {
        role: 'system',
        content: systemParts.join(' '),
      },
      {
        role: 'user',
        content: prompt,
      },
    ];
    return this._callChatProvider(messages, { mode: 'structured' });
  }

  async _callChatProvider(messages, options = {}) {
    return this._callGemini(messages, options);
  }

  async _callChatProviderStream(messages, onChunk) {
    return this._callGeminiStream(messages, onChunk);
  }

  async _callGemini(messages, options = {}) {
    const apiKey = this._pickGeminiApiKey();
    if (!apiKey) {
      const err = new Error('Gemini global gate has no configured API keys');
      err.code = 'MISSING_API_KEY';
      throw err;
    }

    const model = options.mode === 'structured' ? GEMINI_MODELS.structured : GEMINI_MODELS.chat;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    return this._withGeminiGate('aurora_chat_v2_gemini_structured', async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this._buildGeminiBody(messages, options)),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const err = new Error(`Gemini API error: ${response.status}`);
        err.statusCode = response.status;
        throw err;
      }

      const data = await response.json();
      const text = this._extractGeminiText(data);
      if (!text) {
        const err = new Error('empty_output from Gemini');
        err.code = 'EMPTY_OUTPUT';
        throw err;
      }
      return { text };
    });
  }

  async _callGeminiStream(messages, onChunk) {
    const apiKey = this._pickGeminiApiKey();
    if (!apiKey) {
      const err = new Error('Gemini global gate has no configured API keys');
      err.code = 'MISSING_API_KEY';
      throw err;
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODELS.chat}:streamGenerateContent?alt=sse&key=${apiKey}`;
    return this._withGeminiGate('aurora_chat_v2_gemini_stream', async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this._buildGeminiBody(messages, { mode: 'chat' })),
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        const err = new Error(`Gemini stream error: ${response.status}`);
        err.statusCode = response.status;
        throw err;
      }

      let fullText = '';
      await this._consumeSseStream(response, (payload) => {
        const text = this._extractGeminiText(payload);
        if (!text) return;
        fullText += text;
        onChunk(text);
      });

      if (!fullText) {
        const err = new Error('empty_output from Gemini stream');
        err.code = 'EMPTY_OUTPUT';
        throw err;
      }
      return { text: fullText };
    });
  }

  async _consumeSseStream(response, onPayload) {
    if (!response.body || typeof response.body.getReader !== 'function') {
      throw new Error('streaming response body unavailable');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = splitSseLines(buffer);
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = compactText(rawLine);
        if (!line.startsWith('data:')) continue;
        const data = compactText(line.slice(5));
        if (!data || data === '[DONE]') continue;
        try {
          onPayload(JSON.parse(data));
        } catch {
          // Ignore malformed chunks and continue streaming.
        }
      }
    }
  }

  _buildGeminiBody(messages, options = {}) {
    const systemMessage = messages.find((message) => message.role === 'system');
    const contents = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: compactText(message.content) }],
      }));

    const body = {
      contents,
      generationConfig: {
        temperature: options.mode === 'structured' ? 0 : 0.6,
        maxOutputTokens: 2048,
        ...(options.mode === 'structured' ? { responseMimeType: 'application/json' } : {}),
      },
    };

    if (systemMessage) {
      body.systemInstruction = {
        parts: [{ text: compactText(systemMessage.content) }],
      };
    }

    return body;
  }

  _extractGeminiText(data) {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts
      .map((part) => compactText(part?.text))
      .filter(Boolean)
      .join('');
  }

  _buildChatMessages(userMessage, systemPrompt, context, locale, priorMessages) {
    const profile = context && typeof context.profile === 'object' ? context.profile : {};
    const safetyFlags = Array.isArray(context?.safety_flags) ? context.safety_flags : [];
    const systemParts = [compactText(systemPrompt) || AURORA_SYSTEM_PROMPT];

    if (profile.skin_type || Array.isArray(profile.concerns) || Array.isArray(profile.goals)) {
      systemParts.push(
        `User profile: ${JSON.stringify({
          skin_type: profile.skin_type || null,
          concerns: profile.concerns || [],
          goals: profile.goals || [],
          sensitivity: profile.sensitivity || null,
        })}`
      );
    }
    if (safetyFlags.length > 0) {
      systemParts.push(`Safety flags: ${JSON.stringify(safetyFlags)}`);
    }
    if (locale) {
      systemParts.push(`Preferred locale: ${locale}`);
    }

    const history = [];
    if (Array.isArray(priorMessages)) {
      const recent = priorMessages.slice(-10);
      for (const msg of recent) {
        if (!msg || typeof msg !== 'object') continue;
        const role = String(msg.role || '').toLowerCase();
        const content = compactText(msg.content || msg.text || msg.message || '');
        if (!content) continue;
        if (role === 'user' || role === 'assistant') {
          history.push({ role, content });
        }
      }
    }

    return [
      { role: 'system', content: systemParts.join('\n') },
      ...history,
      { role: 'user', content: compactText(userMessage) },
    ];
  }

  _pickGeminiApiKey() {
    const gate = this._getGeminiGate();
    return gate && typeof gate.getApiKey === 'function' ? gate.getApiKey() || null : null;
  }

  async _withGeminiGate(route, fn) {
    const gate = this._getGeminiGate();
    return gate.withGate(route, fn);
  }

  _getGeminiGate() {
    if (this._geminiGate) {
      return this._geminiGate;
    }
    return getGeminiGlobalGate();
  }

  _interpolate(templateText, params) {
    let output = templateText;
    for (const [key, value] of Object.entries(params || {})) {
      output = output.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), toJsonString(value));
    }
    return output;
  }

  _hash(text) {
    return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
  }

  _validateAndParse(text, schemaId) {
    const parsed = this._tryParseJson(text);
    if (!parsed) return null;

    const schema = this._schemaRegistry.get(schemaId);
    if (!schema) return parsed;

    for (const field of schema.required || []) {
      if (!(field in parsed)) {
        return null;
      }
    }
    return parsed;
  }

  _tryParseJson(text) {
    const raw = compactText(text);
    if (!raw) return null;

    try {
      return JSON.parse(raw);
    } catch {
      const fencedMatch = raw.match(/```json\s*([\s\S]*?)```/i);
      if (fencedMatch) {
        try {
          return JSON.parse(fencedMatch[1]);
        } catch {
          // fall through
        }
      }

      const objectMatch = raw.match(/\{[\s\S]*\}$/);
      if (objectMatch) {
        try {
          return JSON.parse(objectMatch[0]);
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  _chunkText(text, parts) {
    const value = compactText(text);
    if (!value) return [];
    const count = Math.max(1, Math.trunc(parts || 1));
    const size = Math.max(1, Math.ceil(value.length / count));
    const chunks = [];
    for (let index = 0; index < value.length; index += size) {
      chunks.push(value.slice(index, index + size));
    }
    return chunks;
  }

  _buildStubStructuredResponse({ templateId, params }) {
    switch (templateId) {
      case 'diagnosis_v2_start_personalized':
        return {
          follow_up_questions: [
            {
              question_en: 'When do your main skin concerns usually flare up?',
              question_zh: '你的主要皮肤问题通常什么时候最明显？',
              options: ['Morning', 'Afternoon', 'Evening'],
            },
            {
              question_en: 'How reactive is your skin to new products?',
              question_zh: '你的皮肤对新产品的反应大吗？',
              options: ['Very reactive', 'Sometimes reactive', 'Usually stable'],
            },
          ],
        };
      case 'diagnosis_v2_answer_blueprint':
        return this._buildStubDiagnosisBlueprint(params);
      case 'routine_categorize_products':
        return this._buildStubRoutineCategorization(params);
      case 'routine_audit_optimize':
        return this._buildStubRoutineAudit(params);
      case 'reco_step_based':
        return this._buildStubStepRecommendations(params);
      case 'tracker_checkin_insights':
        return this._buildStubCheckinInsights(params);
      case 'product_analyze':
        return this._buildStubProductAnalysis(params);
      case 'ingredient_report':
        return this._buildStubIngredientReport(params);
      case 'ingredient_query_answer':
        return this._buildStubIngredientQuestion(params);
      case 'dupe_suggest':
        return this._buildStubDupeSuggest(params);
      case 'dupe_compare':
        return this._buildStubDupeCompare(params);
      case 'travel_apply_mode':
        return this._buildStubTravelMode(params);
      case 'intent_classifier':
        return this._buildStubIntentClassification(params);
      default:
        return { ok: true };
    }
  }

  _buildStubDiagnosisBlueprint(params) {
    const goals = Array.isArray(params?.goals) ? params.goals : [];
    const concerns = goals.length > 0 ? goals.slice(0, 2) : ['hydration'];
    return {
      blueprint_id: `bp_stub_${Date.now()}`,
      inferred_skin_type: params?.profile?.skin_type || 'combination',
      primary_concerns: concerns,
      severity_scores: Object.fromEntries(concerns.map((concern) => [concern, 0.65])),
      confidence: 0.76,
      visual_observations: params?.has_photo ? [{ area: 'overall', note_en: 'Mild redness', note_zh: '轻微泛红' }] : null,
      nudge: null,
      next_recommended_skills: ['routine.apply_blueprint', 'reco.step_based'],
    };
  }

  _buildStubRoutineCategorization(params) {
    const products = Array.isArray(params?.products) ? params.products : [];
    return {
      categorized_products: products.map((product, index) => {
        const text = compactText(product?.name || product);
        const lower = text.toLowerCase();
        let stepAssignment = 'serum';
        if (lower.includes('cleanser')) stepAssignment = 'cleanser';
        else if (lower.includes('spf') || lower.includes('sunscreen')) stepAssignment = 'sunscreen';
        else if (lower.includes('cream') || lower.includes('moistur')) stepAssignment = 'moisturizer';

        return {
          product_input: text || `product_${index + 1}`,
          resolved_name: text || `Product ${index + 1}`,
          brand: compactText(product?.brand) || 'Stub Brand',
          step_assignment: stepAssignment,
          time_of_day: stepAssignment === 'sunscreen' ? 'am' : 'both',
          concepts: stepAssignment === 'sunscreen' ? ['SUNSCREEN'] : [],
        };
      }),
      unresolved: [],
    };
  }

  _buildStubRoutineAudit(params) {
    const routine = params?.routine || {};
    const changes = [];
    const compatibilityIssues = [];

    if ((params?.safety_flags || []).some((flag) => String(flag).includes('BARRIER_COMPROMISED'))) {
      changes.push({
        code: 'reduce_frequency',
        action: 'reduce',
        reason_en: 'Pause or reduce strong actives while the barrier is recovering.',
        reason_zh: '屏障恢复期间暂停或降低强功效成分频率。',
      });
      compatibilityIssues.push({
        concepts: ['RETINOID'],
        risk: 'high',
        note_en: 'Retinoids can worsen irritation when the barrier is compromised.',
        note_zh: '屏障受损时维A类可能加重刺激。',
      });
    }

    return {
      optimized_am_steps: routine.am_steps || [],
      optimized_pm_steps: routine.pm_steps || [],
      changes,
      compatibility_issues: compatibilityIssues,
    };
  }

  _buildStubStepRecommendations(params) {
    const targetIngredient = compactText(params?.target_ingredient);
    const concerns = Array.isArray(params?.concerns) ? params.concerns : [];
    const label = targetIngredient || concerns[0] || 'hydration';
    return {
      step_recommendations: [
        {
          step_id: targetIngredient ? 'pm_treatment' : 'am_serum',
          step_name: {
            en: targetIngredient ? 'Treatment' : 'Serum',
            zh: targetIngredient ? '功效产品' : '精华',
          },
          candidates: [
            {
              product_id: 'stub_product_1',
              brand: 'CeraVe',
              name: targetIngredient ? `${targetIngredient} Treatment Serum` : 'Hydrating Barrier Serum',
              why: {
                en: `A practical option if you are targeting ${label}.`,
                zh: `如果你想针对${label}，这是一个实用选择。`,
              },
              suitability_score: 0.83,
              price_tier: 'mid',
            },
            {
              product_id: 'stub_product_2',
              brand: 'La Roche-Posay',
              name: targetIngredient ? `${targetIngredient} Support Gel` : 'Calming Repair Essence',
              why: {
                en: `Supports ${label} concerns with a gentle profile.`,
                zh: `以相对温和的方式支持${label}相关诉求。`,
              },
              suitability_score: 0.79,
              price_tier: 'premium',
            },
          ],
        },
      ],
    };
  }

  _buildStubCheckinInsights(params) {
    const logs = Array.isArray(params?.checkin_logs) ? params.checkin_logs : [];
    return {
      trend_summary: {
        en: 'Overall progress looks stable with a few day-to-day fluctuations.',
        zh: '整体趋势较稳定，但日间波动仍然存在。',
      },
      sensation_trend: 'stable',
      days_tracked: Math.max(logs.length, 3),
      attribution: {
        likely_positive: ['gentle moisturizer'],
        likely_negative: [],
        uncertain: ['weather changes'],
      },
      suggested_action: 'continue',
      detailed_review: null,
    };
  }

  _buildStubProductAnalysis(params) {
    const anchor = params?.product_anchor || {};
    const name = compactText(anchor?.name) || 'Stub Product';
    const brand = compactText(anchor?.brand) || 'Stub Brand';
    const lower = `${brand} ${name}`.toLowerCase();
    const isSpf = lower.includes('spf') || compactText(anchor?.product_type).toLowerCase() === 'sunscreen';
    const isRetinoid = lower.includes('retinol') || lower.includes('retinoid');

    return {
      product_name: name,
      brand,
      product_type: isSpf ? 'sunscreen' : compactText(anchor?.product_type) || 'serum',
      has_spf: isSpf,
      suitability: {
        score: 0.8,
        summary_en: 'Likely a reasonable fit with standard patch-testing advice.',
        summary_zh: '整体上较为合适，但仍建议先做贴片测试。',
      },
      usage: isSpf
        ? {
            time_of_day: 'AM only',
            frequency: 'daily',
            reapply: 'every 2 hours when outdoors',
            application_note_en: 'Apply generously as the last morning step.',
            application_note_zh: '早晨作为最后一步足量使用。',
          }
        : {
            time_of_day: isRetinoid ? 'PM only' : 'both',
            frequency: isRetinoid ? '1-2x/week' : 'daily',
            application_note_en: 'Introduce gradually if your skin is sensitive.',
            application_note_zh: '如果皮肤敏感，建议逐步建立耐受。',
          },
      key_ingredients: isRetinoid
        ? [{ name: 'Retinol', concept: 'RETINOID', role: 'active', strength: 'medium' }]
        : [],
      risk_flags: [],
    };
  }

  _buildStubIngredientReport(params) {
    const ingredient = compactText(params?.ingredient_query) || 'Niacinamide';
    return {
      ingredient_name: ingredient,
      inci_name: ingredient.toUpperCase(),
      category: 'active',
      description_en: `${ingredient} is commonly used in skincare to support targeted concerns.`,
      description_zh: `${ingredient} 是护肤中常见的功效成分，常用于针对性改善皮肤问题。`,
      benefits: [
        {
          benefit_en: `Can support ${ingredient} related skincare goals when tolerated.`,
          benefit_zh: `在建立耐受的前提下，可支持与 ${ingredient} 相关的护理目标。`,
          evidence_level: 'moderate',
        },
      ],
      claims: [
        {
          text_en: `${ingredient} may help improve skin appearance over time.`,
          text_zh: `${ingredient} 可能在持续使用后帮助改善肌肤表现。`,
          evidence_badge: 'moderate',
        },
      ],
      how_to_use: {
        frequency: 'daily',
        step: 'serum',
        tips_en: ['Patch-test first', 'Introduce gradually if you are sensitive'],
        tips_zh: ['先做贴片测试', '如果敏感请循序渐进建立耐受'],
      },
      watchouts: [
        {
          text_en: 'Stop and reassess if you develop persistent irritation.',
          text_zh: '如果出现持续刺激，请暂停并重新评估。',
          severity: 'low',
        },
      ],
      interactions: [],
      related_ingredients: ['Ceramides', 'Hyaluronic Acid'],
    };
  }

  _buildStubIngredientQuestion(params) {
    const question = compactText(params?.user_question);
    const concern = this._inferConcern(question);
    const ingredients = this._stubIngredientsForConcern(concern);
    return {
      answer_en: `For ${concern}, focus on ingredients with a good balance of evidence and tolerability.`,
      answer_zh: `如果想改善${this._concernToZh(concern)}，可以优先关注证据较充分且相对耐受友好的成分。`,
      ingredients_mentioned: ingredients,
      safety_notes: ['Introduce one new active at a time.', 'Patch-test before regular use.'],
      followup_suggestions: ['Which ingredient should I compare first?', 'Can you recommend products too?'],
    };
  }

  _buildStubDupeSuggest(params) {
    const anchor = params?.anchor_identity || params?.anchor || params?.product_anchor || {};
    const candidates = Array.isArray(params?.candidates) ? params.candidates : [];
    return {
      anchor_summary: {
        brand: compactText(anchor?.brand) || 'Anchor Brand',
        name: compactText(anchor?.name) || 'Anchor Product',
        category: compactText(anchor?.category) || 'moisturizer',
        key_ingredients: ['Niacinamide'],
        primary_use_case: 'hydration',
      },
      candidates: candidates.slice(0, 3).map((candidate, index) => ({
        name: compactText(candidate?.name || candidate?.product?.name) || `Alternative ${index + 1}`,
        brand: compactText(candidate?.brand || candidate?.product?.brand) || 'Stub Brand',
        product_id: compactText(candidate?.product_id || candidate?.product?.product_id) || null,
        url: compactText(candidate?.url || candidate?.product?.url) || null,
        bucket: candidate?.bucket || (index === 0 ? 'dupe' : 'cheaper_alternative'),
        why_this_fits: 'Similar hydration profile and lightweight daily use case.',
        key_similarities: ['Lightweight lotion texture', 'Daily hydration focus'],
        key_differences: ['May feel a bit less rich', 'Different supporting ingredient mix'],
        tradeoff: 'May feel slightly less cushioning on very dry skin.',
        confidence: index === 0 ? 0.84 : 0.76,
        why_not_the_same_product: null,
      })),
    };
  }

  _buildStubDupeCompare(params) {
    const anchor = params?.anchor || {};
    const targets = Array.isArray(params?.targets) ? params.targets : [];
    return {
      anchor_summary: {
        name: compactText(anchor?.name) || 'Anchor Product',
        brand: compactText(anchor?.brand) || 'Anchor Brand',
        key_ingredients: ['Niacinamide'],
      },
      comparisons: targets.map((target, index) => ({
        target: {
          name: compactText(target?.name) || `Target ${index + 1}`,
          brand: compactText(target?.brand) || 'Stub Brand',
        },
        key_ingredients_match: 0.74,
        texture_comparison: {
          en: 'The target feels slightly lighter on skin.',
          zh: '目标产品上脸质地略微更轻薄。',
        },
        suitability_comparison: {
          en: 'Both look broadly suitable, but tolerance can differ.',
          zh: '两者整体都可考虑，但实际耐受度可能不同。',
        },
        price_comparison: 'same',
        verdict_en: 'The formulas are directionally similar.',
        verdict_zh: '两者配方方向整体相近。',
      })),
      mode: targets.length > 1 ? 'full' : 'limited',
    };
  }

  _buildStubTravelMode(params) {
    const climate = compactText(params?.climate_archetype).toLowerCase();
    const highUv = climate.includes('high_uv') || climate.includes('tropical');
    const humidity = climate.includes('dry') ? 'low' : climate.includes('humid') ? 'high' : 'medium';
    return {
      uv_level: highUv ? 'high' : 'moderate',
      humidity,
      reduce_irritation: true,
      packing_list: [
        {
          product_type: 'sunscreen',
          reason_en: 'Daily UV protection remains the non-negotiable step.',
          reason_zh: '日常防晒仍然是不可省略的核心步骤。',
        },
      ],
      inferred_climate: climate || 'temperate',
    };
  }

  _buildStubIntentClassification(params) {
    const userMessage = compactText(params?.user_message);
    const lower = userMessage.toLowerCase();
    const ingredientMentions = this._extractIngredientMentions(lower);
    const concern = this._inferConcern(lower);
    let intent = 'general_chat';

    if (lower.includes('dupe') || lower.includes('alternative')) {
      intent = 'dupe_suggest';
    } else if (lower.includes('analy') || lower.includes('review this product') || lower.includes('spf')) {
      intent = 'product_analysis';
    } else if (lower.includes('routine')) {
      intent = 'routine_advice';
    } else if (lower.includes('diagnosis') || lower.includes('skin type')) {
      intent = 'skin_diagnosis';
    } else if (lower.includes('recommend') || lower.includes('product for')) {
      intent = 'recommend_products';
    } else if (lower.includes('best for') || lower.includes('which ingredient') || lower.includes('what ingredient')) {
      intent = 'ingredient_query';
    } else if (ingredientMentions.length > 0 || lower.includes('ingredient')) {
      intent = 'ingredient_report';
    }

    return {
      intent,
      confidence: intent === 'general_chat' ? 0.42 : 0.83,
      entities: {
        ingredients: ingredientMentions,
        products: lower.includes('spf') ? ['SPF product'] : [],
        concerns: concern ? [concern] : [],
        user_question: userMessage,
      },
    };
  }

  _buildStubChatResponse(userMessage) {
    const lower = compactText(userMessage).toLowerCase();
    if (
      lower.includes('ingredient') ||
      lower.includes('retinol') ||
      lower.includes('niacinamide') ||
      lower.includes('best for')
    ) {
      return this._buildStubIngredientQuestion({ user_question: userMessage });
    }

    return {
      answer_en: 'A simple way to start is to keep the routine gentle, consistent, and sunscreen-focused.',
      answer_zh: '一个稳妥的起点是保持流程温和、稳定，并把防晒放在优先级最高的位置。',
      ingredients_mentioned: [],
      followup_suggestions: ['Want ingredient suggestions?', 'Should I recommend products too?'],
    };
  }

  _extractIngredientMentions(lowerMessage) {
    const known = [
      'retinol',
      'retinoid',
      'niacinamide',
      'salicylic acid',
      'azelaic acid',
      'vitamin c',
      'hyaluronic acid',
      'ceramide',
      'benzoyl peroxide',
    ];
    return known.filter((ingredient) => lowerMessage.includes(ingredient));
  }

  _inferConcern(text) {
    const lower = compactText(text).toLowerCase();
    if (lower.includes('acne') || lower.includes('breakout') || lower.includes('痘')) return 'acne';
    if (lower.includes('dry') || lower.includes('hydration') || lower.includes('dehydrat')) return 'hydration';
    if (lower.includes('aging') || lower.includes('wrinkle') || lower.includes('firm')) return 'anti-aging';
    if (lower.includes('sensitive') || lower.includes('redness') || lower.includes('敏感')) return 'sensitivity';
    if (lower.includes('spot') || lower.includes('pigment') || lower.includes('tone')) return 'pigmentation';
    return 'general skin concerns';
  }

  _stubIngredientsForConcern(concern) {
    if (concern === 'acne') {
      return [
        this._makeStubIngredientMention('Salicylic Acid', 'SALICYLIC ACID', 'helps clear pores', ['good for clogged pores'], ['can be drying'], 'strong', ['acne']),
        this._makeStubIngredientMention('Azelaic Acid', 'AZELAIC ACID', 'helps with breakouts and marks', ['supports redness-prone acne'], ['can sting early on'], 'moderate', ['acne', 'post-acne marks']),
        this._makeStubIngredientMention('Niacinamide', 'NIACINAMIDE', 'supports oil balance and barrier function', ['generally easy to layer'], ['results can be gradual'], 'moderate', ['acne', 'barrier support']),
      ];
    }
    if (concern === 'hydration') {
      return [
        this._makeStubIngredientMention('Hyaluronic Acid', 'HYALURONIC ACID', 'supports water retention', ['works in many routines'], ['can feel sticky in some formulas'], 'moderate', ['hydration']),
        this._makeStubIngredientMention('Glycerin', 'GLYCERIN', 'a classic humectant', ['well tolerated'], ['depends on formula texture'], 'strong', ['hydration']),
      ];
    }
    return [
      this._makeStubIngredientMention('Niacinamide', 'NIACINAMIDE', 'supports multiple common concerns', ['versatile'], ['results vary'], 'moderate', ['texture', 'tone']),
    ];
  }

  _makeStubIngredientMention(name, inci, relevance, prosEn, consEn, evidenceLevel, bestFor) {
    return {
      name,
      inci,
      relevance,
      pros_en: prosEn,
      pros_zh: prosEn,
      cons_en: consEn,
      cons_zh: consEn,
      evidence_level: evidenceLevel,
      best_for: bestFor,
    };
  }

  _concernToZh(concern) {
    if (concern === 'acne') return '痘痘';
    if (concern === 'hydration') return '补水';
    if (concern === 'anti-aging') return '抗老';
    if (concern === 'sensitivity') return '敏感泛红';
    if (concern === 'pigmentation') return '色沉暗沉';
    return '护肤问题';
  }

  _registerDefaultPrompts() {
    const templates = [
      {
        id: 'diagnosis_v2_start_personalized',
        version: '1.1.0',
        taskMode: 'diagnosis',
        text: buildDiagnosisStartStructuredPrompt(),
      },
      {
        id: 'diagnosis_v2_answer_blueprint',
        version: '1.1.0',
        taskMode: 'diagnosis',
        text: buildDiagnosisBlueprintStructuredPrompt(),
      },
      {
        id: 'routine_categorize_products',
        version: '1.1.0',
        taskMode: 'routine',
        text: buildRoutineCategorizationStructuredPrompt(),
      },
      {
        id: 'routine_audit_optimize',
        version: '1.1.0',
        taskMode: 'routine',
        text: buildRoutineAuditStructuredPrompt(),
      },
      {
        id: 'reco_step_based',
        version: '1.1.0',
        taskMode: 'recommendation',
        text: buildRecoStepBasedStructuredPrompt(),
      },
      {
        id: 'tracker_checkin_insights',
        version: '1.1.0',
        taskMode: 'tracker',
        text: buildCheckinInsightsStructuredPrompt(),
      },
      {
        id: 'product_analyze',
        version: '1.1.0',
        taskMode: 'product_analysis',
        text: buildProductAnalyzeStructuredPrompt(),
      },
      {
        id: 'ingredient_report',
        version: '2.1.0',
        taskMode: 'ingredient',
        text: buildIngredientReportStructuredPrompt(),
      },
      {
        id: 'ingredient_query_answer',
        version: '1.1.0',
        taskMode: 'ingredient',
        text: buildIngredientQueryAnswerStructuredPrompt(),
      },
      {
        id: 'dupe_suggest',
        version: '2.0.0',
        taskMode: 'dupe',
        text: buildDupeSuggestStructuredPrompt(),
      },
      {
        id: 'dupe_compare',
        version: '1.1.0',
        taskMode: 'dupe',
        text: buildDupeCompareStructuredPrompt(),
      },
      {
        id: 'travel_apply_mode',
        version: '1.1.0',
        taskMode: 'travel',
        text: buildTravelApplyModeStructuredPrompt(),
      },
      {
        id: 'intent_classifier',
        version: '1.1.0',
        taskMode: 'chat',
        text: buildIntentClassifierStructuredPrompt(),
      },
    ];

    for (const template of templates) {
      this._promptRegistry.set(template.id, template);
    }
  }

  _registerDefaultSchemas() {
    const schemas = [
      { id: 'DiagnosisStartOutput', required: ['follow_up_questions'] },
      { id: 'DiagnosisBlueprintOutput', required: ['blueprint_id', 'inferred_skin_type', 'primary_concerns'] },
      { id: 'ProductCategorizationOutput', required: ['categorized_products'] },
      { id: 'RoutineAuditOutput', required: ['optimized_am_steps', 'optimized_pm_steps', 'changes', 'compatibility_issues'] },
      { id: 'StepRecommendationOutput', required: ['step_recommendations'] },
      { id: 'CheckinInsightsOutput', required: ['trend_summary', 'suggested_action'] },
      { id: 'ProductAnalysisOutput', required: ['product_name', 'product_type', 'suitability', 'usage'] },
      { id: 'IngredientReportOutput', required: ['ingredient_name', 'claims'] },
      { id: 'IngredientQueryOutput', required: ['answer_en', 'ingredients_mentioned'] },
      { id: 'DupeSuggestOutput', required: ['anchor_summary', 'candidates'] },
      { id: 'DupeCompareOutput', required: ['anchor_summary', 'comparisons'] },
      { id: 'TravelModeOutput', required: ['uv_level', 'humidity'] },
      { id: 'IntentClassifierOutput', required: ['intent', 'confidence', 'entities'] },
    ];

    for (const schema of schemas) {
      this._schemaRegistry.set(schema.id, schema);
    }
  }

  getCallLog() {
    return [...this._callLog];
  }

  clearCallLog() {
    this._callLog = [];
  }
}

const AURORA_SYSTEM_PROMPT = buildFreeformChatSystemPrompt();

class LlmQualityError extends Error {
  constructor(message, context) {
    super(message);
    this.name = 'LlmQualityError';
    this.context = context;
  }
}

class LlmSafetyBlockError extends Error {
  constructor(message, context) {
    super(message);
    this.name = 'LlmSafetyBlockError';
    this.context = context;
  }
}

module.exports = LlmGateway;
module.exports.LlmQualityError = LlmQualityError;
module.exports.LlmSafetyBlockError = LlmSafetyBlockError;
module.exports.AURORA_SYSTEM_PROMPT = AURORA_SYSTEM_PROMPT;
module.exports.FREEFORM_PROMPT_VERSION = FREEFORM_PROMPT_VERSION;
