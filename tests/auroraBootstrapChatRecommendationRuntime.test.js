const {
  createChatRecommendationRuntimeBundle,
} = require('../src/auroraBff/bootstrapChatRecommendationRuntime');

describe('createChatRecommendationRuntimeBundle', () => {
  test('assembles reco and routine chat runtimes behind one owner', () => {
    const bundle = createChatRecommendationRuntimeBundle({
      logger: { info: jest.fn(), warn: jest.fn() },
      chatProfileContinuationRuntime: {
        maybeBuildProfileContinuationEnvelope: jest.fn(),
      },
    });

    expect(typeof bundle.chatRecoPreludeRuntime.prepareRecoRequestPrelude).toBe('function');
    expect(typeof bundle.chatRecoEntryRuntime.prepareRecoEntry).toBe('function');
    expect(typeof bundle.chatRecoHandoffRuntime.buildRoutineRecoEnvelope).toBe('function');
    expect(typeof bundle.chatRoutineRecoRuntime.resolveRoutineRecoEnvelope).toBe('function');
    expect(typeof bundle.chatRoutineGateRuntime.resolveRoutineGate).toBe('function');
    expect(typeof bundle.chatRecoResponseRuntime.finalizeRecoSuccess).toBe('function');
    expect(typeof bundle.chatRecoResolveRuntime.resolveRecoEnvelope).toBe('function');
    expect(typeof bundle.chatRecoArtifactRuntime.prepareRecoArtifactContext).toBe('function');
    expect(typeof bundle.chatRecommendationRuntime.maybeBuildRecommendationEnvelope).toBe('function');
    expect(typeof bundle.chatRecommendationFlowRuntime.resolveRecommendationFlow).toBe('function');
  });
});
