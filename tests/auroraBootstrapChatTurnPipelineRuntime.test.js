const {
  createChatTurnPipelineRuntimeBundle,
} = require('../src/auroraBff/bootstrapChatTurnPipelineRuntime');

describe('createChatTurnPipelineRuntimeBundle', () => {
  test('assembles turn-pipeline and upstream chat runtimes behind one owner', () => {
    const bundle = createChatTurnPipelineRuntimeBundle({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

    expect(typeof bundle.chatFitCheckRuntime.buildFitCheckCards).toBe('function');
    expect(typeof bundle.chatFollowupRuntime.maybeBuildAnalysisFollowupEnvelope).toBe('function');
    expect(typeof bundle.chatDerivedCardsRuntime.prepareUpstreamDerivedCards).toBe('function');
    expect(typeof bundle.chatClarificationRuntime.deriveUpstreamClarification).toBe('function');
    expect(typeof bundle.chatUpstreamEnvelopeRuntime.buildUpstreamEnvelope).toBe('function');
    expect(typeof bundle.chatUpstreamResponseRuntime.buildUpstreamResponseEnvelope).toBe('function');
    expect(typeof bundle.chatUpstreamRequestRuntime.requestUpstream).toBe('function');
    expect(typeof bundle.chatUpstreamTurnRuntime.resolveUpstreamTurn).toBe('function');
    expect(typeof bundle.chatTurnPipelineRuntime.resolveChatTurnPipeline).toBe('function');
  });
});
