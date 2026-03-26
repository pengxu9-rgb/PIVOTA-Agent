const UI_CHAT_SCENARIO_OPTIONS = [
  {
    key: 'commute',
    zh: '通勤/上班',
    en: 'commute/work',
    aliases: ['通勤', '上班', 'commute', 'work'],
  },
  {
    key: 'date',
    zh: '约会',
    en: 'date night',
    aliases: ['约会', 'date', 'date night', 'datenight'],
  },
  {
    key: 'travel',
    zh: '出差/旅行',
    en: 'business trip/travel',
    aliases: ['出差', '旅行', 'travel', 'business trip', 'trip'],
  },
  {
    key: 'outdoor',
    zh: '户外/徒步',
    en: 'hiking/outdoor',
    aliases: ['户外', '徒步', '登山', 'hiking', 'outdoor', 'trekking'],
  },
];

const UI_CHAT_SHOPPING_INTENT_RE =
  /(推荐|商品|买|购买|清单|套装|口红|粉底|化妆|刷|护肤|品牌|预算|travel|hiking|leash|products?|recommend|buy|shopping|gift|skincare|makeup)/i;

const UI_CHAT_SCENARIO_CLARIFY_REASON_CODES = new Set([
  'CLARIFY_SCENARIO',
  'CLARIFY_AMBIGUOUS_QUERY',
]);

function uiChatNormalizeText(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

function uiChatExtractText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((item) => (item && typeof item === 'object' ? item.text : ''))
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  return '';
}

function uiChatParseScenarioSelection(text) {
  const normalized = uiChatNormalizeText(text);
  if (!normalized) return null;
  for (const option of UI_CHAT_SCENARIO_OPTIONS) {
    for (const alias of option.aliases) {
      const aliasNorm = uiChatNormalizeText(alias);
      if (!aliasNorm) continue;
      if (normalized === aliasNorm || normalized.includes(aliasNorm)) {
        return option;
      }
    }
  }
  return null;
}

function uiChatFindLatestScenarioSelection(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const text = uiChatExtractText(message);
    const option = uiChatParseScenarioSelection(text);
    if (option) return { option, index, text };
  }
  return null;
}

function uiChatFindLatestShoppingIntent(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const text = uiChatExtractText(message);
    if (!text || !UI_CHAT_SHOPPING_INTENT_RE.test(text)) continue;
    const scenarioSelection = uiChatParseScenarioSelection(text);
    if (scenarioSelection && uiChatNormalizeText(text).length <= 8) continue;
    return { text, index };
  }
  return null;
}

function uiChatGetFindProductsQuery(args) {
  return String(args?.payload?.search?.query || '').trim();
}

function uiChatIsFindProductsMultiOperation(args) {
  return String(args?.operation || '').trim() === 'find_products_multi';
}

function uiChatGetFinalDecision(result) {
  const traceDecision = result?.metadata?.search_trace?.final_decision;
  if (typeof traceDecision === 'string' && traceDecision.trim()) return traceDecision.trim();
  const decision = result?.metadata?.search_decision?.final_decision;
  if (typeof decision === 'string' && decision.trim()) return decision.trim();
  return '';
}

function uiChatGetClarificationReason(result) {
  const reason = result?.clarification?.reason_code;
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  const reasonCodes = result?.metadata?.search_trace?.reason_codes;
  if (Array.isArray(reasonCodes)) {
    const hit = reasonCodes.find((code) => UI_CHAT_SCENARIO_CLARIFY_REASON_CODES.has(String(code || '')));
    if (hit) return String(hit);
  }
  return '';
}

function uiChatIsScenarioClarification(result) {
  const finalDecision = uiChatGetFinalDecision(result);
  if (finalDecision !== 'clarify') return false;
  const reason = uiChatGetClarificationReason(result);
  if (UI_CHAT_SCENARIO_CLARIFY_REASON_CODES.has(reason)) return true;
  const question = String(result?.clarification?.question || '').trim();
  if (!question) return false;
  return /场景|scenario|prioritize|哪一类|which/i.test(question);
}

function uiChatBuildLoopBreakQuery({ shoppingText, scenarioOption }) {
  if (!shoppingText || !scenarioOption) return '';
  const base = String(shoppingText || '').trim();
  if (!base) return '';
  const hasZh = /[\u4e00-\u9fff]/.test(base);
  const suffix = hasZh ? ` 使用场景：${scenarioOption.zh}` : ` scenario: ${scenarioOption.en}`;
  const normalizedBase = uiChatNormalizeText(base);
  const normalizedScenarioZh = uiChatNormalizeText(scenarioOption.zh);
  const normalizedScenarioEn = uiChatNormalizeText(scenarioOption.en);
  if (normalizedBase.includes(normalizedScenarioZh) || normalizedBase.includes(normalizedScenarioEn)) {
    return base;
  }
  return `${base}${suffix}`.trim();
}

function uiChatBuildLoopBreakRetryArgs(args, messages, toolResult) {
  if (!uiChatIsFindProductsMultiOperation(args)) return null;
  if (!uiChatIsScenarioClarification(toolResult)) return null;
  const scenarioSelection = uiChatFindLatestScenarioSelection(messages);
  if (!scenarioSelection) return null;
  const shoppingIntent = uiChatFindLatestShoppingIntent(messages);
  if (!shoppingIntent) return null;
  const currentQuery = uiChatGetFindProductsQuery(args);
  const nextQuery = uiChatBuildLoopBreakQuery({
    shoppingText: shoppingIntent.text,
    scenarioOption: scenarioSelection.option,
  });
  if (!nextQuery) return null;
  if (uiChatNormalizeText(nextQuery) === uiChatNormalizeText(currentQuery)) return null;
  const nextArgs = JSON.parse(JSON.stringify(args || {}));
  if (!nextArgs.payload || typeof nextArgs.payload !== 'object') nextArgs.payload = {};
  if (!nextArgs.payload.search || typeof nextArgs.payload.search !== 'object') nextArgs.payload.search = {};
  nextArgs.payload.search.query = nextQuery;
  nextArgs.metadata = {
    ...(nextArgs.metadata && typeof nextArgs.metadata === 'object' ? nextArgs.metadata : {}),
    ui_chat_loop_break: 'scenario_selection_retry',
    ui_chat_loop_break_scenario: scenarioSelection.option.key,
  };
  return {
    nextArgs,
    nextQuery,
    scenario: scenarioSelection.option.key,
    baseQuery: shoppingIntent.text,
  };
}

function uiChatShouldUseRetryResult(initialResult, retryResult) {
  if (!retryResult || typeof retryResult !== 'object') return false;
  if (Array.isArray(retryResult.products) && retryResult.products.length > 0) return true;
  const initialDecision = uiChatGetFinalDecision(initialResult);
  const retryDecision = uiChatGetFinalDecision(retryResult);
  if (retryDecision && retryDecision !== initialDecision) return true;
  return false;
}

function createRunAgentWithTools({
  getUiChatLlmClient,
  uiChatToolSchema,
  callPivotaToolViaGateway,
  logger,
  maxAgentStepsPerTurn,
  maxToolCallsPerTurn,
  maxTotalRuntimeMs,
  maxToolLoopDuplicates,
  maxContextMessages,
  maxToolContentChars,
  nowMs = () => Date.now(),
} = {}) {
  return async function runAgentWithTools(messages) {
    const { client: llmClient, model: llmModel } = getUiChatLlmClient();
    const startTs = nowMs();
    let steps = 0;
    let totalToolCalls = 0;
    const recentToolCalls = [];

    function withinRuntimeBudget() {
      if (!maxTotalRuntimeMs || maxTotalRuntimeMs <= 0) return true;
      return nowMs() - startTs < maxTotalRuntimeMs;
    }

    function clampContext() {
      if (!maxContextMessages || maxContextMessages <= 0) return;
      if (!Array.isArray(messages)) return;
      if (messages.length <= maxContextMessages) return;

      const systemMessages = messages.filter((m) => m.role === 'system');
      const nonSystem = messages.filter((m) => m.role !== 'system');
      const keepNonSystem = nonSystem.slice(-Math.max(maxContextMessages - systemMessages.length, 0));
      messages.length = 0;
      messages.push(...systemMessages, ...keepNonSystem);
    }

    function budgetExceededMessage(reason) {
      return {
        role: 'assistant',
        content:
          reason === 'runtime'
            ? 'I used up my safety time budget trying to complete this request. Please try again with a shorter or more specific question.'
            : 'I hit an internal safety limit while trying to complete this request. Please rephrase or narrow down what you need.',
      };
    }

    while (true) {
      if (!withinRuntimeBudget()) {
        logger.warn({ steps, totalToolCalls }, 'Agent runtime budget exceeded');
        return budgetExceededMessage('runtime');
      }
      if (maxAgentStepsPerTurn > 0 && steps >= maxAgentStepsPerTurn) {
        logger.warn({ steps, totalToolCalls }, 'Agent step budget exceeded');
        return budgetExceededMessage('steps');
      }

      const completion = await llmClient.chat.completions.create({
        model: llmModel,
        messages,
        tools: [
          {
            type: 'function',
            function: uiChatToolSchema,
          },
        ],
        tool_choice: 'auto',
      });

      const msg = completion.choices[0].message;
      steps += 1;

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        if (maxToolCallsPerTurn > 0 && totalToolCalls + msg.tool_calls.length > maxToolCallsPerTurn) {
          logger.warn(
            { totalToolCalls, requestedCalls: msg.tool_calls.length },
            'Tool call budget exceeded in this turn',
          );
          return budgetExceededMessage('tools');
        }

        for (const toolCall of msg.tool_calls) {
          if (toolCall.type !== 'function') continue;
          const { name, arguments: argStr } = toolCall.function;
          if (name !== 'pivota_shopping_tool') continue;

          let args;
          try {
            args = JSON.parse(argStr || '{}');
          } catch (e) {
            logger.error({ err: e, argStr }, 'Failed to parse tool args');
            throw e;
          }

          logger.info({ tool: name, args }, 'Calling Pivota tool via gateway');

          const toolKey = JSON.stringify({ name, args });
          recentToolCalls.push(toolKey);
          if (recentToolCalls.length > 16) {
            recentToolCalls.shift();
          }
          const duplicates = recentToolCalls.filter((k) => k === toolKey).length;
          if (maxToolLoopDuplicates > 0 && duplicates >= maxToolLoopDuplicates) {
            logger.warn(
              { name, duplicates },
              'Detected potential tool loop (same tool+args repeated)',
            );
            return {
              role: 'assistant',
              content:
                'I seem to be calling the same shopping operation repeatedly without making progress. ' +
                'Please adjust your request or try a different query.',
            };
          }

          let toolResult = await callPivotaToolViaGateway(args);

          const loopBreakRetry = uiChatBuildLoopBreakRetryArgs(args, messages, toolResult);
          if (loopBreakRetry) {
            logger.info(
              {
                scenario: loopBreakRetry.scenario,
                baseQuery: loopBreakRetry.baseQuery,
                nextQuery: loopBreakRetry.nextQuery,
              },
              'Applying UI chat clarify loop-break retry',
            );
            try {
              const retried = await callPivotaToolViaGateway(loopBreakRetry.nextArgs);
              if (uiChatShouldUseRetryResult(toolResult, retried)) {
                toolResult = retried;
                if (toolResult && typeof toolResult === 'object') {
                  toolResult.metadata = {
                    ...(toolResult.metadata && typeof toolResult.metadata === 'object'
                      ? toolResult.metadata
                      : {}),
                    ui_chat_loop_break: {
                      applied: true,
                      scenario: loopBreakRetry.scenario,
                      base_query: loopBreakRetry.baseQuery,
                      enriched_query: loopBreakRetry.nextQuery,
                    },
                  };
                }
              }
            } catch (retryError) {
              logger.warn(
                {
                  err: retryError?.message || String(retryError),
                  scenario: loopBreakRetry.scenario,
                  nextQuery: loopBreakRetry.nextQuery,
                },
                'UI chat clarify loop-break retry failed',
              );
            }
          }

          messages.push(msg);
          let content = JSON.stringify(toolResult);
          if (maxToolContentChars > 0 && content.length > maxToolContentChars) {
            content = content.slice(0, maxToolContentChars) + '… [truncated]';
          }
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name,
            content,
          });
          totalToolCalls += 1;
          clampContext();
        }
        continue;
      }

      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
      if (lastAssistant && lastAssistant.content && lastAssistant.content === msg.content) {
        logger.warn('Detected repeated identical assistant clarification message');
        return {
          role: 'assistant',
          content:
            'I just repeated myself trying to clarify your request and am not making progress. ' +
            'Please rephrase or provide different details so I can help.',
        };
      }

      return msg;
    }
  };
}

module.exports = {
  UI_CHAT_SCENARIO_OPTIONS,
  UI_CHAT_SHOPPING_INTENT_RE,
  UI_CHAT_SCENARIO_CLARIFY_REASON_CODES,
  uiChatNormalizeText,
  uiChatExtractText,
  uiChatParseScenarioSelection,
  uiChatFindLatestScenarioSelection,
  uiChatFindLatestShoppingIntent,
  uiChatGetFindProductsQuery,
  uiChatIsFindProductsMultiOperation,
  uiChatGetFinalDecision,
  uiChatGetClarificationReason,
  uiChatIsScenarioClarification,
  uiChatBuildLoopBreakQuery,
  uiChatBuildLoopBreakRetryArgs,
  uiChatShouldUseRetryResult,
  createRunAgentWithTools,
};
