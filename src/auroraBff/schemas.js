const { z } = require('zod');

const LanguageSchema = z.enum(['EN', 'CN']);

const TriggerSourceSchema = z.enum(['chip', 'action', 'text_explicit', 'text']);

const PurchaseRouteSchema = z.enum(['affiliate_outbound', 'internal_checkout']);

const FieldMissingSchema = z
  .object({
    field: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

const AssistantMessageSchema = z
  .object({
    role: z.literal('assistant'),
    content: z.string(),
    format: z.enum(['text', 'markdown']).optional(),
  })
  .strict();

const SuggestedChipSchema = z
  .object({
    chip_id: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(['quick_reply', 'action']).optional(),
    data: z.record(z.string(), z.any()).optional(),
  })
  .strict();

const EvidenceSchema = z
  .object({
    science: z
      .object({
        key_ingredients: z.array(z.string()).default([]),
        mechanisms: z.array(z.string()).default([]),
        fit_notes: z.array(z.string()).default([]),
        risk_notes: z.array(z.string()).default([]),
      })
      .strict(),
    social_signals: z
      .object({
        platform_scores: z.record(z.string(), z.number()).optional(),
        typical_positive: z.array(z.string()).default([]),
        typical_negative: z.array(z.string()).default([]),
        risk_for_groups: z.array(z.string()).default([]),
      })
      .strict(),
    expert_notes: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).nullable().optional(),
    missing_info: z.array(z.string()).default([]),
  })
  .strict();

const OfferSchema = z
  .object({
    offer_id: z.string().min(1),
    seller: z.string().min(1),
    price: z.number(),
    currency: z.string().min(1),
    original_price: z.number().optional(),
    shipping_days: z.number().int().nonnegative(),
    returns_policy: z.string().min(1),
    reliability_score: z.number().min(0).max(100),
    badges: z.array(z.string()),
    in_stock: z.boolean(),
    purchase_route: PurchaseRouteSchema,
    affiliate_url: z.string().url().optional(),
    internal_checkout: z
      .object({
        items: z.array(
          z
            .object({
              sku_id: z.string().min(1),
              quantity: z.number().int().positive(),
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
  })
  .strict();

const RoutineConflictSchema = z
  .object({
    severity: z.enum(['warn', 'block']),
    message: z.string().min(1),
    step_index: z.number().int().nonnegative().optional(),
    rule_id: z.string().min(1).optional(),
  })
  .strict();

const CardSchema = z
  .object({
    card_id: z.string().min(1),
    type: z.string().min(1),
    title: z.string().optional(),
    payload: z.record(z.string(), z.any()),
    field_missing: z.array(FieldMissingSchema).optional(),
  })
  .strict();

const SessionPatchSchema = z
  .object({
    next_state: z.string().min(1).optional(),
  })
  .passthrough();

const V1ResponseEnvelopeSchema = z
  .object({
    request_id: z.string().min(1),
    trace_id: z.string().min(1),
    assistant_message: AssistantMessageSchema.nullable(),
    suggested_chips: z.array(SuggestedChipSchema),
    cards: z.array(CardSchema),
    session_patch: SessionPatchSchema,
    events: z.array(z.record(z.string(), z.any())),
  })
  .strict();

const AuroraUpstreamMessageSchema = z
  .object({
    role: z.string().min(1),
    content: z.string().min(1),
  })
  .strict();

const V1ChatRequestSchema = z
  .object({
    message: z.string().min(1).optional(),
    client_state: z.string().min(1).optional(),
    requested_transition: z
      .object({
        trigger_source: z.enum(['chip', 'action', 'text_explicit']),
        trigger_id: z.string().min(1),
        requested_next_state: z.string().min(1),
      })
      .strict()
      .optional(),
    anchor_product_id: z.string().min(1).optional(),
    anchor_product_url: z.string().min(1).optional(),
    messages: z.array(AuroraUpstreamMessageSchema).max(50).optional(),
    action: z
      .union([
        z.string().min(1),
        z
          .object({
            action_id: z.string().min(1),
            kind: z.enum(['chip', 'action']).optional(),
            data: z.record(z.string(), z.any()).optional(),
          })
          .strict(),
      ])
      .optional(),
    session: z.record(z.string(), z.any()).optional(),
    language: LanguageSchema.optional(),
    llm_provider: z.enum(['gemini', 'openai']).optional(),
    llm_model: z.string().min(1).max(120).optional(),
    debug: z.boolean().optional(),
  })
  .strict();

const UserProfilePatchSchema = z
  .object({
    skinType: z.string().min(1).optional(),
    sensitivity: z.string().min(1).optional(),
    barrierStatus: z.string().min(1).optional(),
    goals: z.array(z.string().min(1)).optional(),
    region: z.string().min(1).optional(),
    budgetTier: z.string().min(1).optional(),
    currentRoutine: z.union([z.string(), z.record(z.string(), z.any()), z.array(z.any())]).optional(),
    itinerary: z.union([z.string(), z.record(z.string(), z.any()), z.array(z.any())]).optional(),
    contraindications: z.array(z.string().min(1)).optional(),
    lang_pref: LanguageSchema.optional(),
  })
  .strict();

const TrackerLogSchema = z
  .object({
    date: z.string().min(1).optional(), // YYYY-MM-DD
    redness: z.number().int().min(0).max(5).optional(),
    acne: z.number().int().min(0).max(5).optional(),
    hydration: z.number().int().min(0).max(5).optional(),
    notes: z.string().max(4000).optional(),
    targetProduct: z.string().max(500).optional(),
    sensation: z.string().max(500).optional(),
  })
  .strict();

const RoutineSimulateRequestSchema = z
  .object({
    routine: z
      .object({
        am: z.array(z.record(z.string(), z.any())).optional(),
        pm: z.array(z.record(z.string(), z.any())).optional(),
      })
      .strict()
      .optional(),
    test_product: z.record(z.string(), z.any()).optional(),
  })
  .strict();

const OffersResolveRequestSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            product: z.record(z.string(), z.any()),
            offer: z.record(z.string(), z.any()),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    market: z.string().min(1).optional(),
  })
  .strict();

const AffiliateOutcomeRequestSchema = z
  .object({
    outcome: z.enum(['success', 'failed', 'save']),
    url: z.string().min(1).optional(),
    offer_id: z.string().min(1).optional(),
  })
  .strict();

const ProductParseRequestSchema = z
  .object({
    text: z.string().min(1).optional(),
    url: z.string().url().optional(),
  })
  .strict();

const ProductAnalyzeRequestSchema = z
  .object({
    product: z.record(z.string(), z.any()).optional(),
    url: z.string().url().optional(),
    name: z.string().min(1).optional(),
  })
  .strict();

const DupeCompareRequestSchema = z
  .object({
    original: z.record(z.string(), z.any()).optional(),
    dupe: z.record(z.string(), z.any()).optional(),
    original_url: z.string().url().optional(),
    dupe_url: z.string().url().optional(),
  })
  .strict();

const DupeSuggestRequestSchema = z
  .object({
    original: z.record(z.string(), z.any()).optional(),
    original_url: z.string().url().optional(),
    original_text: z.string().min(1).optional(),
    max_dupes: z.number().int().min(1).max(6).optional(),
    max_comparables: z.number().int().min(1).max(6).optional(),
    force_refresh: z.boolean().optional(),
    force_validate: z.boolean().optional(),
  })
  .strict();

const RecoGenerateRequestSchema = z
  .object({
    focus: z.string().min(1).optional(),
    constraints: z.record(z.string(), z.any()).optional(),
    include_alternatives: z.boolean().optional(),
  })
  .strict();

const PhotosPresignRequestSchema = z
  .object({
    slot_id: z.string().min(1),
    content_type: z.string().min(1).optional(),
    bytes: z.number().int().positive().optional(),
  })
  .strict();

const PhotosConfirmRequestSchema = z
  .object({
    photo_id: z.string().min(1),
    slot_id: z.string().min(1).optional(),
  })
  .strict();

const SkinAnalysisRequestSchema = z
  .object({
    use_photo: z.boolean().optional(),
    currentRoutine: z.union([z.string(), z.record(z.string(), z.any()), z.array(z.any())]).optional(),
    photos: z
      .array(
        z
          .object({
            photo_id: z.string().min(1).optional(),
            slot_id: z.string().min(1),
            qc_status: z.string().min(1).optional(),
          })
          .strict(),
      )
      .max(4)
      .optional(),
  })
  .strict();

const AuthStartRequestSchema = z
  .object({
    email: z.string().email(),
  })
  .strict();

const AuthVerifyRequestSchema = z
  .object({
    email: z.string().email(),
    code: z.string().min(4).max(12),
  })
  .strict();

const AuthPasswordSetRequestSchema = z
  .object({
    password: z.string().min(8).max(128),
  })
  .strict();

const AuthPasswordLoginRequestSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1).max(128),
  })
  .strict();

const RecoEmployeeFeedbackRequestSchema = z
  .object({
    anchor_product_id: z.string().min(1),
    block: z.enum(['competitors', 'dupes', 'related_products']),
    candidate_product_id: z.string().min(1).optional(),
    candidate_name: z.string().min(1).optional(),
    feedback_type: z.enum(['relevant', 'not_relevant', 'wrong_block']),
    wrong_block_target: z.enum(['competitors', 'dupes', 'related_products']).optional(),
    reason_tags: z.array(z.string().min(1)).max(12).optional(),
    was_exploration_slot: z.boolean().optional(),
    rank_position: z.number().int().min(1).max(100).optional(),
    pipeline_version: z.string().min(1).optional(),
    models: z.union([z.string().min(1), z.record(z.string(), z.any())]).optional(),
    suggestion_id: z.string().min(1).optional(),
    llm_suggested_label: z.enum(['relevant', 'not_relevant', 'wrong_block']).optional(),
    llm_confidence: z.number().min(0).max(1).optional(),
    request_id: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
    timestamp: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.candidate_product_id && !value.candidate_name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'candidate_product_id or candidate_name is required',
        path: ['candidate_product_id'],
      });
    }
    if (value.feedback_type !== 'wrong_block' && value.wrong_block_target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'wrong_block_target only allowed when feedback_type is wrong_block',
        path: ['wrong_block_target'],
      });
    }
    if (value.feedback_type === 'wrong_block' && !value.wrong_block_target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'wrong_block_target required when feedback_type is wrong_block',
        path: ['wrong_block_target'],
      });
    }
  });

const RecoInterleaveClickRequestSchema = z
  .object({
    anchor_product_id: z.string().min(1),
    block: z.enum(['competitors', 'dupes', 'related_products']),
    candidate_product_id: z.string().min(1).optional(),
    candidate_name: z.string().min(1).optional(),
    request_id: z.string().min(1),
    session_id: z.string().min(1),
    pipeline_version: z.string().min(1).optional(),
    models: z.union([z.string().min(1), z.record(z.string(), z.any())]).optional(),
    category_bucket: z.string().min(1).optional(),
    price_band: z.string().min(1).optional(),
    timestamp: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.candidate_product_id && !value.candidate_name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'candidate_product_id or candidate_name is required',
        path: ['candidate_product_id'],
      });
    }
  });

const RecoAsyncUpdatesRequestSchema = z
  .object({
    ticket_id: z.string().min(1),
    since_version: z.union([z.string().min(1), z.number().int().min(0)]).optional(),
  })
  .strict();

const InternalPrelabelRequestSchema = z
  .object({
    anchor_product_id: z.string().min(1),
    blocks: z.array(z.enum(['competitors', 'dupes', 'related_products'])).max(3).optional(),
    max_candidates_per_block: z
      .object({
        competitors: z.number().int().min(1).max(40).optional(),
        dupes: z.number().int().min(1).max(40).optional(),
        related_products: z.number().int().min(1).max(40).optional(),
      })
      .strict()
      .optional(),
    force_refresh: z.boolean().optional(),
    snapshot_payload: z.record(z.string(), z.any()).optional(),
    request_id: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
  })
  .strict();

const PrelabelSuggestionsQuerySchema = z
  .object({
    anchor_product_id: z.string().min(1),
    block: z.enum(['competitors', 'dupes', 'related_products']).optional(),
    limit: z.union([z.string().min(1), z.number().int().min(1).max(500)]).optional(),
  })
  .strict();

const LabelQueueQuerySchema = z
  .object({
    block: z.enum(['competitors', 'dupes', 'related_products']).optional(),
    limit: z.union([z.string().min(1), z.number().int().min(1).max(500)]).optional(),
    anchor_product_id: z.string().min(1).optional(),
    low_confidence: z.union([z.string().min(1), z.boolean()]).optional(),
    wrong_block_only: z.union([z.string().min(1), z.boolean()]).optional(),
    exploration_only: z.union([z.string().min(1), z.boolean()]).optional(),
    missing_info_only: z.union([z.string().min(1), z.boolean()]).optional(),
  })
  .strict();

module.exports = {
  LanguageSchema,
  TriggerSourceSchema,
  PurchaseRouteSchema,
  FieldMissingSchema,
  AssistantMessageSchema,
  SuggestedChipSchema,
  EvidenceSchema,
  OfferSchema,
  RoutineConflictSchema,
  CardSchema,
  SessionPatchSchema,
  V1ResponseEnvelopeSchema,
  V1ChatRequestSchema,
  UserProfilePatchSchema,
  TrackerLogSchema,
  RoutineSimulateRequestSchema,
  OffersResolveRequestSchema,
  AffiliateOutcomeRequestSchema,
  ProductParseRequestSchema,
  ProductAnalyzeRequestSchema,
  DupeCompareRequestSchema,
  DupeSuggestRequestSchema,
  RecoGenerateRequestSchema,
  PhotosPresignRequestSchema,
  PhotosConfirmRequestSchema,
  SkinAnalysisRequestSchema,
  AuthStartRequestSchema,
  AuthVerifyRequestSchema,
  AuthPasswordSetRequestSchema,
  AuthPasswordLoginRequestSchema,
  RecoEmployeeFeedbackRequestSchema,
  RecoInterleaveClickRequestSchema,
  RecoAsyncUpdatesRequestSchema,
  InternalPrelabelRequestSchema,
  PrelabelSuggestionsQuerySchema,
  LabelQueueQuerySchema,
};
