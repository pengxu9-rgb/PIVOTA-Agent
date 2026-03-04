'use strict';

describe('Product Analysis V4 unit tests', () => {
  let classifyProductType;
  let buildInciStatus;
  let buildProductDeepScanPromptV4;
  let buildDataQualityBanner;
  let enforceUnknownVerdictQuality;
  let applyUnknownVerdictQualityGateToEnvelope;
  let isLikelyInvalidInciToken;

  beforeEach(() => {
    jest.resetModules();
    process.env.AURORA_BFF_USE_MOCK = 'true';
    process.env.AURORA_PRODUCT_INTEL_PROMPT_VERSION = 'v4';
    const routes = require('../src/auroraBff/routes');
    classifyProductType = routes.__internal.classifyProductType;
    buildInciStatus = routes.__internal.buildInciStatus;
    buildProductDeepScanPromptV4 = routes.__internal.buildProductDeepScanPromptV4;
    buildDataQualityBanner = routes.__internal.buildDataQualityBanner;
    enforceUnknownVerdictQuality = routes.__internal.enforceUnknownVerdictQuality;
    applyUnknownVerdictQualityGateToEnvelope = routes.__internal.applyUnknownVerdictQualityGateToEnvelope;
    isLikelyInvalidInciToken = routes.__internal.isLikelyInvalidInciToken;
  });

  afterEach(() => {
    delete process.env.AURORA_BFF_USE_MOCK;
    delete process.env.AURORA_PRODUCT_INTEL_PROMPT_VERSION;
  });

  describe('classifyProductType()', () => {
    test('detects SPF from product name', () => {
      const result = classifyProductType({ name: 'CeraVe AM Facial Moisturizing Lotion SPF 30', url: '', inciList: [] });
      expect(result.product_type).toBe('spf_moisturizer');
      expect(result.usage_overrides.when).toBe('AM_only');
      expect(result.usage_overrides.reapply_guidance).toBe(true);
      expect(result.usage_overrides.suppress_pm_first).toBe(true);
      expect(result.usage_overrides.suppress_2_3x_week).toBe(true);
    });

    test('detects SPF from URL containing sunscreen', () => {
      const result = classifyProductType({ name: 'Daily Defense', url: 'https://example.com/sunscreen-daily-defense', inciList: [] });
      expect(result.product_type).toBe('spf');
      expect(result.usage_overrides.when).toBe('AM_only');
    });

    test('detects SPF from UV filter actives in INCI', () => {
      const result = classifyProductType({
        name: 'Daily Moisturizer',
        url: 'https://example.com/daily-moisturizer',
        inciList: ['Water', 'Glycerin', 'Avobenzone', 'Homosalate', 'Niacinamide'],
      });
      expect(['spf', 'spf_moisturizer']).toContain(result.product_type);
      expect(result.usage_overrides.when).toBe('AM_only');
    });

    test('detects active_treatment from retinol in INCI', () => {
      const result = classifyProductType({
        name: 'Night Renewal Serum',
        url: 'https://example.com/night-serum',
        inciList: ['Water', 'Retinol', 'Hyaluronic Acid'],
      });
      expect(result.product_type).toBe('active_treatment');
      expect(result.usage_overrides.allow_intro_schedule).toBe(true);
    });

    test('detects cleanser from product name', () => {
      const result = classifyProductType({ name: 'CeraVe Foaming Facial Cleanser', url: '', inciList: [] });
      expect(result.product_type).toBe('cleanser');
      expect(result.usage_overrides.when).toBe('Both');
    });

    test('detects serum from product name', () => {
      const result = classifyProductType({ name: 'The Ordinary Niacinamide 10% + Zinc 1% Serum', url: '', inciList: [] });
      expect(result.product_type).toBe('serum');
    });

    test('falls back to other for unrecognized product', () => {
      const result = classifyProductType({ name: 'Mystery Product X', url: '', inciList: [] });
      expect(result.product_type).toBe('other');
    });

    test('SPF does NOT get 2-3x/week or PM-first guidance', () => {
      const result = classifyProductType({ name: 'La Roche-Posay Anthelios SPF 50', url: '', inciList: [] });
      expect(result.usage_overrides.suppress_pm_first).toBe(true);
      expect(result.usage_overrides.suppress_2_3x_week).toBe(true);
    });
  });

  describe('buildInciStatus()', () => {
    test('returns blocked extraction when on_page_fetch_blocked gap code present', () => {
      const result = buildInciStatus({
        gapCodes: ['on_page_fetch_blocked'],
        consensusResult: null,
        sources: [],
      });
      expect(result.extraction).toBe('blocked');
      expect(result.verification_required).toBe(true);
    });

    test('returns success extraction when incidecoder_source_used present', () => {
      const result = buildInciStatus({
        gapCodes: ['incidecoder_source_used'],
        consensusResult: { merged: ['Water', 'Glycerin'], confidence_tier: 'med' },
        sources: [{ type: 'inci_decoder', url: 'https://incidecoder.com/example', confidence: 0.7, ingredient_count: 2 }],
      });
      expect(result.extraction).toBe('success');
      expect(result.consensus_tier).toBe('medium');
    });

    test('returns high consensus tier for high confidence', () => {
      const result = buildInciStatus({
        gapCodes: [],
        consensusResult: {
          merged: new Array(20).fill('ingredient'),
          confidence_tier: 'high',
        },
        sources: [],
      });
      expect(result.consensus_tier).toBe('high');
      expect(result.verification_required).toBe(false);
    });

    test('returns low consensus and verification_required=true for no data', () => {
      const result = buildInciStatus({
        gapCodes: [],
        consensusResult: null,
        sources: [],
      });
      expect(result.extraction).toBe('missing');
      expect(result.verification_required).toBe(true);
    });

    test('includes normalized sources', () => {
      const result = buildInciStatus({
        gapCodes: [],
        consensusResult: { merged: ['Water'], confidence_tier: 'med' },
        sources: [
          { type: 'official_page', url: 'https://brand.com/product', confidence: 0.85, ingredient_count: 30 },
        ],
      });
      expect(result.sources).toHaveLength(1);
      expect(result.sources[0].type).toBe('official_page');
    });
  });

  describe('buildProductDeepScanPromptV4()', () => {
    test('includes product_type in prompt', () => {
      const prompt = buildProductDeepScanPromptV4({
        productDescriptor: 'La Roche-Posay Anthelios SPF 50',
        productType: 'spf',
        inciStatus: null,
        usageOverrides: { when: 'AM_only', suppress_pm_first: true, suppress_2_3x_week: true },
      });
      expect(prompt).toContain('spf');
      expect(prompt).toContain('AM_only');
      expect(prompt).toContain('La Roche-Posay Anthelios SPF 50');
    });

    test('includes INCI verification status in prompt', () => {
      const prompt = buildProductDeepScanPromptV4({
        productDescriptor: 'Some Moisturizer',
        productType: 'moisturizer',
        inciStatus: {
          extraction: 'blocked',
          consensus_tier: 'low',
          verification_required: true,
          total_ingredients: 0,
          sources: [],
        },
        usageOverrides: {},
      });
      expect(prompt).toContain('verification_required=true');
      expect(prompt).toContain('consensus_tier=low');
    });

    test('includes hard rules in system block', () => {
      const prompt = buildProductDeepScanPromptV4({
        productDescriptor: 'Test Product',
        productType: 'serum',
        inciStatus: null,
        usageOverrides: {},
      });
      expect(prompt).toContain('verdict_level');
      expect(prompt).toContain('watchouts');
      expect(prompt).toContain('No repetition');
    });

    test('outputs JSON schema with required fields', () => {
      const prompt = buildProductDeepScanPromptV4({
        productDescriptor: 'CeraVe Moisturizing Cream',
        productType: 'moisturizer',
        inciStatus: null,
        usageOverrides: {},
      });
      expect(prompt).toContain('verdict_level');
      expect(prompt).toContain('data_quality_banner');
      expect(prompt).toContain('key_ingredients_by_function');
      expect(prompt).toContain('how_to_use');
    });

    test('SPF prompt suppresses PM-first guidance', () => {
      const prompt = buildProductDeepScanPromptV4({
        productDescriptor: 'Daily SPF 50',
        productType: 'spf',
        inciStatus: null,
        usageOverrides: {
          when: 'AM_only',
          suppress_pm_first: true,
          suppress_2_3x_week: true,
          reapply_guidance: true,
        },
      });
      expect(prompt).toContain('PM first');
      expect(prompt).toContain('reapplication guidance');
    });
  });

  describe('isLikelyInvalidInciToken()', () => {
    test('rejects heading tokens like Key Ingredients', () => {
      expect(isLikelyInvalidInciToken('Key Ingredients:')).toBe(true);
      expect(isLikelyInvalidInciToken('Active Ingredients')).toBe(true);
      expect(isLikelyInvalidInciToken('Ingredients:')).toBe(true);
    });

    test('rejects tokens ending with colon', () => {
      expect(isLikelyInvalidInciToken('Section Header:')).toBe(true);
    });

    test('accepts valid INCI tokens', () => {
      expect(isLikelyInvalidInciToken('Sodium Hyaluronate')).toBe(false);
      expect(isLikelyInvalidInciToken('Niacinamide')).toBe(false);
      expect(isLikelyInvalidInciToken('Zinc Oxide')).toBe(false);
      expect(isLikelyInvalidInciToken('Cyclopentasiloxane')).toBe(false);
    });
  });

  describe('enforceUnknownVerdictQuality() - verdict_level override', () => {
    test('overrides verdict_level=recommended to needs_verification when consensus_tier=low', () => {
      const payload = {
        assessment: {
          verdict: 'Suitable',
          verdict_level: 'recommended',
        },
        inci_status: {
          extraction: 'success',
          consensus_tier: 'low',
          verification_required: true,
          total_ingredients: 5,
          sources: [],
        },
        confidence: 0.6,
        missing_info: [],
      };
      const result = enforceUnknownVerdictQuality(payload, { lang: 'EN' });
      expect(result.assessment.verdict_level).not.toBe('recommended');
      expect(['needs_verification', 'cautiously_ok']).toContain(result.assessment.verdict_level);
    });

    test('keeps verdict_level=cautiously_ok unchanged (not overridden)', () => {
      const payload = {
        assessment: {
          verdict: 'Caution',
          verdict_level: 'cautiously_ok',
        },
        inci_status: {
          extraction: 'success',
          consensus_tier: 'medium',
          verification_required: false,
          total_ingredients: 20,
          sources: [],
        },
        confidence: 0.75,
        missing_info: [],
      };
      const result = enforceUnknownVerdictQuality(payload, { lang: 'EN' });
      expect(result.assessment.verdict_level).toBe('cautiously_ok');
    });

    test('does not downgrade recommended when inci_status is absent', () => {
      const payload = {
        assessment: {
          verdict: 'Suitable',
          verdict_level: 'recommended',
        },
        confidence: 0.82,
        missing_info: [],
      };
      const result = enforceUnknownVerdictQuality(payload, { lang: 'EN' });
      expect(result.assessment.verdict_level).toBe('recommended');
    });
  });

  describe('applyUnknownVerdictQualityGateToEnvelope()', () => {
    test('strips DAG debug traces from expert_notes', () => {
      const envelope = {
        request_id: 'req_test',
        trace_id: 'trace_test',
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: 'analyze_test',
            type: 'product_analysis',
            payload: {
              assessment: {
                verdict: 'Suitable',
              },
              evidence: {
                expert_notes: [
                  'Evidence source: ingredient list parsed from brand.com.',
                  'DAG fallback trace: catalog_fallback, reco_blocks.',
                  'DAG timed-out branches: catalog_ann.',
                ],
                missing_info: [],
              },
              confidence: 0.7,
              missing_info: [],
            },
          },
        ],
        session_patch: {},
        events: [],
      };

      const result = applyUnknownVerdictQualityGateToEnvelope(envelope, { lang: 'EN' });
      const card = result.cards.find((c) => c.type === 'product_analysis');
      const expertNotes = card.payload.evidence.expert_notes;
      expect(expertNotes).not.toContain('DAG fallback trace: catalog_fallback, reco_blocks.');
      expect(expertNotes).not.toContain('DAG timed-out branches: catalog_ann.');
      expect(expertNotes).toContain('Evidence source: ingredient list parsed from brand.com.');
      expect(card.payload._debug).toBeDefined();
      expect(card.payload._debug.expert_notes_stripped).toBeDefined();
      expect(card.payload._debug.expert_notes_stripped.length).toBe(2);
    });

    test('adds data_quality_banner when on_page_fetch_blocked in missing_info', () => {
      const envelope = {
        request_id: 'req_test2',
        trace_id: 'trace_test2',
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: 'analyze_test2',
            type: 'product_analysis',
            payload: {
              assessment: { verdict: 'Unknown' },
              evidence: { expert_notes: [], missing_info: ['on_page_fetch_blocked'] },
              confidence: 0.3,
              missing_info: ['on_page_fetch_blocked', 'incidecoder_source_used'],
            },
          },
        ],
        session_patch: {},
        events: [],
      };

      const result = applyUnknownVerdictQualityGateToEnvelope(envelope, { lang: 'EN' });
      const card = result.cards.find((c) => c.type === 'product_analysis');
      const banner = card.payload.assessment.data_quality_banner;
      expect(typeof banner).toBe('string');
      expect(banner.length).toBeGreaterThan(0);
    });

    test('validates watchouts structure', () => {
      const envelope = {
        request_id: 'req_test3',
        trace_id: 'trace_test3',
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: 'analyze_test3',
            type: 'product_analysis',
            payload: {
              assessment: {
                verdict: 'Suitable',
                watchouts: [
                  { issue: 'May cause dryness', status: 'confirmed', what_to_do: 'Use a hydrating serum after' },
                  { issue: '', status: 'possible', what_to_do: 'patch test' },
                  { issue: 'Fragrance present', status: 'invalid_status', what_to_do: 'patch test' },
                ],
              },
              evidence: { expert_notes: [], missing_info: [] },
              confidence: 0.7,
              missing_info: [],
            },
          },
        ],
        session_patch: {},
        events: [],
      };

      const result = applyUnknownVerdictQualityGateToEnvelope(envelope, { lang: 'EN' });
      const card = result.cards.find((c) => c.type === 'product_analysis');
      const watchouts = card.payload.assessment.watchouts;
      expect(watchouts.every((w) => w.issue)).toBe(true);
      const fragranceWatchout = watchouts.find((w) => w.issue === 'Fragrance present');
      expect(fragranceWatchout).toBeDefined();
      expect(fragranceWatchout.status).toBe('unknown');
    });
  });

  describe('buildDataQualityBanner()', () => {
    test('returns null when no quality warnings', () => {
      const banner = buildDataQualityBanner({ missing_info: [] }, { lang: 'EN' });
      expect(banner).toBeNull();
    });
  });
});
