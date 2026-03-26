const { z } = require('zod');
const {
  CardActionSchema,
  FollowUpQuestionSchema,
} = require('./chatCardsSchema');

// ── Goal Presets ──

const GOAL_PRESETS = [
  'anti_aging_face',
  'eye_anti_aging',
  'post_procedure_repair',
  'barrier_repair',
  'sun_protection',
  'brightening',
  'neck_care',
  'daily_maintenance',
  'mask_special',
  'custom',
];

const GoalPresetEnum = z.enum(GOAL_PRESETS);

// ── Goal Profile ──

const GoalProfileSchema = z.object({
  selected_goals: z.array(z.string()).min(1),
  custom_input: z.string().optional(),
  constraints: z.array(z.string()).default([]),
  post_procedure_meta: z
    .object({
      days_since: z.number().int().min(0),
      skin_broken: z.boolean(),
      procedure_type: z.string().optional(),
    })
    .optional(),
});

// ── Diagnosis V2 Intro Payload ──

const DiagnosisV2IntroPayload = z.object({
  goal_profile: GoalProfileSchema,
  is_cold_start: z.boolean().default(false),
  question_strategy: z.enum(['default', 'state_probe']).default('default'),
  followup_questions: z.array(FollowUpQuestionSchema).max(3),
  actions: z.array(CardActionSchema).min(1),
});

// ── Inferred Axis ──

const InferredAxisSchema = z.object({
  axis: z.string().min(1),
  level: z.enum(['low', 'moderate', 'high', 'severe']),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).min(1),
  trend: z.enum(['improved', 'stable', 'worsened', 'new']).default('new'),
  previous_level: z.enum(['low', 'moderate', 'high', 'severe']).optional(),
});

// ── Strategy ──

const StrategySchema = z.object({
  title: z.string().min(1),
  why: z.string().min(1),
  timeline: z.string().min(1),
  do_list: z.array(z.string()).min(1),
  avoid_list: z.array(z.string()).default([]),
});

// ── Routine Blueprint ──

const RoutineBlueprintSchema = z.object({
  am_steps: z.array(z.string()).max(4),
  pm_steps: z.array(z.string()).max(4),
  conflict_rules: z.array(z.string()).default([]),
});

// ── Improvement Path ──

const ImprovementTipSchema = z.object({
  tip: z.string().min(1),
  action_type: z.enum(['take_photo', 'setup_routine', 'start_checkin', 'add_travel']),
  action_label: z.string().min(1),
});

// ── Data Quality ──

const DataQualitySchema = z.object({
  overall: z.enum(['high', 'medium', 'low']),
  limits_banner: z.string().optional(),
});

// ── Diagnosis V2 Result Payload ──

const DiagnosisV2ResultPayload = z
  .object({
    diagnosis_id: z.string().uuid(),
    diagnosis_seq: z.number().int().min(1),
    goal_profile: GoalProfileSchema,
    is_cold_start: z.boolean().default(false),
    data_quality: DataQualitySchema,
    inferred_state: z.object({
      axes: z.array(InferredAxisSchema),
    }),
    strategies: z.array(StrategySchema).min(1).max(3),
    routine_blueprint: RoutineBlueprintSchema,
    improvement_path: z.array(ImprovementTipSchema).max(3).default([]),
    next_actions: z.array(CardActionSchema).min(1),
  })
  .refine((data) => data.next_actions.length >= 1, {
    message: 'next_actions must be non-empty',
    path: ['next_actions'],
  })
  .refine(
    (data) => data.inferred_state.axes.every((ax) => ax.evidence.length >= 1),
    { message: 'Every inferred axis must have at least one evidence item', path: ['inferred_state', 'axes'] },
  )
  .refine(
    (data) => {
      if (!data.goal_profile.selected_goals.includes('post_procedure_repair')) return true;
      return data.goal_profile.post_procedure_meta != null;
    },
    { message: 'post_procedure_repair goal requires post_procedure_meta with days_since and skin_broken', path: ['goal_profile'] },
  );

// ── Thinking Step (SSE streaming) ──

const ThinkingStepEvent = z.object({
  stage: z.enum(['goal_understanding', 'inference', 'strategy']),
  step: z.string().min(1),
  text: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'done']),
});

// ── Login Prompt Payload ──

const DiagnosisV2LoginPromptPayload = z.object({
  prompt_text: z.string().min(1),
  login_action: CardActionSchema,
  skip_action: CardActionSchema,
  pending_goals: z.array(z.string()).default([]),
});

// ── Photo Prompt Payload ──

const DiagnosisV2PhotoPromptPayload = z.object({
  prompt_text: z.string().min(1),
  photo_action: CardActionSchema,
  skip_action: CardActionSchema,
  has_existing_artifact: z.boolean().default(false),
});

// ── Quality Gate Validation ──

function validateResultPayload(payload) {
  const parsed = DiagnosisV2ResultPayload.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues };
  }

  const warnings = [];
  const result = parsed.data;

  if (result.is_cold_start && result.inferred_state.axes.some((ax) => ax.confidence > 0.6)) {
    warnings.push('cold_start result has axes with confidence > 0.6; expected <= 0.6 for cold start');
  }

  if (result.is_cold_start && result.data_quality.overall !== 'low') {
    warnings.push('cold_start result should have data_quality.overall = "low"');
  }

  const limitsInStrategies = result.strategies.some(
    (s) => result.data_quality.limits_banner && (s.why.includes(result.data_quality.limits_banner) || s.title.includes(result.data_quality.limits_banner)),
  );
  if (limitsInStrategies) {
    warnings.push('limits_banner text appears to be duplicated in strategies; should only appear once in data_quality');
  }

  return { ok: true, data: result, warnings };
}

module.exports = {
  GOAL_PRESETS,
  GoalPresetEnum,
  GoalProfileSchema,
  DiagnosisV2IntroPayload,
  InferredAxisSchema,
  StrategySchema,
  RoutineBlueprintSchema,
  ImprovementTipSchema,
  DataQualitySchema,
  DiagnosisV2ResultPayload,
  ThinkingStepEvent,
  DiagnosisV2LoginPromptPayload,
  DiagnosisV2PhotoPromptPayload,
  validateResultPayload,
};
