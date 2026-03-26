const { createSkinDeepeningRuntime } = require('../src/auroraBff/skinDeepeningRuntime');

describe('aurora skin deepening runtime', () => {
  function makeRuntime() {
    return createSkinDeepeningRuntime({
      shouldFireDeepening: jest.fn(({ userReportedSymptoms = [] } = {}) => ({
        fire: Array.isArray(userReportedSymptoms) && userReportedSymptoms.length > 0,
        reason: 'symptoms_present',
      })),
      buildDeepeningSignalsDto: jest.fn((input) => ({
        phase: input.phase,
        question_intent: input.questionIntent,
        reaction_flags: input.reactions.map((item) => String(item).split(/\s+/)[0].toLowerCase()),
        suggested_advice_items: [...(input.watchouts || []), ...(input.twoWeekFocus || [])],
      })),
    });
  }

  test('normalizes prompt version to canonical deepening prompt', () => {
    const runtime = makeRuntime();
    expect(runtime.resolveSkinDeepeningPromptVersion('skin_v3')).toBe('skin_deepening_v2_canonical');
    expect(runtime.resolveSkinDeepeningPromptVersion('foo')).toBe('skin_deepening_v2_canonical');
    expect(runtime.resolveSkinDeepeningPromptVersion('skin_deepening_v2')).toBe('skin_deepening_v2');
  });

  test('extracts deduped symptoms from recent logs', () => {
    const runtime = makeRuntime();
    expect(
      runtime.extractSkinDeepeningSymptoms([
        { reaction: 'stinging', note: 'redness', reactions: ['stinging'], symptoms: ['itching'] },
        { message: 'tightness', notes: 'redness' },
      ]),
    ).toEqual(['stinging', 'redness', 'itching', 'tightness']);
  });

  test('builds products phase when routine is missing', () => {
    const runtime = makeRuntime();
    const result = runtime.buildMainlineDeepeningDto({
      promptVersion: 'skin_v3',
      userRequestedPhoto: true,
      photosProvided: true,
      hasRoutine: false,
      recentLogsSummary: [],
      qualityObject: { grade: 'pass' },
      reportCanonical: { summary_focus: { priority: 'redness' }, watchouts: [], two_week_focus: [] },
    });

    expect(result.phasePlan).toEqual({
      phase: 'products',
      question_intent: 'routine_share',
      reason: 'routine_missing',
    });
    expect(result.dto.question_intent).toBe('routine_share');
    expect(result.promptVersion).toBe('skin_deepening_v2_canonical');
  });

  test('builds reactions phase when symptoms require deepening', () => {
    const runtime = makeRuntime();
    const result = runtime.buildMainlineDeepeningDto({
      promptVersion: 'skin_v3',
      userRequestedPhoto: true,
      photosProvided: true,
      hasRoutine: true,
      routineCandidate: 'retinoid pm',
      recentLogsSummary: [{ reaction: 'stinging after serum' }],
      qualityObject: { grade: 'pass' },
      reportCanonical: {
        summary_focus: { priority: 'barrier' },
        watchouts: ['pause_if_stinging'],
        two_week_focus: ['confirm_tolerance'],
        insights: [{ cue: 'redness', region: 'cheeks', severity: 'mild' }],
      },
    });

    expect(result.phasePlan.phase).toBe('reactions');
    expect(result.dto.question_intent).toBe('reaction_check');
    expect(result.dto.suggested_advice_items).toEqual(['pause_if_stinging', 'confirm_tolerance']);
  });
});
