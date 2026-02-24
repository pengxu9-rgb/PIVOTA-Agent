function normalizeLanguage(value) {
  return String(value || 'en')
    .trim()
    .toLowerCase();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeSlot(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return ['scenario', 'category', 'budget', 'brand'].includes(normalized) ? normalized : '';
}

function hasSlotResolved(slotState, key) {
  const normalized = normalizeSlot(key);
  if (!normalized) return false;
  const raw = slotState?.resolved_slots?.[normalized];
  return normalizeText(raw).length > 0;
}

function inferScenarioLabel({ language, slotState, intent }) {
  const lang = normalizeLanguage(language);
  const scenarioFromContext = normalizeText(slotState?.resolved_slots?.scenario);
  const scenario = scenarioFromContext || normalizeText(intent?.scenario?.name);
  if (!scenario || ['general', 'browse', 'discovery', 'default'].includes(scenario.toLowerCase())) {
    return '';
  }
  if (lang === 'zh') {
    const map = {
      date: '约会',
      commute: '通勤',
      travel: '旅行',
      outdoor: '户外',
    };
    return map[scenario.toLowerCase()] || scenario;
  }
  return scenario;
}

function buildContextPrefix({ language, scenarioLabel }) {
  if (!scenarioLabel) return '';
  const lang = normalizeLanguage(language);
  if (lang === 'zh') return `已按「${scenarioLabel}」场景先筛一轮。`;
  if (lang === 'ja') return `まず「${scenarioLabel}」シナリオを優先して絞り込みました。`;
  if (lang === 'fr') return `J’ai d’abord priorisé le scénario « ${scenarioLabel} ».`;
  if (lang === 'es') return `Primero prioricé el escenario « ${scenarioLabel} ».`;
  return `I prioritized the "${scenarioLabel}" scenario first.`;
}

function buildSlotFollowUp({ language, slot }) {
  const lang = normalizeLanguage(language);
  if (!slot) return '';
  if (lang === 'zh') {
    if (slot === 'category') return '下一步我只需一个信息：你更想看哪一类商品（护肤/彩妆/穿搭/香水个护）？';
    if (slot === 'budget') return '为了更精准，补充一下预算区间（如 $0–25 / $25–50 / $50–100 / $100+）。';
    if (slot === 'brand') return '如果有品牌偏好也告诉我（没有偏好也可以）。';
    if (slot === 'scenario') return '告诉我主要使用场景（通勤/约会/旅行/户外）我可以再收敛。';
  }
  if (slot === 'category') return 'To narrow this down, tell me the product category to prioritize first.';
  if (slot === 'budget') return 'To refine results, share a budget range (for example: $0–25 / $25–50 / $50–100 / $100+).';
  if (slot === 'brand') return 'If you have a preferred brand direction, share it and I will tighten the shortlist.';
  if (slot === 'scenario') return 'Tell me the main scenario (commute/date/travel/outdoor) and I will narrow the picks.';
  return '';
}

function buildOptimizationFollowUp({ language }) {
  const lang = normalizeLanguage(language);
  if (lang === 'zh') return '如果你愿意，我可以再按预算、品牌或香型把这份清单进一步优化。';
  if (lang === 'ja') return '必要なら、予算・ブランド・香りタイプでさらに絞り込みます。';
  if (lang === 'fr') return 'Si tu veux, je peux affiner cette sélection par budget, marque ou type de parfum.';
  if (lang === 'es') return 'Si quieres, puedo optimizar esta lista por presupuesto, marca o tipo de fragancia.';
  return 'If you want, I can refine this shortlist by budget, brand, or scent profile.';
}

function selectFollowUpSlot({ slotState, reasonCodes, queryClass }) {
  const asked = new Set(
    (Array.isArray(slotState?.asked_slots) ? slotState.asked_slots : [])
      .map(normalizeSlot)
      .filter(Boolean),
  );
  const hasScenario = hasSlotResolved(slotState, 'scenario');
  const hasCategory = hasSlotResolved(slotState, 'category');
  const hasBudget = hasSlotResolved(slotState, 'budget');
  const hasBrand = hasSlotResolved(slotState, 'brand');
  const isWeak = Array.isArray(reasonCodes)
    ? reasonCodes.includes('WEAK_RELEVANCE') || reasonCodes.includes('CONTEXT_FAIL_OPEN')
    : false;

  if ((queryClass === 'scenario' || queryClass === 'mission' || queryClass === 'category') && hasScenario && !hasCategory && !asked.has('category')) {
    return 'category';
  }
  if (isWeak && !hasBudget && !asked.has('budget')) return 'budget';
  if (isWeak && !hasBrand && !asked.has('brand')) return 'brand';
  return '';
}

function composeReplyWithContext({
  baseReply,
  language,
  intent,
  clarification,
  slotState,
  queryClass,
  reasonCodes,
  productCount = 0,
}) {
  const replyText = String(baseReply || '').trim();
  if (!replyText) return replyText;
  if (clarification?.question) return replyText;

  const scenarioLabel = inferScenarioLabel({ language, slotState, intent });
  const prefix = buildContextPrefix({ language, scenarioLabel });
  const followUpSlot = selectFollowUpSlot({ slotState, reasonCodes, queryClass });
  const followUp = buildSlotFollowUp({ language, slot: followUpSlot });
  const optimizationFollowUp =
    !followUp && Number(productCount || 0) > 0 ? buildOptimizationFollowUp({ language }) : '';

  const lines = [prefix, replyText, followUp || optimizationFollowUp].filter(Boolean);
  return lines.join('\n');
}

module.exports = {
  composeReplyWithContext,
};
