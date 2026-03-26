const {
  uiChatBuildLoopBreakRetryArgs,
  uiChatShouldUseRetryResult,
  createRunAgentWithTools,
} = require('../src/uiChatAgent');

describe('uiChatAgent', () => {
  test('uiChatBuildLoopBreakRetryArgs enriches scenario clarifications with latest shopping intent', () => {
    const args = {
      operation: 'find_products_multi',
      payload: { search: { query: '有什么化妆刷推荐吗？' } },
      metadata: { source: 'shopping_agent' },
    };
    const messages = [
      { role: 'user', content: '有什么化妆刷推荐吗？' },
      { role: 'assistant', content: '你更想要什么使用场景？' },
      { role: 'user', content: '出差' },
    ];
    const toolResult = {
      metadata: {
        search_trace: {
          final_decision: 'clarify',
          reason_codes: ['CLARIFY_SCENARIO'],
        },
      },
      clarification: {
        question: '请先告诉我使用场景',
      },
    };

    expect(uiChatBuildLoopBreakRetryArgs(args, messages, toolResult)).toEqual({
      nextArgs: {
        operation: 'find_products_multi',
        payload: {
          search: {
            query: '有什么化妆刷推荐吗？ 使用场景：出差/旅行',
          },
        },
        metadata: {
          source: 'shopping_agent',
          ui_chat_loop_break: 'scenario_selection_retry',
          ui_chat_loop_break_scenario: 'travel',
        },
      },
      nextQuery: '有什么化妆刷推荐吗？ 使用场景：出差/旅行',
      scenario: 'travel',
      baseQuery: '有什么化妆刷推荐吗？',
    });
  });

  test('uiChatShouldUseRetryResult prefers retry results with products or changed decisions', () => {
    expect(
      uiChatShouldUseRetryResult(
        { metadata: { search_trace: { final_decision: 'clarify' } } },
        { products: [{ id: 'p1' }] },
      ),
    ).toBe(true);

    expect(
      uiChatShouldUseRetryResult(
        { metadata: { search_trace: { final_decision: 'clarify' } } },
        { metadata: { search_trace: { final_decision: 'complete' } } },
      ),
    ).toBe(true);

    expect(
      uiChatShouldUseRetryResult(
        { metadata: { search_trace: { final_decision: 'clarify' } } },
        { metadata: { search_trace: { final_decision: 'clarify' } } },
      ),
    ).toBe(false);
  });

  test('createRunAgentWithTools retries clarified shopping queries and returns final assistant message', async () => {
    const completions = [
      {
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'tool_1',
                  type: 'function',
                  function: {
                    name: 'pivota_shopping_tool',
                    arguments: JSON.stringify({
                      operation: 'find_products_multi',
                      payload: {
                        search: {
                          query: '有什么化妆刷推荐吗？',
                        },
                      },
                    }),
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: '这里有几款适合出差携带的化妆刷。',
            },
          },
        ],
      },
    ];
    const create = jest.fn(async () => completions.shift());
    const callPivotaToolViaGateway = jest
      .fn()
      .mockResolvedValueOnce({
        metadata: {
          search_trace: {
            final_decision: 'clarify',
            reason_codes: ['CLARIFY_SCENARIO'],
          },
        },
        clarification: {
          question: '你更想要什么使用场景？',
        },
      })
      .mockResolvedValueOnce({
        products: [{ product_id: 'brush_1' }],
        metadata: {
          search_trace: {
            final_decision: 'complete',
          },
        },
      });
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const runAgentWithTools = createRunAgentWithTools({
      getUiChatLlmClient: () => ({
        client: { chat: { completions: { create } } },
        model: 'gpt-test',
      }),
      uiChatToolSchema: { name: 'pivota_shopping_tool' },
      callPivotaToolViaGateway,
      logger,
      maxAgentStepsPerTurn: 5,
      maxToolCallsPerTurn: 5,
      maxTotalRuntimeMs: 10000,
      maxToolLoopDuplicates: 3,
      maxContextMessages: 20,
      maxToolContentChars: 10000,
      nowMs: (() => {
        let now = 1000;
        return () => {
          now += 10;
          return now;
        };
      })(),
    });
    const messages = [
      { role: 'system', content: 'You are the Pivota Shopping Agent.' },
      { role: 'user', content: '有什么化妆刷推荐吗？' },
      { role: 'assistant', content: '你更想要什么使用场景？' },
      { role: 'user', content: '出差' },
    ];

    await expect(runAgentWithTools(messages)).resolves.toEqual({
      role: 'assistant',
      content: '这里有几款适合出差携带的化妆刷。',
    });

    expect(callPivotaToolViaGateway).toHaveBeenCalledTimes(2);
    expect(callPivotaToolViaGateway.mock.calls[1][0]).toEqual({
      operation: 'find_products_multi',
      payload: {
        search: {
          query: '有什么化妆刷推荐吗？ 使用场景：出差/旅行',
        },
      },
      metadata: {
        ui_chat_loop_break: 'scenario_selection_retry',
        ui_chat_loop_break_scenario: 'travel',
      },
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        scenario: 'travel',
        baseQuery: '有什么化妆刷推荐吗？',
        nextQuery: '有什么化妆刷推荐吗？ 使用场景：出差/旅行',
      }),
      'Applying UI chat clarify loop-break retry',
    );
  });
});
