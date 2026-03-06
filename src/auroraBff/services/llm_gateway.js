const crypto = require('crypto');

function uuidv4() {
  return crypto.randomUUID();
}

/**
 * Unified LLM gateway for all Aurora skill LLM calls.
 *
 * Responsibilities:
 * - Prompt versioning (template_id + prompt_hash)
 * - Task mode enforcement
 * - Schema validation of LLM output
 * - Quality gating (reject malformed/incomplete responses)
 * - Fallback chain: Gemini -> OpenAI (per skin-diagnosis-research-prompt.md)
 * - Telemetry emission
 */
class LlmGateway {
  constructor(config = {}) {
    this._primaryProvider = config.primaryProvider || 'gemini';
    this._fallbackProvider = config.fallbackProvider || 'openai';
    this._promptRegistry = new Map();
    this._schemaRegistry = new Map();
    this._callLog = [];

    this._registerDefaultPrompts();
    this._registerDefaultSchemas();
  }

  /**
   * Main entry point. All skills call this.
   *
   * @param {Object} opts
   * @param {string} opts.templateId - registered prompt template ID
   * @param {string} opts.taskMode - e.g. 'diagnosis', 'routine', 'recommendation'
   * @param {Object} opts.params - template interpolation params
   * @param {string} [opts.schema] - output schema ID for validation
   * @returns {{ parsed: Object, raw: string, promptHash: string, provider: string }}
   */
  async call({ templateId, taskMode, params, schema }) {
    const template = this._promptRegistry.get(templateId);
    if (!template) {
      throw new Error(`LlmGateway: unknown template "${templateId}"`);
    }

    const prompt = this._interpolate(template.text, params);
    const promptHash = this._hash(prompt);

    const callId = uuidv4();
    const startMs = Date.now();

    let result = null;
    let provider = this._primaryProvider;

    try {
      result = await this._callProvider(this._primaryProvider, prompt, taskMode);
    } catch (primaryErr) {
      if (this._shouldFallback(primaryErr)) {
        provider = this._fallbackProvider;
        result = await this._callProvider(this._fallbackProvider, prompt, taskMode);
      } else {
        throw primaryErr;
      }
    }

    let parsed = null;
    if (schema) {
      parsed = this._validateAndParse(result.text, schema);
      if (!parsed) {
        throw new LlmQualityError(
          `LLM output failed schema validation: ${schema}`,
          { templateId, schema, provider }
        );
      }
    } else {
      parsed = this._tryParseJson(result.text);
    }

    this._callLog.push({
      call_id: callId,
      template_id: templateId,
      prompt_hash: promptHash,
      task_mode: taskMode,
      provider,
      elapsed_ms: Date.now() - startMs,
      schema_valid: parsed !== null,
    });

    return {
      parsed: parsed || {},
      raw: result.text,
      promptHash,
      provider,
    };
  }

  _interpolate(templateText, params) {
    let text = templateText;
    for (const [key, value] of Object.entries(params || {})) {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      text = text.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), serialized);
    }
    return text;
  }

  _hash(text) {
    return crypto.createHash('sha256').update(text).digest('hex').substring(0, 16);
  }

  /**
   * Fallback criteria from skin-diagnosis-research-prompt.md:
   * - Gemini timeout / 5xx / invalid schema / empty output -> fallback to OpenAI
   * - Quality failure / safety block / kill switch -> do NOT fallback
   */
  _shouldFallback(err) {
    if (err instanceof LlmQualityError) return false;
    if (err instanceof LlmSafetyBlockError) return false;

    const isTimeout = err.code === 'ETIMEDOUT' || err.message?.includes('timeout');
    const is5xx = err.statusCode >= 500;
    const isEmpty = err.message?.includes('empty_output');

    return isTimeout || is5xx || isEmpty;
  }

  /**
   * Provider abstraction. In production, these connect to actual APIs.
   * This reference implementation returns schema-conforming stubs for development.
   */
  async _callProvider(provider, prompt, taskMode) {
    // NOTE: Replace with actual provider SDK calls in production.
    // Gemini: google-generativeai SDK
    // OpenAI: openai SDK
    const stub = this._getStubForTaskMode(taskMode);
    return { text: JSON.stringify(stub) };
  }

  _getStubForTaskMode(taskMode) {
    const stubs = {
      diagnosis: {
        blueprint_id: `bp_stub_${Date.now()}`,
        inferred_skin_type: 'combination',
        primary_concerns: ['hydration'],
        severity_scores: { hydration: 0.6 },
        confidence: 0.7,
        visual_observations: null,
        nudge: null,
        follow_up_questions: [],
      },
      routine: {
        categorized_products: [],
        unresolved: [],
        changes: [],
        optimized_am_steps: [],
        optimized_pm_steps: [],
        compatibility_issues: [],
      },
      recommendation: {
        step_recommendations: [],
      },
      tracker: {
        trend_summary: { en: 'Steady progress', zh: '稳步进展' },
        sensation_trend: 'stable',
        days_tracked: 7,
        attribution: { likely_positive: [], likely_negative: [], uncertain: [] },
        suggested_action: 'continue',
        detailed_review: null,
      },
      product_analysis: {
        product_name: 'Stub Product',
        brand: 'Stub Brand',
        product_type: 'moisturizer',
        has_spf: false,
        suitability: { score: 0.8, summary_en: 'Good fit', summary_zh: '适合' },
        usage: { time_of_day: 'both', frequency: 'daily' },
        key_ingredients: [],
        risk_flags: [],
      },
      ingredient: {
        ingredient_name: 'Stub Ingredient',
        category: 'humectant',
        description_en: 'A common skincare ingredient.',
        description_zh: '一种常见的护肤成分。',
        claims: [{ text_en: 'May help hydration.', text_zh: '可能有助于保湿。', evidence_badge: 'uncertain' }],
        watchouts: [],
        interactions: [],
      },
      dupe: {
        anchor_summary: { name: 'Anchor Product' },
        candidates: [],
        comparisons: [],
        mode: 'full',
      },
      travel: {
        uv_level: 'high',
        humidity: 'high',
        reduce_irritation: true,
        packing_list: [],
        inferred_climate: 'tropical_humid',
      },
    };
    return stubs[taskMode] || { _stub: true, _task_mode: taskMode };
  }

  _validateAndParse(text, schemaId) {
    const schema = this._schemaRegistry.get(schemaId);
    const parsed = this._tryParseJson(text);

    if (!parsed) return null;
    if (!schema) return parsed;

    for (const field of schema.required || []) {
      if (!(field in parsed)) {
        return null;
      }
    }

    return parsed;
  }

  _tryParseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[1]);
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  _registerDefaultPrompts() {
    const templates = [
      {
        id: 'diagnosis_v2_start_personalized',
        version: '1.0.0',
        text: 'You are Aurora, a skin care advisor. The user has skin type: {{skin_type}}, concerns: {{concerns}}. Generate 2-3 personalized follow-up questions to refine their diagnosis. Locale: {{locale}}. Return JSON: { "follow_up_questions": [{ "question_en": "...", "question_zh": "...", "options": [...] }] }',
      },
      {
        id: 'diagnosis_v2_answer_blueprint',
        version: '1.0.0',
        text: 'Analyze skin state based on goals: {{goals}}, profile: {{profile}}, recent_logs: {{recent_logs}}, has_photo: {{has_photo}}, safety_flags: {{safety_flags}}. Locale: {{locale}}. Return JSON with: blueprint_id, inferred_skin_type, primary_concerns, severity_scores, confidence, visual_observations (only if has_photo=true), nudge, next_recommended_skills.',
      },
      {
        id: 'routine_categorize_products',
        version: '1.0.0',
        text: 'Categorize these products into routine steps: {{products}}. Current routine: {{routine}}. Locale: {{locale}}. Return JSON: { "categorized_products": [{ "product_input": "...", "resolved_name": "...", "brand": "...", "step_assignment": "cleanser|toner|serum|moisturizer|sunscreen|treatment", "time_of_day": "am|pm|both", "concepts": [...] }], "unresolved": [...] }',
      },
      {
        id: 'routine_audit_optimize',
        version: '1.0.0',
        text: 'Audit this skincare routine for gaps, conflicts, and optimization opportunities. Routine: {{routine}}. Profile: {{profile}}. Known issues from deterministic audit: {{audit_results}}. Safety flags: {{safety_flags}}. Locale: {{locale}}. Return JSON with: optimized_am_steps, optimized_pm_steps, changes[], compatibility_issues[].',
      },
      {
        id: 'reco_step_based',
        version: '1.0.0',
        text: 'Recommend products for each routine step. Profile: {{profile}}. Current routine: {{routine}}. Inventory: {{inventory}}. Target step: {{target_step}}. Safety flags: {{safety_flags}}. Locale: {{locale}}. Return JSON: { "step_recommendations": [{ "step_id": "...", "step_name": {...}, "candidates": [{ "product_id": "...", "brand": "...", "name": "...", "why": {...}, "suitability_score": 0.85, "price_tier": "budget|mid|premium" }] }] }',
      },
      {
        id: 'tracker_checkin_insights',
        version: '1.0.0',
        text: 'Analyze check-in trends. Logs: {{checkin_logs}}. Profile: {{profile}}. Routine: {{routine}}. Has photos: {{has_photos}}. Locale: {{locale}}. Return JSON with: trend_summary, sensation_trend, days_tracked, attribution { likely_positive, likely_negative, uncertain }, suggested_action (optimize|dupe|continue|photo), detailed_review.',
      },
      {
        id: 'product_analyze',
        version: '1.0.0',
        text: 'Analyze this skincare product for the user. Product: {{product_anchor}}. Ingredients: {{ingredient_list}}. Profile: {{profile}}. Safety flags: {{safety_flags}}. Current routine: {{current_routine}}. Locale: {{locale}}. Return JSON: { "product_name": "...", "brand": "...", "product_type": "cleanser|toner|serum|moisturizer|sunscreen|treatment|mask", "has_spf": bool, "suitability": { "score": 0.0-1.0, "summary_en": "...", "summary_zh": "..." }, "usage": { "time_of_day": "AM|PM|both", "frequency": "...", "application_note_en": "...", "application_note_zh": "..." }, "key_ingredients": [{ "name": "...", "concept": "...", "role": "...", "strength": "low|medium|high" }], "risk_flags": [] }',
      },
      {
        id: 'ingredient_report',
        version: '1.0.0',
        text: 'Generate an ingredient science report. Ingredient: {{ingredient_query}}. Ontology match: {{ontology_match}}. Profile: {{profile}}. Safety flags: {{safety_flags}}. Locale: {{locale}}. Return JSON: { "ingredient_name": "...", "category": "...", "description_en": "...", "description_zh": "...", "claims": [{ "text_en": "...", "text_zh": "...", "evidence_badge": "strong|moderate|limited|uncertain" }], "watchouts": [{ "text_en": "...", "text_zh": "...", "severity": "high|medium|low" }], "interactions": [{ "with_concept": "...", "risk_level": "high|medium|low", "note": "..." }] }',
      },
      {
        id: 'dupe_suggest',
        version: '1.0.0',
        text: 'Find dupe/alternative products for: {{anchor}}. Candidates from DB: {{candidates}}. Profile: {{profile}}. Locale: {{locale}}. For each candidate provide: name, brand, price_comparison (same_price|cheaper|more_expensive|unknown_price), confidence (0-1, exclude 0), differences[], tradeoffs[]. Return JSON: { "anchor_summary": {...}, "candidates": [...] }',
      },
      {
        id: 'dupe_compare',
        version: '1.0.0',
        text: 'Compare products in detail. Anchor: {{anchor}}. Targets: {{targets}}. Profile: {{profile}}. Locale: {{locale}}. For each target provide: key_ingredients_match, texture_comparison, suitability_comparison, price_comparison, verdict_en, verdict_zh. Return JSON: { "anchor_summary": {...}, "comparisons": [...], "mode": "full|limited" }',
      },
      {
        id: 'travel_apply_mode',
        version: '1.0.0',
        text: 'Generate travel skincare adjustments. Travel plan: {{travel_plan}}. Climate archetype: {{climate_archetype}}. Profile: {{profile}}. Current routine: {{current_routine}}. Safety flags: {{safety_flags}}. Locale: {{locale}}. Return JSON: { "uv_level": "low|moderate|high|extreme", "humidity": "low|medium|high", "reduce_irritation": bool, "packing_list": [...], "inferred_climate": "..." }',
      },
    ];

    for (const t of templates) {
      this._promptRegistry.set(t.id, t);
    }
  }

  _registerDefaultSchemas() {
    const schemas = [
      {
        id: 'DiagnosisBlueprintOutput',
        required: ['blueprint_id', 'inferred_skin_type', 'primary_concerns'],
      },
      {
        id: 'ProductCategorizationOutput',
        required: ['categorized_products'],
      },
      {
        id: 'RoutineAuditOutput',
        required: ['changes'],
      },
      {
        id: 'StepRecommendationOutput',
        required: ['step_recommendations'],
      },
      {
        id: 'CheckinInsightsOutput',
        required: ['trend_summary', 'suggested_action'],
      },
      {
        id: 'ProductAnalysisOutput',
        required: ['product_name', 'product_type', 'suitability', 'usage'],
      },
      {
        id: 'IngredientReportOutput',
        required: ['ingredient_name', 'claims'],
      },
      {
        id: 'DupeSuggestOutput',
        required: ['anchor_summary', 'candidates'],
      },
      {
        id: 'DupeCompareOutput',
        required: ['anchor_summary', 'comparisons'],
      },
      {
        id: 'TravelModeOutput',
        required: ['uv_level', 'humidity'],
      },
    ];

    for (const s of schemas) {
      this._schemaRegistry.set(s.id, s);
    }
  }

  getCallLog() {
    return [...this._callLog];
  }

  clearCallLog() {
    this._callLog = [];
  }
}

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
