const { createPhotoFallbackRuntime } = require('../src/auroraBff/photoFallbackRuntime');

describe('aurora photo fallback runtime', () => {
  test('normalizes supported failure codes only', () => {
    const runtime = createPhotoFallbackRuntime();
    expect(runtime.normalizePhotoFailureCodeForFallback('download_url_timeout')).toBe('DOWNLOAD_URL_TIMEOUT');
    expect(runtime.normalizePhotoFailureCodeForFallback('unknown_reason')).toBe('');
  });

  test('builds localized fallback action card for quality fail', () => {
    const runtime = createPhotoFallbackRuntime();
    const card = runtime.buildPhotoFallbackActionCard({
      language: 'EN',
      qualityFail: true,
      photosProvided: true,
    });

    expect(card.why_i_cant_analyze[0]).toMatch(/Photo quality failed/i);
    expect(card.retake_guide).toHaveLength(3);
    expect(card.meanwhile_plan).toHaveLength(3);
    expect(card.ask_3_questions).toHaveLength(3);
  });

  test('builds localized fallback action card for missing primary input in CN', () => {
    const runtime = createPhotoFallbackRuntime();
    const card = runtime.buildPhotoFallbackActionCard({
      language: 'CN',
      failureCode: 'MISSING_PRIMARY_INPUT',
      photosProvided: true,
    });

    expect(card.why_i_cant_analyze[0]).toMatch(/缺少 routine\/recent logs/);
    expect(card.why_i_cant_analyze[1]).toMatch(/仅基于问卷\/历史信息/);
  });

  test('renders fallback strategy with sections and notice', () => {
    const runtime = createPhotoFallbackRuntime();
    const strategy = runtime.renderPhotoFallbackStrategy({
      language: 'EN',
      photoNotice: 'Based on your answers only (photo not analyzed).',
      actionCard: runtime.buildPhotoFallbackActionCard({
        language: 'EN',
        failureCode: 'DOWNLOAD_URL_TIMEOUT',
        photosProvided: true,
      }),
    });

    expect(strategy).toMatch(/Based on your answers only/);
    expect(strategy).toMatch(/Why I can't analyze/);
    expect(strategy).toMatch(/Retake guide/);
    expect(strategy).toMatch(/Meanwhile plan/);
    expect(strategy).toMatch(/Ask-3 questions/);
  });
});
