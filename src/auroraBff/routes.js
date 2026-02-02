const axios = require('axios');
const { buildRequestContext } = require('./requestContext');
const { buildEnvelope, makeAssistantMessage, makeEvent } = require('./envelope');
const {
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
} = require('./schemas');
const {
  getUserProfile,
  upsertUserProfile,
  upsertSkinLog,
  getRecentSkinLogs,
  isCheckinDue,
} = require('./memoryStore');
const {
  recommendationsAllowed,
  stateChangeAllowed,
  shouldDiagnosisGate,
  buildDiagnosisPrompt,
  buildDiagnosisChips,
  stripRecommendationCards,
} = require('./gating');
const {
  normalizeProductParse,
  normalizeProductAnalysis,
  normalizeDupeCompare,
  normalizeRecoGenerate,
} = require('./normalize');
const { simulateConflicts } = require('./routineRules');
const { auroraChat, buildContextPrefix } = require('./auroraDecisionClient');
const { extractJsonObject } = require('./jsonExtract');
const {
  normalizeBudgetHint,
  mapConcerns,
  mapBarrierStatus,
  mapAuroraProductParse,
  mapAuroraProductAnalysis,
  mapAuroraAlternativesToDupeCompare,
  mapAuroraRoutineToRecoGenerate,
} = require('./auroraStructuredMapper');

const AURORA_DECISION_BASE_URL = String(process.env.AURORA_DECISION_BASE_URL || '').replace(/\/$/, '');
const PIVOTA_BACKEND_BASE_URL = String(process.env.PIVOTA_BACKEND_BASE_URL || process.env.PIVOTA_API_BASE || '')
  .replace(/\/$/, '');
const INCLUDE_RAW_AURORA_CONTEXT = String(process.env.AURORA_BFF_INCLUDE_RAW_CONTEXT || '').toLowerCase() === 'true';
const USE_AURORA_BFF_MOCK = String(process.env.AURORA_BFF_USE_MOCK || '').toLowerCase() === 'true';

function requireAuroraUid(ctx) {
  const uid = String(ctx.aurora_uid || '').trim();
  if (!uid) {
    const err = new Error('Missing X-Aurora-UID');
    err.status = 400;
    err.code = 'MISSING_AURORA_UID';
    throw err;
  }
  return uid;
}

function parseProfilePatchFromAction(action) {
  if (!action) return null;
  if (typeof action === 'object' && action.data && typeof action.data === 'object') {
    const patch = action.data.profile_patch || action.data.profilePatch;
    if (patch && typeof patch === 'object') return patch;
  }

  // Fallback: parse chip ids like "profile.skinType.oily".
  const id = typeof action === 'string' ? action : action && action.action_id;
  if (!id || typeof id !== 'string') return null;
  const parts = id.split('.');
  if (parts.length < 3 || parts[0] !== 'profile') return null;
  const key = parts[1];
  const value = parts.slice(2).join('.');
  if (!key || !value) return null;
  if (key === 'goals') return { goals: [value] };
  if (key === 'skinType') return { skinType: value };
  if (key === 'sensitivity') return { sensitivity: value };
  if (key === 'barrierStatus') return { barrierStatus: value };
  return null;
}

function summarizeProfileForContext(profile) {
  if (!profile) return null;
  return {
    skinType: profile.skinType || null,
    sensitivity: profile.sensitivity || null,
    barrierStatus: profile.barrierStatus || null,
    goals: Array.isArray(profile.goals) ? profile.goals : [],
    region: profile.region || null,
    budgetTier: profile.budgetTier || null,
  };
}

function deepHasKey(obj, predicate, depth = 0) {
  if (depth > 6) return false;
  if (!obj) return false;
  if (Array.isArray(obj)) return obj.some((v) => deepHasKey(v, predicate, depth + 1));
  if (typeof obj !== 'object') return false;
  for (const [k, v] of Object.entries(obj)) {
    if (predicate(k)) return true;
    if (deepHasKey(v, predicate, depth + 1)) return true;
  }
  return false;
}

function structuredContainsCommerceLikeFields(structured) {
  const commerceKeys = new Set([
    'recommendations',
    'reco',
    'offers',
    'offer',
    'checkout',
    'purchase_route',
    'purchaseroute',
    'affiliate_url',
    'affiliateurl',
    'internal_checkout',
    'internalcheckout',
  ]);
  return deepHasKey(structured, (k) => commerceKeys.has(String(k || '').trim().toLowerCase()));
}

function getUpstreamStructuredOrJson(upstream) {
  if (upstream && upstream.structured && typeof upstream.structured === 'object' && !Array.isArray(upstream.structured)) {
    return upstream.structured;
  }
  if (upstream && typeof upstream.answer === 'string') return extractJsonObject(upstream.answer);
  return null;
}

function buildProductInputText(inputObj, url) {
  if (typeof url === 'string' && url.trim()) return url.trim();
  const o = inputObj && typeof inputObj === 'object' && !Array.isArray(inputObj) ? inputObj : null;
  if (!o) return null;
  const brand = typeof o.brand === 'string' ? o.brand.trim() : '';
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const display = typeof o.display_name === 'string' ? o.display_name.trim() : typeof o.displayName === 'string' ? o.displayName.trim() : '';
  const sku = typeof o.sku_id === 'string' ? o.sku_id.trim() : typeof o.skuId === 'string' ? o.skuId.trim() : '';
  const pid = typeof o.product_id === 'string' ? o.product_id.trim() : typeof o.productId === 'string' ? o.productId.trim() : '';
  const bestName = display || name;
  if (brand && bestName) return `${brand} ${bestName}`.trim();
  if (bestName) return bestName;
  if (sku) return sku;
  if (pid) return pid;
  return null;
}

function buildAuroraRoutineQuery({ profile, focus, constraints, lang }) {
  const skinType = profile && typeof profile.skinType === 'string' ? profile.skinType : 'unknown';
  const barrierStatus = mapBarrierStatus(profile && profile.barrierStatus);
  const concerns = mapConcerns(profile && profile.goals);
  const region = profile && typeof profile.region === 'string' && profile.region.trim() ? profile.region.trim() : 'US';
  const budget = normalizeBudgetHint(profile && profile.budgetTier) || normalizeBudgetHint(constraints && constraints.budget) || '不确定';
  const goal = typeof focus === 'string' && focus.trim()
    ? focus.trim()
    : constraints && typeof constraints.goal === 'string' && constraints.goal.trim()
      ? constraints.goal.trim()
      : 'balanced routine';
  const preference = constraints && typeof constraints.preference === 'string' && constraints.preference.trim()
    ? constraints.preference.trim()
    : 'No special preference';

  const concernsStr = concerns.length ? concerns.join(', ') : 'none';
  const reply = lang === 'CN' ? 'Chinese' : 'English';

  const productsNote = profile && profile.currentRoutine ? `Current routine: ${JSON.stringify(profile.currentRoutine).slice(0, 1000)}\n` : '';

  return (
    `User profile: skin type ${skinType}; barrier status: ${barrierStatus}; concerns: ${concernsStr}; region: ${region}; budget: ${budget}.\n` +
    `Goal: ${goal}.\n` +
    `${productsNote}` +
    `Preference: ${preference}.\n` +
    `Please recommend a simple AM/PM skincare routine within my budget. Reply in ${reply}.`
  );
}

function mountAuroraBffRoutes(app, { logger }) {
  app.post('/v1/product/parse', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = ProductParseRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const input = parsed.data.url || parsed.data.text;
      const query = `Task: Parse the user's product input into a normalized product entity.\n` +
        `Return ONLY a JSON object with keys: product (object), confidence (0..1), missing_info (string[]).\n` +
        `Input: ${input}`;

      let upstream = null;
      try {
        upstream = await auroraChat({ baseUrl: AURORA_DECISION_BASE_URL, query, timeoutMs: 12000 });
      } catch (err) {
        // ignore; fall back below
      }

      const structured = getUpstreamStructuredOrJson(upstream);
      const mapped = structured && structured.parse && typeof structured.parse === 'object'
        ? mapAuroraProductParse(structured)
        : structured;
      const norm = normalizeProductParse(mapped);
      const payload = norm.payload;

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `parse_${ctx.request_id}`,
            type: 'product_parse',
            payload,
            ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'value_moment', { kind: 'product_parse' })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to parse product.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'PRODUCT_PARSE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'PRODUCT_PARSE_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/product/analyze', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = ProductAnalyzeRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const profile = await getUserProfile(ctx.aurora_uid).catch(() => null);
      const recentLogs = await getRecentSkinLogs(ctx.aurora_uid, 7).catch(() => []);
      const profileSummary = summarizeProfileForContext(profile);
      const prefix = buildContextPrefix({ profile: profileSummary, recentLogs });

      const input = parsed.data.url || parsed.data.name || JSON.stringify(parsed.data.product || {});
      const query = `${prefix}Task: Deep-scan this product for suitability vs the user's profile.\n` +
        `Return ONLY a JSON object with keys: assessment, evidence, confidence (0..1), missing_info (string[]).\n` +
        `Evidence must include science/social_signals/expert_notes.\n` +
        `Product: ${input}`;

      let upstream = null;
      try {
        const anchorId = parsed.data.product && (parsed.data.product.sku_id || parsed.data.product.product_id);
        upstream = await auroraChat({
          baseUrl: AURORA_DECISION_BASE_URL,
          query,
          timeoutMs: 16000,
          ...(anchorId ? { anchor_product_id: String(anchorId) } : {}),
          ...(parsed.data.url ? { anchor_product_url: parsed.data.url } : {}),
        });
      } catch (err) {
        // ignore; fall back
      }

      const structured = getUpstreamStructuredOrJson(upstream);
      const mapped = structured && structured.analyze && typeof structured.analyze === 'object'
        ? mapAuroraProductAnalysis(structured)
        : structured;
      const norm = normalizeProductAnalysis(mapped);
      const payload = norm.payload;

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `analyze_${ctx.request_id}`,
            type: 'product_analysis',
            payload,
            ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'value_moment', { kind: 'product_analyze' })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to analyze product.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'PRODUCT_ANALYZE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'PRODUCT_ANALYZE_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/dupe/compare', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = DupeCompareRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const profile = await getUserProfile(ctx.aurora_uid).catch(() => null);
      const recentLogs = await getRecentSkinLogs(ctx.aurora_uid, 7).catch(() => []);
      const profileSummary = summarizeProfileForContext(profile);
      const prefix = buildContextPrefix({ profile: profileSummary, recentLogs });

      const originalInput = buildProductInputText(parsed.data.original, parsed.data.original_url);
      const dupeInput = buildProductInputText(parsed.data.dupe, parsed.data.dupe_url);

      if (!originalInput || !dupeInput) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: 'original and dupe are required' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const productQuery = (input) => (
        `${prefix}Task: Parse the user's product input into a normalized product entity.\n` +
        `Input: ${input}`
      );

      let originalUpstream = null;
      let dupeUpstream = null;
      try {
        const originalAnchor = parsed.data.original && (parsed.data.original.sku_id || parsed.data.original.product_id);
        originalUpstream = await auroraChat({
          baseUrl: AURORA_DECISION_BASE_URL,
          query: productQuery(originalInput),
          timeoutMs: 16000,
          ...(originalAnchor ? { anchor_product_id: String(originalAnchor) } : {}),
          ...(parsed.data.original_url ? { anchor_product_url: parsed.data.original_url } : {}),
        });
      } catch (err) {
        // ignore
      }
      try {
        const dupeAnchor = parsed.data.dupe && (parsed.data.dupe.sku_id || parsed.data.dupe.product_id);
        dupeUpstream = await auroraChat({
          baseUrl: AURORA_DECISION_BASE_URL,
          query: productQuery(dupeInput),
          timeoutMs: 16000,
          ...(dupeAnchor ? { anchor_product_id: String(dupeAnchor) } : {}),
          ...(parsed.data.dupe_url ? { anchor_product_url: parsed.data.dupe_url } : {}),
        });
      } catch (err) {
        // ignore
      }

      const originalStructured = getUpstreamStructuredOrJson(originalUpstream);
      const dupeStructured = getUpstreamStructuredOrJson(dupeUpstream);
      const dupeAnchor = dupeStructured && dupeStructured.parse && typeof dupeStructured.parse === 'object'
        ? (dupeStructured.parse.anchor_product || dupeStructured.parse.anchorProduct)
        : (parsed.data.dupe || null);

      const fallbackAnalyze = () => {
        if (!originalStructured || !dupeStructured) {
          return { tradeoffs: [], evidence: null, confidence: null, missing_info: ['upstream_missing_or_unstructured'] };
        }
        const orig = mapAuroraProductAnalysis(originalStructured);
        const dup = mapAuroraProductAnalysis(dupeStructured);

        const origKeys = Array.isArray(orig.evidence?.science?.key_ingredients) ? orig.evidence.science.key_ingredients : [];
        const dupKeys = Array.isArray(dup.evidence?.science?.key_ingredients) ? dup.evidence.science.key_ingredients : [];
        const missing = origKeys.filter((k) => !dupKeys.includes(k));
        const added = dupKeys.filter((k) => !origKeys.includes(k));

        const tradeoffs = [];
        if (missing.length) tradeoffs.push(`Missing actives vs original: ${missing.join(', ')}`);
        if (added.length) tradeoffs.push(`Added actives: ${added.join(', ')}`);

        const confidence = typeof orig.confidence === 'number' && typeof dup.confidence === 'number'
          ? (orig.confidence + dup.confidence) / 2
          : (orig.confidence || dup.confidence || null);

        const evidence = {
          science: {
            key_ingredients: Array.from(new Set([...origKeys, ...dupKeys])),
            mechanisms: Array.from(new Set([...(orig.evidence?.science?.mechanisms || []), ...(dup.evidence?.science?.mechanisms || [])])),
            fit_notes: Array.from(new Set([...(orig.evidence?.science?.fit_notes || []), ...(dup.evidence?.science?.fit_notes || [])])),
            risk_notes: Array.from(new Set([...(orig.evidence?.science?.risk_notes || []), ...(dup.evidence?.science?.risk_notes || [])])),
          },
          social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
          expert_notes: Array.from(new Set([...(orig.evidence?.expert_notes || []), ...(dup.evidence?.expert_notes || [])])),
          confidence,
          missing_info: ['dupe_not_in_alternatives_used_analyze_diff'],
        };

        return { tradeoffs, evidence, confidence, missing_info: ['dupe_not_found_in_alternatives'] };
      };

      const mapped = originalStructured && originalStructured.alternatives
        ? mapAuroraAlternativesToDupeCompare(originalStructured, dupeAnchor, { fallbackAnalyze })
        : fallbackAnalyze();

      const norm = normalizeDupeCompare(mapped);
      const payload = norm.payload;

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `dupe_${ctx.request_id}`,
            type: 'dupe_compare',
            payload,
            ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'value_moment', { kind: 'dupe_compare' })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to compare products.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'DUPE_COMPARE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'DUPE_COMPARE_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/reco/generate', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = RecoGenerateRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const profile = await getUserProfile(ctx.aurora_uid).catch(() => null);
      const recentLogs = await getRecentSkinLogs(ctx.aurora_uid, 7).catch(() => []);
      const profileSummary = summarizeProfileForContext(profile);

      const gate = shouldDiagnosisGate({ message: 'recommend', triggerSource: 'action', profile });
      if (gate.gated) {
        const prompt = buildDiagnosisPrompt(ctx.lang, gate.missing);
        const chips = buildDiagnosisChips(ctx.lang, gate.missing);
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(prompt),
          suggested_chips: chips,
          cards: [
            {
              card_id: `diag_${ctx.request_id}`,
              type: 'diagnosis_gate',
              payload: { reason: gate.reason, missing_fields: gate.missing, wants: 'recommendation', profile: profileSummary, recent_logs: recentLogs },
            },
          ],
          session_patch: { next_state: 'S2_DIAGNOSIS' },
          events: [makeEvent({ ...ctx, trigger_source: 'action' }, 'state_entered', { next_state: 'S2_DIAGNOSIS', reason: gate.reason })],
        });
        return res.json(envelope);
      }

      const query = buildAuroraRoutineQuery({
        profile: { ...profileSummary, ...(profile && profile.currentRoutine ? { currentRoutine: profile.currentRoutine } : {}) },
        focus: parsed.data.focus,
        constraints: parsed.data.constraints || {},
        lang: ctx.lang,
      });

      let upstream = null;
      try {
        upstream = await auroraChat({ baseUrl: AURORA_DECISION_BASE_URL, query, timeoutMs: 22000 });
      } catch (err) {
        // ignore
      }

      const routine = upstream && upstream.context && typeof upstream.context === 'object' ? upstream.context.routine : null;
      const mapped = mapAuroraRoutineToRecoGenerate(routine, upstream && upstream.context && typeof upstream.context === 'object' ? upstream.context : null);
      const norm = normalizeRecoGenerate(mapped);
      const payload = norm.payload;

      const suggestedChips = [];
      const nextActions = upstream && Array.isArray(upstream.next_actions) ? upstream.next_actions : [];
      if ((!payload.recommendations || payload.recommendations.length === 0) && nextActions.length) {
        for (const act of nextActions.slice(0, 8)) {
          if (!act || typeof act !== 'object') continue;
          const label = typeof act.label === 'string' ? act.label.trim() : typeof act.text === 'string' ? act.text.trim() : '';
          const text = typeof act.text === 'string' ? act.text.trim() : label;
          const id = typeof act.id === 'string' ? act.id.trim() : '';
          if (!label) continue;
          suggestedChips.push({
            chip_id: `chip.aurora.next_action.${id || label.replace(/\\s+/g, '_')}`.slice(0, 80),
            label,
            kind: 'quick_reply',
            data: { reply_text: text, aurora_action_id: id || null },
          });
        }
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: suggestedChips,
        cards: [
          {
            card_id: `reco_${ctx.request_id}`,
            type: 'recommendations',
            payload,
            ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
          },
        ],
        session_patch: payload.recommendations && payload.recommendations.length ? { next_state: 'S7_PRODUCT_RECO' } : {},
        events: [makeEvent({ ...ctx, trigger_source: 'action' }, 'recos_requested', { explicit: true })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to generate recommendations.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'RECO_GENERATE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'RECO_GENERATE_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/photos/presign', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = PhotosPresignRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      // Stub: real storage/QC can be wired later via dedicated service.
      const photoId = `photo_${ctx.request_id}_${Date.now()}`;
      const payload = {
        photo_id: photoId,
        slot_id: parsed.data.slot_id,
        upload: {
          method: 'PUT',
          url: null,
          headers: {},
          expires_in_seconds: 600,
        },
      };

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `presign_${ctx.request_id}`,
            type: 'photo_presign',
            payload,
            field_missing: [{ field: 'upload.url', reason: 'storage_presign_not_configured' }],
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'value_moment', { kind: 'photo_presign' })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to presign upload.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'PHOTO_PRESIGN_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'PHOTO_PRESIGN_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/photos/confirm', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = PhotosConfirmRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      // Stub QC.
      const qcStatus = 'passed';
      const payload = { ...parsed.data, qc_status: qcStatus };

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [{ card_id: `confirm_${ctx.request_id}`, type: 'photo_confirm', payload }],
        session_patch: {},
        events: [makeEvent(ctx, 'value_moment', { kind: 'photo_confirm', qc_status: qcStatus })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to confirm upload.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'PHOTO_CONFIRM_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'PHOTO_CONFIRM_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.get('/v1/session/bootstrap', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      let profile = null;
      let recentLogs = [];
      let dbError = null;
      try {
        profile = await getUserProfile(ctx.aurora_uid);
        recentLogs = await getRecentSkinLogs(ctx.aurora_uid, 7);
      } catch (err) {
        dbError = err;
      }

      const isReturning = Boolean(profile) || recentLogs.length > 0;
      const checkinDue = isCheckinDue(recentLogs);

      const cards = [
        {
          card_id: `bootstrap_${ctx.request_id}`,
          type: 'session_bootstrap',
          payload: {
            profile: summarizeProfileForContext(profile),
            recent_logs: recentLogs,
            checkin_due: checkinDue,
            is_returning: isReturning,
            db_ready: !dbError,
          },
          ...(dbError
            ? { field_missing: [{ field: 'profile', reason: 'db_not_configured_or_unavailable' }] }
            : {}),
        },
      ];

      const events = [makeEvent(ctx, 'state_entered', { state: ctx.state || 'unknown', trigger_source: ctx.trigger_source })];
      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards,
        session_patch: {
          profile: summarizeProfileForContext(profile),
          recent_logs: recentLogs,
          checkin_due: checkinDue,
          is_returning: isReturning,
        },
        events,
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      logger?.warn({ err: err.message, status }, 'session bootstrap failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to bootstrap session.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'BOOTSTRAP_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'BOOTSTRAP_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/profile/update', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = UserProfilePatchSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const updated = await upsertUserProfile(ctx.aurora_uid, parsed.data);

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          { card_id: `profile_${ctx.request_id}`, type: 'profile', payload: { profile: summarizeProfileForContext(updated) } },
        ],
        session_patch: { profile: summarizeProfileForContext(updated) },
        events: [makeEvent(ctx, 'profile_saved', { fields: Object.keys(parsed.data) })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.code === 'NO_DATABASE' ? 503 : 500;
      logger?.warn({ err: err.message, status }, 'profile update failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to save profile.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: { error: err.code === 'NO_DATABASE' ? 'DB_NOT_CONFIGURED' : 'PROFILE_SAVE_FAILED' },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'PROFILE_SAVE_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/tracker/log', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = TrackerLogSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const saved = await upsertSkinLog(ctx.aurora_uid, parsed.data);
      const recent = await getRecentSkinLogs(ctx.aurora_uid, 7);

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          { card_id: `tracker_${ctx.request_id}`, type: 'tracker_log', payload: { log: saved, recent_logs: recent } },
        ],
        session_patch: { recent_logs: recent, checkin_due: isCheckinDue(recent) },
        events: [makeEvent(ctx, 'tracker_logged', { date: saved?.date || null })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.code === 'NO_DATABASE' ? 503 : 500;
      logger?.warn({ err: err.message, status }, 'tracker log failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to save tracker log.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: { error: err.code === 'NO_DATABASE' ? 'DB_NOT_CONFIGURED' : 'TRACKER_LOG_FAILED' },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'TRACKER_LOG_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.get('/v1/tracker/recent', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const days = req.query.days ? Number(req.query.days) : 7;
      const recent = await getRecentSkinLogs(ctx.aurora_uid, days);
      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [{ card_id: `recent_${ctx.request_id}`, type: 'tracker_recent', payload: { days, logs: recent } }],
        session_patch: { recent_logs: recent, checkin_due: isCheckinDue(recent) },
        events: [makeEvent(ctx, 'tracker_loaded', { days })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.code === 'NO_DATABASE' ? 503 : 500;
      logger?.warn({ err: err.message, status }, 'tracker recent failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to load tracker logs.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'TRACKER_LOAD_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'TRACKER_LOAD_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/routine/simulate', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = RoutineSimulateRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const routine = parsed.data.routine || {};
      const testProduct = parsed.data.test_product || null;
      const sim = simulateConflicts({ routine, testProduct });
      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `sim_${ctx.request_id}`,
            type: 'routine_simulation',
            payload: { safe: sim.safe, conflicts: sim.conflicts, summary: sim.summary },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'simulate_conflict', { safe: sim.safe, conflicts: sim.conflicts.length })],
      });
      return res.json(envelope);
    } catch (err) {
      logger?.warn({ err: err.message }, 'routine simulate failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to simulate routine.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'SIMULATE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: 'SIMULATE_FAILED' })],
      });
      return res.status(500).json(envelope);
    }
  });

  app.post('/v1/offers/resolve', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = OffersResolveRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const market = String(parsed.data.market || 'US').trim() || 'US';
      const items = parsed.data.items;

      const resolved = [];
      const fieldMissing = [];

      for (const item of items) {
        const product = item.product;
        const offer = item.offer;
        const url = offer && (offer.affiliate_url || offer.affiliateUrl || offer.url);

        if (USE_AURORA_BFF_MOCK) {
          resolved.push({
            product: { ...product, image_url: product.image_url || 'https://img.example.com/mock.jpg' },
            offer: { ...offer, price: typeof offer.price === 'number' && offer.price > 0 ? offer.price : 12.34, currency: offer.currency || 'USD' },
          });
          continue;
        }

        if (!url) {
          resolved.push(item);
          fieldMissing.push({ field: 'offer.affiliate_url', reason: 'missing_affiliate_url' });
          continue;
        }
        if (!PIVOTA_BACKEND_BASE_URL) {
          resolved.push(item);
          fieldMissing.push({ field: 'offer.snapshot', reason: 'pivota_backend_not_configured' });
          continue;
        }

        try {
          const resp = await axios.post(
            `${PIVOTA_BACKEND_BASE_URL}/api/offers/external/resolve`,
            { market, url, forceRefresh: false },
            { timeout: 12000, validateStatus: () => true },
          );
          if (resp.status !== 200 || !resp.data || !resp.data.ok || !resp.data.offer) {
            resolved.push(item);
            fieldMissing.push({ field: 'offer.snapshot', reason: 'external_offer_resolve_failed' });
            continue;
          }
          const snap = resp.data.offer;
          const patchedProduct = { ...product };
          const patchedOffer = { ...offer };

          if (snap.imageUrl) patchedProduct.image_url = snap.imageUrl;
          if (snap.title && !patchedProduct.name) patchedProduct.name = snap.title;
          if (snap.brand && !patchedProduct.brand) patchedProduct.brand = snap.brand;
          if (snap.price && typeof snap.price === 'object') {
            if (typeof snap.price.amount === 'number') patchedOffer.price = snap.price.amount;
            if (typeof snap.price.currency === 'string') patchedOffer.currency = snap.price.currency;
          }
          if (snap.canonicalUrl) patchedOffer.affiliate_url = snap.canonicalUrl;

          resolved.push({ product: patchedProduct, offer: patchedOffer });
        } catch (err) {
          resolved.push(item);
          fieldMissing.push({ field: 'offer.snapshot', reason: 'external_offer_resolve_timeout_or_network' });
        }
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `offers_${ctx.request_id}`,
            type: 'offers_resolved',
            payload: { items: resolved, market },
            ...(fieldMissing.length ? { field_missing: fieldMissing.slice(0, 8) } : {}),
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'offers_resolved', { count: resolved.length, market })],
      });
      return res.json(envelope);
    } catch (err) {
      logger?.warn({ err: err.message }, 'offers resolve failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to resolve offers.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'OFFERS_RESOLVE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: 'OFFERS_RESOLVE_FAILED' })],
      });
      return res.status(500).json(envelope);
    }
  });

  app.post('/v1/affiliate/outcome', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = AffiliateOutcomeRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [{ card_id: `out_${ctx.request_id}`, type: 'affiliate_outcome', payload: parsed.data }],
        session_patch: {},
        events: [makeEvent(ctx, 'outbound_opened', { outcome: parsed.data.outcome, url: parsed.data.url || null })],
      });
      return res.json(envelope);
    } catch (err) {
      logger?.warn({ err: err.message }, 'affiliate outcome failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to record outcome.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'OUTCOME_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: 'OUTCOME_FAILED' })],
      });
      return res.status(500).json(envelope);
    }
  });

  app.post('/v1/chat', async (req, res) => {
    const parsed = V1ChatRequestSchema.safeParse(req.body || {});
    const ctx = buildRequestContext(req, parsed.success ? parsed.data : req.body || {});

    try {
      requireAuroraUid(ctx);
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      // Best-effort context injection.
      let profile = null;
      let recentLogs = [];
      try {
        profile = await getUserProfile(ctx.aurora_uid);
        recentLogs = await getRecentSkinLogs(ctx.aurora_uid, 7);
      } catch (err) {
        logger?.warn({ err: err.code || err.message }, 'aurora bff: failed to load memory context');
      }

      // Allow chips/actions to patch profile inline (so chat can progress without an extra API call).
      const profilePatchFromAction = parseProfilePatchFromAction(parsed.data.action);
      if (profilePatchFromAction) {
        const patchParsed = UserProfilePatchSchema.safeParse(profilePatchFromAction);
        if (patchParsed.success) {
          try {
            profile = await upsertUserProfile(ctx.aurora_uid, patchParsed.data);
          } catch (err) {
            logger?.warn({ err: err.code || err.message }, 'aurora bff: failed to apply profile chip patch');
          }
        }
      }

      const message = String(parsed.data.message || '').trim();

      // Phase 0 gate: Diagnosis-first (no recos/offers before minimal profile).
      const gate = shouldDiagnosisGate({ message, triggerSource: ctx.trigger_source, profile });
      if (gate.gated) {
        const prompt = buildDiagnosisPrompt(ctx.lang, gate.missing);
        const chips = buildDiagnosisChips(ctx.lang, gate.missing);
        const nextState = stateChangeAllowed(ctx.trigger_source) ? 'S2_DIAGNOSIS' : undefined;

        const events = [
          makeEvent(ctx, 'state_entered', { next_state: nextState || null, reason: gate.reason }),
        ];

        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(prompt),
          suggested_chips: chips,
          cards: [
            {
              card_id: `diag_${ctx.request_id}`,
              type: 'diagnosis_gate',
              payload: {
                reason: gate.reason,
                missing_fields: gate.missing,
                wants: gate.wants,
                profile: summarizeProfileForContext(profile),
                recent_logs: recentLogs,
              },
            },
          ],
          session_patch: nextState ? { next_state: nextState } : {},
          events,
        });
        return res.json(envelope);
      }

      // Upstream Aurora decision system (best-effort).
      let upstream = null;
      const profileSummary = summarizeProfileForContext(profile);
      const prefix = buildContextPrefix({ profile: profileSummary, recentLogs });
      const query = `${prefix}${message || '(no message)'}`;
      try {
        upstream = await auroraChat({ baseUrl: AURORA_DECISION_BASE_URL, query, timeoutMs: 12000 });
      } catch (err) {
        if (err.code !== 'AURORA_NOT_CONFIGURED') {
          logger?.warn({ err: err.message }, 'aurora bff: aurora upstream failed');
        }
      }

      const answer = upstream && typeof upstream.answer === 'string'
        ? upstream.answer
        : ctx.lang === 'CN'
          ? '（我已收到。Aurora 上游暂不可用或未配置，当前仅能提供门控与记忆能力。）'
          : '(Received. Aurora upstream is unavailable or not configured; returning a gated/memory-aware fallback response.)';

      const rawCards = upstream && Array.isArray(upstream.cards) ? upstream.cards : [];
      const allowRecs = recommendationsAllowed(ctx.trigger_source);
      const cards = allowRecs ? rawCards : stripRecommendationCards(rawCards);
      const fieldMissing = [];
      if (!allowRecs && rawCards.length !== cards.length) {
        fieldMissing.push({ field: 'cards', reason: 'recommendations_not_requested' });
      }

      const clarification = upstream && upstream.clarification && typeof upstream.clarification === 'object'
        ? upstream.clarification
        : null;

      const suggestedChips = [];
      if (clarification && Array.isArray(clarification.questions) && clarification.questions[0]) {
        const q0 = clarification.questions[0];
        const qid = q0 && typeof q0.id === 'string' ? q0.id : 'clarify';
        const options = q0 && Array.isArray(q0.options) ? q0.options : [];
        for (const opt of options.slice(0, 8)) {
          if (typeof opt !== 'string' || !opt.trim()) continue;
          suggestedChips.push({
            chip_id: `chip.clarify.${qid}.${opt.trim().slice(0, 40).replace(/\s+/g, '_')}`,
            label: opt.trim(),
            kind: 'quick_reply',
            data: { reply_text: opt.trim(), clarification_id: qid },
          });
        }
      }

      const contextRaw = upstream && upstream.context && typeof upstream.context === 'object' ? upstream.context : null;
      const contextCard = INCLUDE_RAW_AURORA_CONTEXT && contextRaw
        ? [{
          card_id: `aurora_ctx_${ctx.request_id}`,
          type: 'aurora_context_raw',
          payload: {
            intent: upstream && typeof upstream.intent === 'string' ? upstream.intent : null,
            clarification,
            context: contextRaw,
          },
        }]
        : [];

      const structured = getUpstreamStructuredOrJson(upstream);
      const structuredBlocked = Boolean(structured) && !allowRecs && structuredContainsCommerceLikeFields(structured);
      if (structuredBlocked) {
        fieldMissing.push({ field: 'aurora_structured', reason: 'recommendations_not_requested' });
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(answer, 'markdown'),
        suggested_chips: suggestedChips,
        cards: [
          ...(structured && !structuredBlocked
            ? [{
              card_id: `structured_${ctx.request_id}`,
              type: 'aurora_structured',
              payload: structured,
            }]
            : []),
          ...cards.map((c, idx) => ({
            card_id: c.card_id || `aurora_${ctx.request_id}_${idx}`,
            type: c.type || 'aurora_card',
            title: c.title,
            payload: c.payload || c,
            ...(Array.isArray(c.field_missing) ? { field_missing: c.field_missing } : {}),
          })),
          ...contextCard,
          ...(fieldMissing.length
            ? [{ card_id: `gate_${ctx.request_id}`, type: 'gate_notice', payload: {}, field_missing: fieldMissing }]
            : []),
        ],
        session_patch: {},
        events: [
          makeEvent(ctx, 'value_moment', { kind: 'chat_reply' }),
          ...(allowRecs ? [makeEvent(ctx, 'recos_requested', { explicit: true })] : []),
        ],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      logger?.error({ err: err.message, status }, 'aurora bff chat failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to process chat.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'CHAT_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'CHAT_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });
}

module.exports = { mountAuroraBffRoutes };
