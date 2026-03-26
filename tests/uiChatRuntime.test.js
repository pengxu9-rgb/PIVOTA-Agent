const {
  loadUiChatToolSchema,
  registerUiChatRuntime,
} = require('../src/uiChatRuntime');

describe('uiChatRuntime', () => {
  test('loadUiChatToolSchema reads public tool contract fields', () => {
    const fsModule = {
      readFileSync: jest.fn(() =>
        JSON.stringify({
          name: 'pivota_shopping_tool',
          description: 'desc',
          parameters: { type: 'object' },
          ignored: true,
        }),
      ),
    };

    expect(loadUiChatToolSchema({ fsModule, schemaPath: '/tmp/tool-schema.json' })).toEqual({
      name: 'pivota_shopping_tool',
      description: 'desc',
      parameters: { type: 'object' },
    });
    expect(fsModule.readFileSync).toHaveBeenCalledWith('/tmp/tool-schema.json', 'utf8');
  });

  test('registerUiChatRuntime wires client, gateway wrapper, agent, and route', async () => {
    const loadToolSchema = jest.fn(() => ({ name: 'pivota_shopping_tool' }));
    const getUiChatLlmClient = jest.fn();
    const createGetUiChatLlmClientImpl = jest.fn(() => getUiChatLlmClient);
    const callPivotaToolViaGatewayImpl = jest.fn().mockResolvedValue({ ok: true });
    const runAgentWithTools = jest.fn();
    const createRunAgentWithToolsImpl = jest.fn(() => runAgentWithTools);
    const registerUiChatRouteImpl = jest.fn();
    const app = {};
    const logger = { info: jest.fn() };
    const axiosClient = {};

    const runtime = registerUiChatRuntime({
      app,
      logger,
      axiosClient,
      gatewayUrl: 'http://gateway.test/invoke',
      maxTaskPollAttempts: 7,
      taskPollIntervalMs: 250,
      timeoutMs: 9999,
      maxAgentStepsPerTurn: 5,
      maxToolCallsPerTurn: 6,
      maxTotalRuntimeMs: 7000,
      maxToolLoopDuplicates: 2,
      maxContextMessages: 12,
      maxToolContentChars: 2048,
      loadToolSchema,
      createGetUiChatLlmClientImpl,
      callPivotaToolViaGatewayImpl,
      createRunAgentWithToolsImpl,
      registerUiChatRouteImpl,
    });

    expect(loadToolSchema).toHaveBeenCalledTimes(1);
    expect(createGetUiChatLlmClientImpl).toHaveBeenCalledWith({ logger });
    expect(createRunAgentWithToolsImpl).toHaveBeenCalledWith({
      getUiChatLlmClient,
      uiChatToolSchema: { name: 'pivota_shopping_tool' },
      callPivotaToolViaGateway: expect.any(Function),
      logger,
      maxAgentStepsPerTurn: 5,
      maxToolCallsPerTurn: 6,
      maxTotalRuntimeMs: 7000,
      maxToolLoopDuplicates: 2,
      maxContextMessages: 12,
      maxToolContentChars: 2048,
    });
    expect(registerUiChatRouteImpl).toHaveBeenCalledWith({
      app,
      runAgentWithTools,
      logger,
    });

    await expect(runtime.callPivotaToolViaGateway({ operation: 'find_products_multi' })).resolves.toEqual({
      ok: true,
    });
    expect(callPivotaToolViaGatewayImpl).toHaveBeenCalledWith({
      args: { operation: 'find_products_multi' },
      gatewayUrl: 'http://gateway.test/invoke',
      axiosClient,
      logger,
      maxTaskPollAttempts: 7,
      taskPollIntervalMs: 250,
      timeoutMs: 9999,
    });
  });
});
