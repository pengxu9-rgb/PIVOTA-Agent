const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTravelKbKey } = require('../src/auroraBff/travelKbStore');
const {
  evaluateTravelKbBackfill,
  buildTravelKbUpsertEntry,
} = require('../src/auroraBff/travelKbPolicy');
const { calibrateTravelReadinessWithLlm } = require('../src/auroraBff/travelLlmCalibrator');

function buildCompleteTravelReadiness() {
  return {
    destination_context: {
      destination: 'Paris',
      start_date: '2026-03-10',
      end_date: '2026-03-15',
      env_source: 'weather_api',
      epi: 72,
    },
    delta_vs_home: {
      temperature: { home: 18, destination: 11, delta: -7, unit: 'C' },
      humidity: { home: 56, destination: 76, delta: 20, unit: '%' },
      uv: { home: 4, destination: 7, delta: 3, unit: '' },
      summary_tags: ['colder', 'higher_uv'],
      baseline_status: 'ok',
    },
    adaptive_actions: [{ why: 'UV higher', what_to_do: 'Reapply SPF' }],
    personal_focus: [{ focus: 'Barrier', why: 'Sensitive', what_to_do: 'Use richer moisturizer' }],
    jetlag_sleep: {
      tz_home: 'America/Los_Angeles',
      tz_destination: 'Europe/Paris',
      hours_diff: 9,
      risk_level: 'high',
      sleep_tips: ['Shift sleep earlier before trip'],
      mask_tips: ['Use recovery mask at night'],
    },
    shopping_preview: {
      products: [
        { name: 'Barrier Cream', category: 'Moisturizer', reasons: ['repair'] },
        { name: 'UV Shield', category: 'Sunscreen', reasons: ['UV defense'] },
      ],
      brand_candidates: [
        { brand: 'Bioderma', match_status: 'kb_verified', reason: 'Barrier-friendly SKUs' },
        { brand: 'UnknownX', match_status: 'invalid_status', reason: 'Fallback status expected' },
      ],
      buying_channels: ['beauty_retail', 'pharmacy'],
    },
    confidence: {
      level: 'medium',
      score: 0.8,
      missing_inputs: ['current_routine'],
      improve_by: ['Add AM/PM routine'],
    },
  };
}

test('travel KB key normalization: destination+month+lang', () => {
  const key = buildTravelKbKey({
    destination: ' Paris, FR ',
    monthBucket: '03',
    lang: 'cn',
  });
  assert.equal(key, 'paris_fr:3:CN');
  assert.equal(buildTravelKbKey({ destination: '', monthBucket: 3, lang: 'EN' }), null);
});

test('travel KB backfill policy: eligibility and confidence gate', () => {
  const readiness = buildCompleteTravelReadiness();
  const eligible = evaluateTravelKbBackfill({
    travelReadiness: readiness,
    minConfidence: 0.72,
    hasSafetyConflict: false,
  });
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.reason, 'eligible');
  assert.ok(eligible.confidence_score >= 0.72);

  const lowConfidence = evaluateTravelKbBackfill({
    travelReadiness: {
      ...readiness,
      confidence: { ...readiness.confidence, level: 'low', score: 0.5 },
    },
    minConfidence: 0.72,
    hasSafetyConflict: false,
  });
  assert.equal(lowConfidence.eligible, false);
  assert.equal(lowConfidence.reason, 'low_confidence');
});

test('travel KB upsert entry builder: maps fields and normalizes brand status', () => {
  const readiness = buildCompleteTravelReadiness();
  const entry = buildTravelKbUpsertEntry({
    destination: 'Paris',
    monthBucket: 3,
    lang: 'EN',
    travelReadiness: readiness,
    confidenceScore: 0.86,
    qualityFlags: { structured_complete: true },
    sourceMeta: { stage: 'travel_readiness_calibration_v1' },
    ttlDays: 45,
    nowMs: Date.parse('2026-02-24T00:00:00.000Z'),
  });

  assert.ok(entry);
  assert.equal(entry.kb_key, 'paris:3:EN');
  assert.equal(entry.destination_norm, 'paris');
  assert.equal(entry.month_bucket, 3);
  assert.equal(entry.lang, 'EN');
  assert.equal(Array.isArray(entry.adaptive_actions), true);
  assert.equal(Array.isArray(entry.product_type_recos), true);
  assert.equal(Array.isArray(entry.local_brand_candidates), true);
  assert.equal(entry.local_brand_candidates[0].match_status, 'kb_verified');
  assert.equal(entry.local_brand_candidates[1].match_status, 'llm_only');
  assert.ok(typeof entry.expires_at === 'string' && entry.expires_at.includes('T'));
});

test('travel LLM calibrator: skip_no_client fallback keeps baseline', async () => {
  const baseline = buildCompleteTravelReadiness();
  const result = await calibrateTravelReadinessWithLlm({
    openaiClient: null,
    language: 'EN',
    travelLlmInput: { destination: 'Paris' },
    baseTravelReadiness: baseline,
    timeoutMs: 200,
    maxRetries: 1,
  });

  assert.equal(result.stage, 'travel_readiness_calibration_v1');
  assert.equal(result.used, false);
  assert.equal(result.outcome, 'skip_no_client');
  assert.deepEqual(result.travel_readiness, baseline);
});

test('travel LLM calibrator: parses patch and deep-merges shopping brand candidates', async () => {
  const baseline = buildCompleteTravelReadiness();
  const mockClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  travel_readiness_patch: {
                    adaptive_actions: [{ why: 'Windier', what_to_do: 'Use richer cream at night' }],
                    shopping_preview: {
                      brand_candidates: [
                        { brand: 'La Roche-Posay', match_status: 'catalog_verified', reason: 'Catalog hit' },
                        { brand: 'BrandY', match_status: 'bad_value', reason: 'Should become llm_only' },
                      ],
                      buying_channels: ['pharmacy', 'ecommerce', 'invalid_channel'],
                    },
                    confidence: {
                      level: 'high',
                      score: 0.92,
                    },
                  },
                  quality_flags: {
                    structured_complete: true,
                  },
                  source_notes: {
                    reasoning_mode: 'llm_calibration_v1',
                  },
                }),
              },
            },
          ],
        }),
      },
    },
  };

  const result = await calibrateTravelReadinessWithLlm({
    openaiClient: mockClient,
    language: 'EN',
    travelLlmInput: { destination: 'Paris', month_bucket: 3 },
    baseTravelReadiness: baseline,
    timeoutMs: 500,
    maxRetries: 0,
  });

  assert.equal(result.used, true);
  assert.equal(result.outcome, 'call');
  assert.equal(Array.isArray(result.travel_readiness.shopping_preview.brand_candidates), true);
  assert.equal(result.travel_readiness.shopping_preview.brand_candidates[0].match_status, 'catalog_verified');
  assert.equal(result.travel_readiness.shopping_preview.brand_candidates[1].match_status, 'llm_only');
  assert.equal(result.travel_readiness.confidence.level, 'high');
  assert.equal(result.source_meta.reasoning_mode, 'llm_calibration_v1');
});

