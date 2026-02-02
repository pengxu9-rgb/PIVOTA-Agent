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

const V1ChatRequestSchema = z
  .object({
    message: z.string().min(1).optional(),
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

const RecoGenerateRequestSchema = z
  .object({
    focus: z.string().min(1).optional(),
    constraints: z.record(z.string(), z.any()).optional(),
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
  RecoGenerateRequestSchema,
  PhotosPresignRequestSchema,
  PhotosConfirmRequestSchema,
};
