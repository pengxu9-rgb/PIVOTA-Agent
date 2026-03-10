'use strict';

describe('Product Analysis V4 unit tests', () => {
  let classifyProductType;
  let buildInciStatus;
  let buildProductDeepScanPromptV4;
  let buildDataQualityBanner;
  let deriveInciStatusFromPayloadSignals;
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
    deriveInciStatusFromPayloadSignals = routes.__internal.deriveInciStatusFromPayloadSignals;
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

    test('keeps verification_required=true when llm_verification_used is the only source', () => {
      const result = buildInciStatus({
        gapCodes: ['llm_verification_used'],
        consensusResult: { merged: ['Water', 'Glycerin', 'Niacinamide'], confidence_tier: 'med' },
        sources: [{ type: 'llm_verification', confidence: 0.6, ingredient_count: 3 }],
      });
      expect(result.extraction).toBe('success');
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

    test('deriveInciStatusFromPayloadSignals aligns incidecoder-only + version verification to low/verified-required', () => {
      const payload = {
        evidence: {
          sources: [{ type: 'inci_decoder', url: 'https://incidecoder.com/p/example', confidence: 0.81 }],
          science: {
            key_ingredients: ['Water', 'Glycerin', 'Niacinamide'],
          },
        },
        missing_info: ['incidecoder_source_used', 'version_verification_needed'],
      };
      const status = deriveInciStatusFromPayloadSignals(payload);
      expect(status).toBeTruthy();
      expect(status.consensus_tier).toBe('low');
      expect(status.verification_required).toBe(true);
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

    test('injects no-brand-guess hard rules when anchor is unresolved', () => {
      const prompt = buildProductDeepScanPromptV4({
        productDescriptor: 'vitamin C serum (user text only)',
        productType: 'serum',
        inciStatus: {
          extraction: 'missing',
          consensus_tier: 'low',
          verification_required: true,
          total_ingredients: 0,
          sources: [],
        },
        usageOverrides: {},
        anchorResolved: false,
      });

      expect(prompt).toContain('No anchor product was resolved from catalog');
      expect(prompt).toContain('Do NOT guess or assume a specific brand or SKU');
      expect(prompt).toContain('SkinCeuticals C E Ferulic');
      expect(prompt).toContain('Do NOT populate anchor_product');
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

    test('downgrades recommended and reconciles inci_status when provenance ingredient_consensus is low', () => {
      const payload = {
        assessment: {
          verdict: 'Suitable',
          verdict_level: 'recommended',
          summary: 'Official-page INCI extraction was blocked; INCIDecoder was used as a supplemental source.',
          reasons: [
            'Fit signal: lower irritation exposure and redness risk; keep acne/comedone control on track.',
            'Official-page INCI extraction was blocked; INCIDecoder was used as a supplemental source.',
          ],
        },
        inci_status: {
          extraction: 'success',
          consensus_tier: 'medium',
          verification_required: false,
          total_ingredients: 3,
          sources: [{ type: 'official_page', url: 'https://brand.com/pdp' }],
        },
        provenance: {
          ingredient_consensus: {
            confidence_tier: 'low',
          },
        },
        missing_info: ['incidecoder_source_used', 'version_verification_needed'],
      };
      const result = enforceUnknownVerdictQuality(payload, { lang: 'EN' });
      expect(result.assessment.verdict_level).toBe('needs_verification');
      expect(result.inci_status.consensus_tier).toBe('low');
      expect(result.inci_status.verification_required).toBe(true);
      expect(String(result.assessment.summary || '').toLowerCase()).not.toContain('official-page inci extraction was blocked');
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
      expect(fragranceWatchout.status).toBe('possible');
    });

    test('upgrades legacy payload to V4 fields when prompt version is v4', () => {
      const envelope = {
        request_id: 'req_legacy_upgrade',
        trace_id: 'trace_legacy_upgrade',
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: 'analyze_legacy_upgrade',
            type: 'product_analysis',
            payload: {
              assessment: {
                verdict: 'Likely Suitable',
                summary: 'Hydrating formula with barrier-supportive ingredients.',
                reasons: ['Hydration-focused ingredient profile.'],
                how_to_use: {
                  timing: 'AM/PM',
                  frequency: 'daily',
                  steps: ['Apply after cleansing.'],
                  observation_window: 'Observe for 10-14 days.',
                  stop_signs: ['Persistent redness'],
                },
              },
              evidence: {
                science: {
                  key_ingredients: ['Glycerin', 'Ceramide NP', 'Niacinamide'],
                  risk_notes: ['May cause mild dryness in reactive skin.'],
                },
                expert_notes: ['Evidence source: official page.'],
                missing_info: [],
              },
              confidence: 0.78,
              missing_info: [],
            },
          },
        ],
        session_patch: {},
        events: [],
      };

      const result = applyUnknownVerdictQualityGateToEnvelope(envelope, { lang: 'EN' });
      const card = result.cards.find((c) => c.type === 'product_analysis');
      expect(card.payload.assessment.verdict_level).toBe('recommended');
      expect(card.payload.assessment.top_takeaways.length).toBeGreaterThan(0);
      expect(card.payload.assessment.how_to_use).toMatchObject({
        when: 'AM/PM',
        frequency: 'daily',
      });
      expect(typeof card.payload.assessment.how_to_use.order_in_routine).toBe('string');
      expect(Array.isArray(card.payload.assessment.how_to_use.pairing_rules)).toBe(true);
      expect(Array.isArray(card.payload.assessment.watchouts)).toBe(true);
      expect(Array.isArray(card.payload.evidence.key_ingredients_by_function)).toBe(true);
      expect(typeof card.payload.evidence.product_type_reasoning).toBe('string');
    });

    test('SPF legacy payload enforces AM only and removes PM-first guidance', () => {
      const envelope = {
        request_id: 'req_spf_upgrade',
        trace_id: 'trace_spf_upgrade',
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: 'analyze_spf_upgrade',
            type: 'product_analysis',
            payload: {
              assessment: {
                verdict: 'Suitable',
                anchor_product: {
                  brand: 'La Roche-Posay',
                  name: 'Anthelios SPF 50',
                  url: 'https://example.com/anthelios-spf-50',
                },
                how_to_use: {
                  timing: 'PM first',
                  frequency: 'Start 2-3 nights/week',
                  steps: ['PM first for 2-3 nights.'],
                  stop_signs: ['Stinging'],
                },
                reasons: ['Daily sunscreen protection.'],
              },
              evidence: {
                science: {
                  key_ingredients: ['Avobenzone', 'Octocrylene'],
                  risk_notes: [],
                },
                expert_notes: [],
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
      const howToUse = card.payload.assessment.how_to_use;
      expect(howToUse.when).toBe('AM only');
      expect(howToUse.frequency).toBe('daily');
      expect(howToUse.pairing_rules.join(' | ').toLowerCase()).not.toContain('pm first');
      expect(howToUse.pairing_rules.join(' | ').toLowerCase()).toContain('reapply');
    });

    test('filters fit/data-quality lines out of watchouts and top_takeaways in legacy-to-v4 upgrade', () => {
      const envelope = {
        request_id: 'req_filter_upgrade',
        trace_id: 'trace_filter_upgrade',
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: 'analyze_filter_upgrade',
            type: 'product_analysis',
            payload: {
              assessment: {
                verdict: 'Likely Suitable',
                reasons: [
                  'Official-page INCI extraction was blocked; INCIDecoder was used as a supplemental source.',
                  'Fit signal: lower irritation exposure and redness risk; keep acne/comedone control on track.',
                  'May include fragrance-related ingredients; patch testing is recommended for sensitive skin.',
                ],
                watchouts: [
                  {
                    issue: 'Fit signal: lower irritation exposure and redness risk; keep acne/comedone control on track.',
                    status: 'confirmed',
                    what_to_do: 'Patch test first and monitor tolerance.',
                  },
                  {
                    issue: 'May include fragrance-related ingredients; patch testing is recommended for sensitive skin.',
                    status: 'confirmed',
                    what_to_do: 'Patch test first; stop if stinging or redness persists.',
                  },
                ],
              },
              evidence: {
                science: {
                  key_ingredients: ['Water', 'Niacinamide'],
                  risk_notes: ['May include fragrance-related ingredients; patch testing is recommended for sensitive skin.'],
                },
                expert_notes: [],
                missing_info: ['incidecoder_source_used', 'version_verification_needed'],
              },
              missing_info: ['incidecoder_source_used', 'version_verification_needed'],
            },
          },
        ],
        session_patch: {},
        events: [],
      };
      const result = applyUnknownVerdictQualityGateToEnvelope(envelope, { lang: 'EN' });
      const card = result.cards.find((c) => c.type === 'product_analysis');
      expect(Array.isArray(card.payload.assessment.top_takeaways)).toBe(true);
      expect(
        card.payload.assessment.top_takeaways.some((line) =>
          /official-page inci extraction was blocked/i.test(String(line || '')),
        ),
      ).toBe(false);
      expect(
        card.payload.assessment.watchouts.some((w) =>
          /fit signal/i.test(String(w.issue || '')),
        ),
      ).toBe(false);
      expect(
        card.payload.assessment.watchouts.some((w) =>
          /fragrance-related/i.test(String(w.issue || '')),
        ),
      ).toBe(true);
    });

    test('does not hard-downgrade recommended when INCI evidence signals are absent', () => {
      const envelope = {
        request_id: 'req_no_inci_signal',
        trace_id: 'trace_no_inci_signal',
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: 'analyze_no_inci_signal',
            type: 'product_analysis',
            payload: {
              assessment: {
                verdict: 'Suitable',
                summary: 'Looks compatible for daily use.',
                reasons: ['No obvious irritation markers in returned signals.'],
              },
              evidence: {
                science: {
                  key_ingredients: ['Niacinamide'],
                  risk_notes: [],
                },
                expert_notes: [],
                missing_info: [],
              },
              confidence: 0.8,
              missing_info: [],
            },
          },
        ],
        session_patch: {},
        events: [],
      };

      const result = applyUnknownVerdictQualityGateToEnvelope(envelope, { lang: 'EN' });
      const card = result.cards.find((c) => c.type === 'product_analysis');
      expect(card.payload.assessment.verdict_level).toBe('recommended');
      expect(card.payload.inci_status).toBeUndefined();
    });
  });

  describe('buildDataQualityBanner()', () => {
    test('returns null when no quality warnings', () => {
      const banner = buildDataQualityBanner({ missing_info: [] }, { lang: 'EN' });
      expect(banner).toBeNull();
    });

    test('returns banner for incidecoder + version verification without fetch-blocked code', () => {
      const banner = buildDataQualityBanner(
        {
          missing_info: ['incidecoder_source_used'],
          evidence: { missing_info: ['version_verification_needed'] },
        },
        { lang: 'EN' },
      );
      expect(typeof banner).toBe('string');
      expect(banner.toLowerCase()).toContain('incidecoder');
      expect(banner.toLowerCase()).toContain('version');
    });
  });
});
