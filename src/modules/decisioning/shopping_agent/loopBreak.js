const UI_CHAT_SCENARIO_OPTIONS = [
  {
    key: 'date',
    zh: '约会',
    en: 'date night',
    aliases: ['约会', '데이트', 'date', 'date night', 'romantic'],
  },
  {
    key: 'work',
    zh: '通勤上班',
    en: 'work',
    aliases: ['上班', '通勤', '工作', 'office', 'work'],
  },
  {
    key: 'party',
    zh: '派对',
    en: 'party',
    aliases: ['派对', '聚会', 'party', 'night out'],
  },
  {
    key: 'everyday',
    zh: '日常',
    en: 'everyday',
    aliases: ['日常', '每天', 'everyday', 'daily'],
  },
];

const UI_CHAT_SCENARIO_CLARIFY_REASON_CODES = new Set([
  'scenario_missing',
  'scenario_needed',
  'use_case_missing',
]);

function uiChatNormalizeText(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function uiChatFindLatestScenarioSelection(messages) {
  const items = Array.isArray(messages) ? messages : [];
  for (let idx = items.length - 1; idx >= 0; idx -= 1) {
    const message = items[idx];
    if (String(message?.role || '').trim().toLowerCase() !== 'user') continue;
    const text = String(message?.content || '').trim();
    if (!text) continue;
    const normalized = uiChatNormalizeText(text);
    for (const option of UI_CHAT_SCENARIO_OPTIONS) {
      const matched = option.aliases.some((alias) => uiChatNormalizeText(alias) === normalized);
      if (matched) return { option, text };
    }
  }
  return null;
}

function uiChatFindLatestShoppingIntent(messages) {
  const items = Array.isArray(messages) ? messages : [];
  const scenarioSelection = uiChatFindLatestScenarioSelection(items);
  for (let idx = items.length - 1; idx >= 0; idx -= 1) {
    const message = items[idx];
    if (String(message?.role || '').trim().toLowerCase() !== 'user') continue;
    const text = String(message?.content || '').trim();
    if (!text) continue;
    if (scenarioSelection && uiChatNormalizeText(text).length <= 8) continue;
    return { text };
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
  return String(
    result?.metadata?.search_trace?.final_decision ||
      result?.search_trace?.final_decision ||
      result?.final_decision ||
      '',
  ).trim();
}

function uiChatGetClarificationReason(result) {
  return String(
    result?.clarification?.reason_code ||
      result?.metadata?.clarification_reason_code ||
      '',
  )
    .trim()
    .toLowerCase();
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

module.exports = {
  UI_CHAT_SCENARIO_OPTIONS,
  UI_CHAT_SCENARIO_CLARIFY_REASON_CODES,
  uiChatNormalizeText,
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
};
