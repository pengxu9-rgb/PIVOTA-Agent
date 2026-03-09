const { z } = require('zod');

const CHAT_CARD_TYPES = [
  'recommendations',
  'product_verdict',
  'compatibility',
  'routine',
  'triage',
  'skin_status',
  'effect_review',
  'travel',
  'nudge',
  'ingredient_hub',
  'ingredient_goal_match',
  'aurora_ingredient_report',
  'returning_triage',
  'skin_progress',
  'diagnosis_gate',
  'analysis_summary',
  'analysis_story_v2',
  'routine_fit_summary',
  'confidence_notice',
  'budget_gate',
  'gate_notice',
  'diagnosis_v2_login_prompt',
  'diagnosis_v2_intro',
  'diagnosis_v2_photo_prompt',
  'diagnosis_v2_result',
];

const CardActionSchema = z
  .object({
    type: z.string().min(1),
    label: z.string().min(1),
    payload: z.record(z.string(), z.any()).optional(),
  })
  .strict();

const ChatCardSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(CHAT_CARD_TYPES),
    priority: z.number().int().min(1).max(3).default(1),
    title: z.string().min(1),
    subtitle: z.string().optional(),
    tags: z.array(z.string()).default([]),
    sections: z.array(z.record(z.string(), z.any())).default([]),
    actions: z.array(CardActionSchema).default([]),
    payload: z.record(z.string(), z.any()).optional(),
  })
  .strict();

const QuickReplySchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    value: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .strict();

const FollowUpQuestionSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    options: z.array(QuickReplySchema).default([]),
    required: z.boolean().default(false),
  })
  .strict();

const ThreadOpSchema = z
  .object({
    op: z.enum(['thread_push', 'thread_pop', 'thread_update']),
    topic_id: z.string().min(1),
    summary: z.string().optional(),
    timestamp_ms: z.number().int().nonnegative().optional(),
  })
  .strict();

const ChatCardsResponseSchema = z
  .object({
    version: z.literal('1.0'),
    request_id: z.string().min(1),
    trace_id: z.string().min(1),
    assistant_text: z.string(),
    cards: z.array(ChatCardSchema).max(3),
    follow_up_questions: z.array(FollowUpQuestionSchema).max(3),
    suggested_quick_replies: z.array(QuickReplySchema).max(8),
    session_patch: z.record(z.string(), z.any()).optional(),
    ops: z
      .object({
        thread_ops: z.array(ThreadOpSchema).max(4),
        profile_patch: z.array(z.record(z.string(), z.any())).max(4),
        routine_patch: z.array(z.record(z.string(), z.any())).max(4),
        experiment_events: z.array(z.record(z.string(), z.any())).max(8),
      })
      .strict(),
    safety: z
      .object({
        risk_level: z.enum(['none', 'low', 'medium', 'high']),
        red_flags: z.array(z.string()).max(8),
        disclaimer: z.string(),
      })
      .strict(),
    telemetry: z
      .object({
        intent: z.string().min(1),
        intent_confidence: z.number().min(0).max(1),
        entities: z.array(z.record(z.string(), z.any())).max(16),
        ui_language: z.enum(['CN', 'EN']),
        matching_language: z.enum(['CN', 'EN']),
        language_mismatch: z.boolean(),
        language_resolution_source: z.enum(['header', 'body', 'text_detected', 'mixed_override']),
        gate_type: z.string().min(1).optional(),
        env_source: z.string().min(1).nullable().optional(),
        degraded: z.boolean().optional(),
        required_fields: z.array(z.string().min(1)).max(8).optional(),
        intent_source: z.string().min(1).optional(),
        route_decision: z.string().min(1).optional(),
        route_failure_class: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

module.exports = {
  CHAT_CARD_TYPES,
  CardActionSchema,
  QuickReplySchema,
  FollowUpQuestionSchema,
  ChatCardSchema,
  ChatCardsResponseSchema,
};
