const {
  createProductIntelBackfillRuntime,
} = require('../src/auroraBff/productIntelBackfillRuntime');

describe('aurora product-intel backfill runtime', () => {
  test('returns disabled decision when async backfill is off', () => {
    const annotateProductIntelKbWriteDecision = jest.fn();
    const runtime = createProductIntelBackfillRuntime({
      PRODUCT_INTEL_KB_ASYNC_BACKFILL_ENABLED: false,
      annotateProductIntelKbWriteDecision,
    });

    const payload = { assessment: { verdict: 'Likely Suitable' } };
    const result = runtime.scheduleProductIntelKbBackfill({ payload });

    expect(result).toEqual({
      attempted: false,
      persisted: false,
      blocked_reason: 'kb_backfill_disabled',
    });
    expect(annotateProductIntelKbWriteDecision).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({
        blocked_reason: 'kb_backfill_disabled',
      }),
    );
  });

  test('returns kb_key_missing when no KB key can be built', () => {
    const annotateProductIntelKbWriteDecision = jest.fn();
    const runtime = createProductIntelBackfillRuntime({
      PRODUCT_INTEL_KB_ASYNC_BACKFILL_ENABLED: true,
      annotateProductIntelKbWriteDecision,
      buildProductIntelKbKey: jest.fn(() => ''),
    });

    const payload = { assessment: { verdict: 'Likely Suitable' } };
    const result = runtime.scheduleProductIntelKbBackfill({ payload });

    expect(result).toEqual({
      attempted: false,
      persisted: false,
      blocked_reason: 'kb_key_missing',
    });
    expect(annotateProductIntelKbWriteDecision).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({
        blocked_reason: 'kb_key_missing',
      }),
    );
  });

  test('does not enqueue write when strict KB policy blocks persistence', () => {
    const scheduleDetachedAsyncJob = jest.fn();
    const runtime = createProductIntelBackfillRuntime({
      PRODUCT_INTEL_KB_ASYNC_BACKFILL_ENABLED: true,
      annotateProductIntelKbWriteDecision: jest.fn(),
      buildProductIntelKbKey: jest.fn(() => 'url:https://brand.example/product-1'),
      annotateProductIntelRelaxedProvenance: jest.fn((value) => value),
      shouldPersistProductIntelKb: jest.fn(() => ({
        attempted: true,
        persisted: false,
        blocked_reason: 'authoritative_source_missing',
        audit_blocked_reason: 'authoritative_source_missing',
        policy: 'strict',
      })),
      scheduleDetachedAsyncJob,
    });

    const result = runtime.scheduleProductIntelKbBackfill({
      productUrl: 'https://brand.example/product-1',
      payload: { assessment: { verdict: 'Likely Suitable' } },
      logger: { debug: jest.fn() },
    });

    expect(result).toEqual({
      attempted: true,
      persisted: false,
      blocked_reason: 'authoritative_source_missing',
      audit_blocked_reason: 'authoritative_source_missing',
      policy: 'strict',
    });
    expect(scheduleDetachedAsyncJob).not.toHaveBeenCalled();
  });

  test('queues async KB write with merged source meta when persistence is allowed', async () => {
    const queuedJobs = [];
    const upsertProductIntelKbEntry = jest.fn().mockResolvedValue(undefined);
    const annotateProductIntelRelaxedProvenance = jest.fn((value) => {
      value.provenance = {
        ...(value.provenance || {}),
        source_chain: ['llm_extraction'],
      };
      return value;
    });

    const runtime = createProductIntelBackfillRuntime({
      PRODUCT_INTEL_KB_ASYNC_BACKFILL_ENABLED: true,
      annotateProductIntelKbWriteDecision: jest.fn(),
      buildProductIntelKbKey: jest.fn(() => 'url:https://brand.example/product-2'),
      annotateProductIntelRelaxedProvenance,
      shouldPersistProductIntelKb: jest.fn(() => ({
        attempted: true,
        persisted: true,
        blocked_reason: null,
        audit_blocked_reason: null,
        policy: 'strict',
      })),
      resolveProductIntelKbKeyQuality: jest.fn(() => 'url'),
      collectProductGuardrailFlags: jest.fn(() => ['guardrail_quality']),
      resolveProductAnalysisConfidenceBand: jest.fn(() => 'high'),
      resolveProductAnalysisQualityBand: jest.fn(() => 'medium'),
      AURORA_KB_WRITE_POLICY: 'strict',
      AURORA_KB_SERVE_POLICY: 'strict',
      AURORA_RULE_RELAX_MODE: 'conservative',
      scheduleDetachedAsyncJob: jest.fn((job) => queuedJobs.push(job)),
      upsertProductIntelKbEntry,
    });

    const payload = {
      assessment: { verdict: 'Likely Suitable' },
      evidence: { science: { key_ingredients: ['Niacinamide'] } },
    };
    const result = runtime.scheduleProductIntelKbBackfill({
      productUrl: 'https://brand.example/product-2',
      payload,
      sourceMeta: {
        competitor_async_enriched: true,
      },
    });

    expect(result).toEqual({
      attempted: true,
      persisted: true,
      blocked_reason: null,
      audit_blocked_reason: null,
      policy: 'strict',
    });
    expect(queuedJobs).toHaveLength(1);

    await queuedJobs[0]();

    expect(upsertProductIntelKbEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        kb_key: 'url:https://brand.example/product-2',
        source: 'url_realtime_product_intel',
        source_meta: expect.objectContaining({
          competitor_async_enriched: true,
          key_quality: 'url',
          kb_write_policy: 'strict',
          kb_serve_policy: 'strict',
          gate_relax_mode: 'conservative',
          confidence_band: 'high',
          quality_grade: 'medium',
          guardrail_flags: ['guardrail_quality'],
          kb_write: expect.objectContaining({
            attempted: true,
            persisted: true,
            blocked_reason: null,
            audit_blocked_reason: null,
            policy: 'strict',
          }),
        }),
        analysis: expect.objectContaining({
          provenance: expect.objectContaining({
            source_chain: ['llm_extraction'],
          }),
        }),
        last_success_at: expect.any(String),
        last_error: null,
      }),
    );
    expect(annotateProductIntelRelaxedProvenance).toHaveBeenCalledTimes(2);
  });
});
