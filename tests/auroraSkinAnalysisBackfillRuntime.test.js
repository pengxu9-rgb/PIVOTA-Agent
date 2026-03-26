const {
  createSkinAnalysisBackfillRuntime,
} = require('../src/auroraBff/skinAnalysisBackfillRuntime');

describe('aurora skin analysis backfill runtime', () => {
  test('returns disabled decision when async backfill is off', () => {
    const saveDiagnosisArtifact = jest.fn();
    const runtime = createSkinAnalysisBackfillRuntime({
      PRODUCT_INTEL_KB_ASYNC_BACKFILL_ENABLED: false,
      saveDiagnosisArtifact,
      createArtifactId: jest.fn(() => 'da_disabled'),
    });

    expect(runtime.scheduleSkinAnalysisKbBackfill({ analysisSummaryPayload: { analysis: {} } })).toEqual({
      attempted: false,
      queued: false,
      blocked_reason: 'kb_backfill_disabled',
    });
    expect(saveDiagnosisArtifact).not.toHaveBeenCalled();
  });

  test('returns analysis_summary_missing when payload is unusable', () => {
    const saveDiagnosisArtifact = jest.fn();
    const runtime = createSkinAnalysisBackfillRuntime({
      PRODUCT_INTEL_KB_ASYNC_BACKFILL_ENABLED: true,
      saveDiagnosisArtifact,
      createArtifactId: jest.fn(() => 'da_missing'),
    });

    expect(runtime.scheduleSkinAnalysisKbBackfill({ analysisSummaryPayload: { quality_report: {} } })).toEqual({
      attempted: false,
      queued: false,
      blocked_reason: 'analysis_summary_missing',
    });
    expect(saveDiagnosisArtifact).not.toHaveBeenCalled();
  });

  test('queues async diagnosis artifact persistence with normalized metadata', async () => {
    const queued = [];
    const saveDiagnosisArtifact = jest.fn().mockResolvedValue({ ok: true });
    const runtime = createSkinAnalysisBackfillRuntime({
      PRODUCT_INTEL_KB_ASYNC_BACKFILL_ENABLED: true,
      AURORA_RULE_RELAX_MODE: 'conservative',
      createArtifactId: jest.fn(() => 'da_123'),
      saveDiagnosisArtifact,
      setImmediateImpl: (fn) => queued.push(fn),
    });

    const result = runtime.scheduleSkinAnalysisKbBackfill({
      ctx: {
        request_id: 'req_1',
        trace_id: 'trace_1',
        aurora_uid: 'guest_1',
        brief_id: 'brief_1',
      },
      identity: {
        userId: 'user_1',
      },
      analysisMeta: {
        pipeline_version: 'v2',
      },
      analysisSummaryPayload: {
        analysis: {
          overall_confidence: {
            score: 0.81,
          },
        },
        quality_report: {
          photo_quality: {
            grade: 'PASS',
          },
          llm: {
            vision: {
              reasons: ['vision_timeout', 'VISION_TIMEOUT'],
            },
            report: {
              reasons: ['report_schema_invalid'],
            },
          },
        },
      },
    });

    expect(result).toEqual({
      attempted: true,
      queued: true,
      blocked_reason: null,
      artifact_type: 'skin_analysis_kb_snapshot_v1',
    });
    expect(queued).toHaveLength(1);

    await queued[0]();

    expect(saveDiagnosisArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        auroraUid: 'guest_1',
        userId: 'user_1',
        sessionId: 'brief_1',
        artifactId: 'da_123',
        artifact: expect.objectContaining({
          artifact_id: 'da_123',
          artifact_type: 'skin_analysis_kb_snapshot_v1',
          overall_confidence: {
            score: 0.81,
            level: 'high',
          },
          provenance: expect.objectContaining({
            confidence_band: 'high',
            quality_grade: 'pass',
            guardrail_flags: ['vision_timeout', 'report_schema_invalid'],
            gate_relax_mode: 'conservative',
            model_provenance: {
              pipeline_version: 'v2',
            },
          }),
        }),
      }),
    );
  });

  test('logs async persistence failure without throwing', async () => {
    const queued = [];
    const warn = jest.fn();
    const runtime = createSkinAnalysisBackfillRuntime({
      PRODUCT_INTEL_KB_ASYNC_BACKFILL_ENABLED: true,
      createArtifactId: jest.fn(() => 'da_warn'),
      saveDiagnosisArtifact: jest.fn().mockRejectedValue(new Error('db offline')),
      setImmediateImpl: (fn) => queued.push(fn),
    });

    runtime.scheduleSkinAnalysisKbBackfill({
      ctx: {
        request_id: 'req_warn',
        trace_id: 'trace_warn',
      },
      logger: { warn },
      analysisSummaryPayload: {
        analysis: {},
      },
    });

    await queued[0]();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: 'db offline',
        request_id: 'req_warn',
        trace_id: 'trace_warn',
      }),
      'aurora bff: skin analysis async kb backfill failed',
    );
  });
});
