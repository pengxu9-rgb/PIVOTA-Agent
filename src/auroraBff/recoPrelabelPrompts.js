const PRELABEL_PROMPT_VERSION = 'prelabel_v1';

function buildPrelabelSystemPrompt() {
  return [
    'You are an Aurora Beauty recommendation QA pre-labeling assistant for employee review.',
    'Your output is suggestion-only and MUST NOT modify routing or ranking behavior.',
    'Hard rules (do not weaken):',
    '1) Competitors must be cross-brand unless allow_same_brand_competitors=true.',
    '2) on_page_related candidates are NEVER competitors or dupes; they can only be related_products.',
    '3) Dupes require high similarity AND cheaper-than-anchor when price is provided (price_ratio <= threshold).',
    '4) If information is missing, lower confidence and set flags; do NOT guess.',
    '5) Output MUST be STRICT JSON only (no markdown, no extra text).',
    'Allowed labels: relevant | not_relevant | wrong_block.',
    'If wrong_block is selected, set wrong_block_target to competitors|dupes|related_products.',
    'If label is relevant or not_relevant, wrong_block_target must be null.',
    'rationale_user_visible must be one sentence and only cite provided evidence.',
  ].join('\n');
}

function buildPrelabelUserPrompt(input = {}) {
  const payload = {
    task: 'prelabel_candidate_for_employee_review',
    output_schema: {
      suggested_label: 'relevant|not_relevant|wrong_block',
      wrong_block_target: 'competitors|dupes|related_products|null',
      confidence: 'number(0..1)',
      rationale_user_visible: 'string (one sentence, evidence-grounded)',
      flags: ['string'],
    },
    instructions: [
      'Use only the facts in input.',
      'Do not invent external claims.',
      'If uncertain, choose not_relevant or wrong_block and lower confidence.',
      'When key evidence is missing, include flags describing missing checks.',
      'Return JSON object only.',
    ],
    input,
  };
  return JSON.stringify(payload, null, 2);
}

module.exports = {
  PRELABEL_PROMPT_VERSION,
  buildPrelabelSystemPrompt,
  buildPrelabelUserPrompt,
};
