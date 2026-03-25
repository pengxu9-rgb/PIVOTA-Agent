const {
  uiChatBuildLoopBreakRetryArgs,
  uiChatBuildLoopBreakQuery,
  uiChatShouldUseRetryResult,
} = require('../src/modules/decisioning/shopping_agent/loopBreak');

describe('Shopping agent loop-break module', () => {
  test('builds scenario-aware retry args from short scenario selection', () => {
    const args = {
      operation: 'find_products_multi',
      payload: {
        search: {
          query: 'serum',
        },
      },
    };

    const messages = [
      { role: 'user', content: '帮我买一款 serum' },
      { role: 'assistant', content: '你更偏哪种场景？' },
      { role: 'user', content: '约会' },
    ];

    const toolResult = {
      clarification: {
        reason_code: 'scenario_missing',
        question: 'Which scenario do you want to prioritize?',
      },
      metadata: {
        search_trace: {
          final_decision: 'clarify',
        },
      },
    };

    const out = uiChatBuildLoopBreakRetryArgs(args, messages, toolResult);
    expect(out).toBeTruthy();
    expect(out.scenario).toBe('date');
    expect(out.baseQuery).toBe('帮我买一款 serum');
    expect(out.nextQuery).toContain('使用场景：约会');
    expect(out.nextArgs.payload.search.query).toContain('使用场景：约会');
    expect(out.nextArgs.metadata.ui_chat_loop_break).toBe('scenario_selection_retry');
  });

  test('does not append duplicate scenario hint and accepts useful retry result', () => {
    expect(
      uiChatBuildLoopBreakQuery({
        shoppingText: 'serum 使用场景：约会',
        scenarioOption: { zh: '约会', en: 'date night' },
      }),
    ).toBe('serum 使用场景：约会');

    expect(
      uiChatShouldUseRetryResult(
        {
          metadata: {
            search_trace: {
              final_decision: 'clarify',
            },
          },
        },
        {
          products: [{ product_id: 'p1' }],
        },
      ),
    ).toBe(true);

    expect(
      uiChatShouldUseRetryResult(
        {
          metadata: {
            search_trace: {
              final_decision: 'clarify',
            },
          },
        },
        {
          metadata: {
            search_trace: {
              final_decision: 'search_returned',
            },
          },
        },
      ),
    ).toBe(true);
  });
});
