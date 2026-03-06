function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function asStringArray(value, max = 6) {
  const source = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  for (const row of source) {
    const text = asString(row);
    if (!text) continue;
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function asRecordArray(value, max = 8) {
  const source = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of source) {
    if (!isPlainObject(item)) continue;
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeCardId(value, fallbackPrefix, requestId, idx) {
  const fromRaw = asString(value);
  if (fromRaw) return fromRaw.slice(0, 120);
  return `${fallbackPrefix}_${requestId}_${idx}`;
}

function inferRoutineCategory(raw) {
  const token = asString(raw).toLowerCase();
  if (!token) return 'treatment';
  if (token.includes('cleanser') || token.includes('洁面')) return 'cleanser';
  if (token.includes('spf') || token.includes('sunscreen') || token.includes('防晒')) return 'sunscreen';
  if (
    token.includes('moistur') ||
    token.includes('cream') ||
    token.includes('lotion') ||
    token.includes('保湿') ||
    token.includes('乳液') ||
    token.includes('面霜')
  ) {
    return 'moisturizer';
  }
  if (token.includes('treatment') || token.includes('serum') || token.includes('active') || token.includes('精华')) {
    return 'treatment';
  }
  return 'treatment';
}

function buildStructuredRoutineSteps(steps) {
  const list = asStringArray(steps, 8);
  return list.map((name) => ({
    category: inferRoutineCategory(name),
    product_name: name,
    product_brand: '',
    item_type: 'premium',
  }));
}

function buildProductVerdictCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const assessment = isPlainObject(payload.assessment) ? payload.assessment : {};
  const evidence = isPlainObject(payload.evidence) ? payload.evidence : {};
  const science = isPlainObject(evidence.science) ? evidence.science : {};
  const howToUse = isPlainObject(assessment.how_to_use)
    ? assessment.how_to_use
    : isPlainObject(assessment.howToUse)
      ? assessment.howToUse
      : {};
  const dupeRecommendation = isPlainObject(payload.dupe_recommendation)
    ? payload.dupe_recommendation
    : isPlainObject(payload.dupeRecommendation)
      ? payload.dupeRecommendation
      : {};
  const skinProfileMatch = isPlainObject(payload.skin_profile_match)
    ? payload.skin_profile_match
    : isPlainObject(payload.skinProfileMatch)
      ? payload.skinProfileMatch
      : {};
  const verdict = asString(assessment.verdict) || (language === 'CN' ? '谨慎' : 'Caution');
  const reasons = asStringArray(assessment.reasons || science.fit_notes, 4);
  const risks = asStringArray(science.risk_notes, 3);
  const productName =
    asString(assessment.product_name) ||
    asString(assessment.productName) ||
    asString(payload.product_name) ||
    asString(payload.productName) ||
    asString((payload.product || {}).name);
  const brand =
    asString(assessment.brand) ||
    asString(payload.brand) ||
    asString((payload.product || {}).brand);
  const matchScoreRaw =
    Number(assessment.match_score) ||
    Number(assessment.matchScore) ||
    Number(payload.match_score) ||
    Number(payload.matchScore);
  const matchScore = Number.isFinite(matchScoreRaw)
    ? Math.max(0, Math.min(100, Math.trunc(matchScoreRaw)))
    : null;
  const suitability = asString(assessment.suitability || payload.suitability).toLowerCase();
  const mechanisms = asStringArray(
    assessment.formula_intent ||
      assessment.formulaIntent ||
      science.mechanisms ||
      payload.mechanisms,
    8,
  );
  const beneficialIngredients = asStringArray(
    science.key_ingredients ||
      science.keyIngredients ||
      assessment.key_ingredients ||
      assessment.keyIngredients ||
      payload.key_ingredients,
    10,
  );
  const usageTiming = asString(howToUse.timing || howToUse.time);
  const usageNotes = asStringArray(
    [...asStringArray(howToUse.steps, 4), ...asStringArray(howToUse.notes, 4), ...asStringArray(assessment.summary, 2)],
    6,
  );
  const actions = [
    { type: 'compare_products', label: language === 'CN' ? '对比我在用的产品' : 'Compare with my routine' },
    { type: 'add_to_experiment', label: language === 'CN' ? '加入实验追踪' : 'Track as experiment' },
  ];
  return {
    id: normalizeCardId(card && card.card_id, 'product_verdict', requestId, index),
    type: 'product_verdict',
    priority: 1,
    title: language === 'CN' ? `结论：${verdict}` : `Verdict: ${verdict}`,
    tags: asStringArray(payload.tags || [], 4),
    sections: [
      { kind: 'bullets', title: language === 'CN' ? '为什么' : 'Why', items: reasons.length ? reasons : [language === 'CN' ? '基于当前信息做出保守判断。' : 'Conservative call based on available context.'] },
      ...(risks.length ? [{ kind: 'bullets', title: language === 'CN' ? '风险点' : 'Watchouts', items: risks }] : []),
      {
        kind: 'product_verdict_structured',
        verdict,
        ...(productName ? { product_name: productName } : {}),
        ...(brand ? { brand } : {}),
        ...(typeof matchScore === 'number' ? { match_score: matchScore } : {}),
        ...(suitability ? { suitability } : {}),
        mechanisms,
        beneficial_ingredients: beneficialIngredients,
        caution_ingredients: risks,
        usage: {
          ...(usageTiming ? { timing: usageTiming } : {}),
          notes: usageNotes,
        },
        dupe_recommendation: dupeRecommendation,
        skin_profile_match: skinProfileMatch,
      },
    ],
    actions,
  };
}

function buildCompatibilityCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const sourceType = asString(card && card.type).toLowerCase();
  const conflicts = Array.isArray(payload.conflicts) ? payload.conflicts : [];
  const conflictText = conflicts
    .map((row) => (isPlainObject(row) ? asString(row.message) : ''))
    .filter(Boolean)
    .slice(0, 4);
  const summary = asString(payload.summary);
  const routineSimulationPayload =
    sourceType === 'routine_simulation'
      ? payload
      : isPlainObject(payload.routine_simulation)
        ? payload.routine_simulation
        : {};
  const conflictHeatmapPayload =
    sourceType === 'conflict_heatmap'
      ? payload
      : isPlainObject(payload.conflict_heatmap)
        ? payload.conflict_heatmap
        : {};
  return {
    id: normalizeCardId(card && card.card_id, 'compatibility', requestId, index),
    type: 'compatibility',
    priority: 1,
    title: language === 'CN' ? '搭配建议：避免同晚高风险叠加' : 'Compatibility: avoid high-risk same-night stacking',
    tags: conflictText.length ? [language === 'CN' ? '冲突规避' : 'Conflict avoidance'] : [],
    sections: [
      ...(summary ? [{ kind: 'bullets', title: language === 'CN' ? '总结' : 'Summary', items: [summary] }] : []),
      ...(conflictText.length ? [{ kind: 'bullets', title: language === 'CN' ? '冲突点' : 'Conflicts', items: conflictText }] : []),
      {
        kind: 'compatibility_structured',
        source_card_type: sourceType || 'unknown',
        routine_simulation: routineSimulationPayload,
        conflict_heatmap: conflictHeatmapPayload,
      },
    ],
    actions: [{ type: 'save_schedule', label: language === 'CN' ? '保存到 routine' : 'Save schedule' }],
  };
}

function buildRoutineCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const analysis = isPlainObject(payload.analysis) ? payload.analysis : {};
  const expert = isPlainObject(analysis.routine_expert) ? analysis.routine_expert : {};
  const snapshot = isPlainObject(expert.snapshot) ? expert.snapshot : {};
  const amSteps = asStringArray(snapshot.am_steps, 6);
  const pmSteps = asStringArray(snapshot.pm_steps, 6);
  const observe = asStringArray(expert?.plan_7d?.observe_metrics, 4);
  const conflicts = asStringArray(payload.conflicts, 6);
  const structuredAmSteps = buildStructuredRoutineSteps(amSteps);
  const structuredPmSteps = buildStructuredRoutineSteps(pmSteps);
  return {
    id: normalizeCardId(card && card.card_id, 'routine', requestId, index),
    type: 'routine',
    priority: 1,
    title: language === 'CN' ? '你的 AM/PM Routine' : 'Your AM/PM routine',
    tags: [language === 'CN' ? '稳定优先' : 'Stability first'],
    sections: [
      ...(amSteps.length ? [{ kind: 'routine_list', title: 'AM', items: amSteps.map((name, step) => ({ step: step + 1, name })) }] : []),
      ...(pmSteps.length ? [{ kind: 'routine_list', title: 'PM', items: pmSteps.map((name, step) => ({ step: step + 1, name })) }] : []),
      ...(observe.length ? [{ kind: 'bullets', title: language === 'CN' ? '观察指标' : 'What to monitor', items: observe }] : []),
      {
        kind: 'routine_structured',
        am_steps: structuredAmSteps,
        pm_steps: structuredPmSteps,
        conflicts,
      },
    ],
    actions: [
      { type: 'save_routine', label: language === 'CN' ? '保存为我的 routine' : 'Save routine' },
      { type: 'switch_mode', label: language === 'CN' ? '切换到简化版' : 'Switch to simpler mode' },
    ],
  };
}

function buildTriageCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const details = asStringArray(payload.details, 5);
  const actions = asStringArray(payload.actions, 4);
  const redFlags = asStringArray(payload.red_flags || payload.redFlags, 6);
  const riskLevel = asString(payload.risk_level || payload.riskLevel || payload.severity).toLowerCase();
  const recoveryWindowRaw =
    Number(payload.recovery_window_hours) ||
    Number(payload.recoveryWindowHours) ||
    Number(payload.window_hours);
  const recoveryWindowHours = Number.isFinite(recoveryWindowRaw)
    ? Math.max(0, Math.trunc(recoveryWindowRaw))
    : 48;
  return {
    id: normalizeCardId(card && card.card_id, 'triage', requestId, index),
    type: 'triage',
    priority: 1,
    title:
      language === 'CN'
        ? '48小时应急：先停活性、稳住屏障'
        : '48-hour triage: pause strong actives and stabilize barrier',
    tags: [language === 'CN' ? '安全优先' : 'Safety first'],
    sections: [
      {
        kind: 'bullets',
        title: language === 'CN' ? '执行要点' : 'Action points',
        items: details.length ? details : [language === 'CN' ? '先执行保守策略并观察 48 小时。' : 'Use a conservative path and monitor for 48h.'],
      },
      ...(actions.length ? [{ kind: 'bullets', title: language === 'CN' ? '下一步' : 'Next step', items: actions }] : []),
      ...(redFlags.length ? [{ kind: 'bullets', title: language === 'CN' ? '红旗信号' : 'Red flags', items: redFlags }] : []),
      {
        kind: 'triage_structured',
        summary:
          (details && details[0]) ||
          (language === 'CN'
            ? '先停强活性，优先修护并观察变化。'
            : 'Pause strong actives first, prioritize barrier support and monitor changes.'),
        action_points: details,
        next_steps: actions,
        risk_level: riskLevel || 'medium',
        red_flags: redFlags,
        recovery_window_hours: recoveryWindowHours,
      },
    ],
    actions: [
      { type: 'log_symptom', label: language === 'CN' ? '记录症状' : 'Log symptom' },
      { type: 'add_to_experiment', label: language === 'CN' ? '创建恢复实验' : 'Create recovery experiment' },
    ],
  };
}

function buildSkinStatusCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const profile = isPlainObject(payload.profile) ? payload.profile : {};
  const features = Array.isArray(payload.features) ? payload.features : [];
  const observations = features
    .map((row) => (isPlainObject(row) ? asString(row.observation) : ''))
    .filter(Boolean)
    .slice(0, 4);
  const strategy = asString(payload.strategy);
  const skinType =
    asString(payload.skin_type) ||
    asString(payload.skinType) ||
    asString(profile.skinType);
  const barrierStatus =
    asString(payload.barrier_status) ||
    asString(payload.barrierStatus) ||
    asString(profile.barrierStatus);
  const concerns = asStringArray(payload.concerns || profile.concerns || profile.goals, 8);
  return {
    id: normalizeCardId(card && card.card_id, 'skin_status', requestId, index),
    type: 'skin_status',
    priority: 1,
    title: language === 'CN' ? '当前状态：屏障与炎症风险评估' : 'Current status: barrier and inflammation assessment',
    tags: [language === 'CN' ? '优先级判断' : 'Priority assessment'],
    sections: [
      ...(observations.length ? [{ kind: 'bullets', title: language === 'CN' ? '观察结论' : 'Observed signals', items: observations }] : []),
      ...(strategy ? [{ kind: 'bullets', title: language === 'CN' ? '策略' : 'Strategy', items: [strategy] }] : []),
      {
        kind: 'skin_status_structured',
        diagnosis: {
          ...(skinType ? { skin_type: skinType } : {}),
          ...(barrierStatus ? { barrier_status: barrierStatus } : {}),
          concerns,
        },
        observations,
        ...(strategy ? { strategy } : {}),
      },
    ],
    actions: [
      { type: 'confirm_profile', label: language === 'CN' ? '写入我的肤况档案' : 'Save to profile' },
      { type: 'open_question', label: language === 'CN' ? '继续细化建议' : 'Refine recommendation' },
    ],
  };
}

function buildEffectReviewCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const reasons = asStringArray(payload.reasons || payload.details, 4);
  const routineBridge = isPlainObject(payload.routine_bridge)
    ? payload.routine_bridge
    : isPlainObject(payload.routineBridge)
      ? payload.routineBridge
      : {};
  const targetState = asStringArray(payload.target_state || payload.targets, 4);
  const corePrinciples = asStringArray(payload.core_principles || payload.principles, 6);
  const timeline = asStringArray(
    (isPlainObject(payload.timeline) ? payload.timeline.first_4_weeks : payload.timeline) || payload.progress_notes,
    6,
  );
  const safetyNotes = asStringArray(payload.safety_notes || payload.watchouts, 5);
  return {
    id: normalizeCardId(card && card.card_id, 'effect_review', requestId, index),
    type: 'effect_review',
    priority: 2,
    title: language === 'CN' ? '效果复盘：先找变量，再调计划' : 'Effect review: isolate variables, then adjust',
    tags: [language === 'CN' ? '2/4/8周复盘' : '2/4/8 week review'],
    sections: [
      {
        kind: 'bullets',
        title: language === 'CN' ? '可能原因' : 'Possible causes',
        items: reasons.length ? reasons : [language === 'CN' ? '当前证据不足，建议固定执行并记录反馈。' : 'Evidence is limited; keep routine stable and log feedback.'],
      },
      {
        kind: 'effect_review_structured',
        priority_findings: reasons.map((line) => ({ title: line, detail: line })),
        target_state: targetState,
        core_principles: corePrinciples,
        timeline: {
          first_4_weeks: timeline,
          week_8_12_expectation: [],
        },
        safety_notes: safetyNotes,
        routine_bridge: routineBridge,
      },
    ],
    actions: [{ type: 'start_review', label: language === 'CN' ? '开始2周复盘' : 'Start 2-week review' }],
  };
}

function buildTravelCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const notes = asStringArray(payload.notes || payload.summary_tags || payload.actions, 5);
  const envPayload =
    isPlainObject(payload.env_payload) ? payload.env_payload : payload;
  return {
    id: normalizeCardId(card && card.card_id, 'travel', requestId, index),
    type: 'travel',
    priority: 1,
    title: language === 'CN' ? '旅行模式：极简清单与应急预案' : 'Travel mode: minimal packing + contingency',
    tags: [language === 'CN' ? '场景策略' : 'Scenario strategy'],
    sections: [
      { kind: 'checklist', title: language === 'CN' ? '关键提醒' : 'Key reminders', items: notes.length ? notes : [language === 'CN' ? '优先保湿和防晒。' : 'Prioritize hydration and SPF.'] },
      {
        kind: 'travel_structured',
        env_payload: envPayload,
      },
    ],
    actions: [{ type: 'generate_packing_list', label: language === 'CN' ? '生成打包清单' : 'Generate packing list' }],
  };
}

function buildNudgeCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const message = asString(payload.message || payload.summary || payload.note);
  const hints = asStringArray(payload.hints || payload.reasons || payload.details, 5);
  const cadenceDaysRaw =
    Number(payload.cadence_days) ||
    Number(payload.cadenceDays) ||
    Number(payload.checkin_days);
  const cadenceDays = Number.isFinite(cadenceDaysRaw)
    ? Math.max(0, Math.trunc(cadenceDaysRaw))
    : 0;
  return {
    id: normalizeCardId(card && card.card_id, 'nudge', requestId, index),
    type: 'nudge',
    priority: 3,
    title: language === 'CN' ? '可选加分项' : 'Optional nudge',
    tags: [language === 'CN' ? '可选' : 'Optional'],
    sections: [
      {
        kind: 'bullets',
        title: language === 'CN' ? '提示' : 'Tip',
        items: [message || (language === 'CN' ? '先把核心步骤做稳定，再加额外动作。' : 'Stabilize core routine first, then add extras.')],
      },
      ...(hints.length ? [{ kind: 'bullets', title: language === 'CN' ? '为什么有帮助' : 'Why this helps', items: hints }] : []),
      {
        kind: 'nudge_structured',
        message:
          message ||
          (language === 'CN'
            ? '先把核心步骤做稳定，再加额外动作。'
            : 'Stabilize core routine first, then add extras.'),
        hints,
        cadence_days: cadenceDays,
      },
    ],
    actions: [
      { type: 'dismiss', label: language === 'CN' ? '暂时不需要' : 'Dismiss' },
      { type: 'save_tip', label: language === 'CN' ? '加入提醒' : 'Save tip' },
    ],
  };
}

function normalizeLegacyActionRows(rawActions, language) {
  const rows = asRecordArray(rawActions, 6);
  return rows
    .map((row, idx) => {
      const actionType = asString(row.type) || asString(row.action_id) || asString(row.id) || `action_${idx + 1}`;
      const label = asString(row.label) || actionType || (language === 'CN' ? '继续' : 'Continue');
      if (!actionType || !label) return null;
      return {
        type: actionType.slice(0, 120),
        label: label.slice(0, 160),
        payload: row,
      };
    })
    .filter(Boolean);
}

function buildPassthroughCard({ card, requestId, index, language = 'EN', fallbackTitle = '' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const type = asString(card && card.type).toLowerCase();
  const title =
    asString(card && card.title) ||
    asString(payload.title) ||
    fallbackTitle ||
    (language === 'CN' ? '信息卡片' : 'Information card');
  const subtitle = asString(payload.subtitle) || undefined;
  const priorityRaw = Number(card && card.priority);
  const payloadPriorityRaw = Number(payload.priority);
  const priority = Number.isFinite(priorityRaw)
    ? Math.max(1, Math.min(3, Math.trunc(priorityRaw)))
    : Number.isFinite(payloadPriorityRaw)
      ? Math.max(1, Math.min(3, Math.trunc(payloadPriorityRaw)))
      : 2;
  const tags = asStringArray(payload.tags, 6);
  const sections = asRecordArray(payload.sections, 8);
  const actions = normalizeLegacyActionRows(payload.actions, language);
  return {
    id: normalizeCardId(card && card.card_id, type || 'card', requestId, index),
    type,
    priority,
    title,
    ...(subtitle ? { subtitle } : {}),
    tags,
    sections,
    actions,
    payload,
  };
}

function normalizeProductCard(raw, language) {
  const p = isPlainObject(raw) ? raw : {};
  const category = asString(p.category) || asString(p.routine_slot) || inferRoutineCategory(p.product_name || p.name || '');
  const name = asString(p.product_name) || asString(p.name);
  const brand = asString(p.brand) || asString(p.product_brand);
  const bestFor = asString(p.best_for) || asString(p.why_this_one) || '';
  const keyFeatures = asStringArray(p.key_features || p.actives || p.key_ingredients, 6);
  const priceTier = asString(p.price_tier) || asString(p.item_type) || 'mid';
  const whyThisOne = asString(p.why_this_one) || asString(p.reason) || '';
  const seeMore = p.see_more !== false;
  return {
    category,
    name,
    brand,
    best_for: bestFor,
    key_features: keyFeatures,
    price_tier: ['budget', 'mid', 'premium'].includes(priceTier) ? priceTier : 'mid',
    why_this_one: whyThisOne,
    see_more: seeMore,
    ...(p.alternatives ? { alternatives: asRecordArray(p.alternatives, 9).map((alt) => ({
      name: asString(alt.name) || asString(alt.product_name),
      brand: asString(alt.brand),
      differentiator: asString(alt.differentiator) || asString(alt.reason),
      price_tier: asString(alt.price_tier) || 'mid',
      suitability_flags: asStringArray(alt.suitability_flags || alt.flags, 4),
    })) } : {}),
    ...(p.user_product_action ? {
      user_product_action: asString(p.user_product_action),
    } : {}),
  };
}

function buildRecommendationsCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const recommendations = Array.isArray(payload.recommendations) ? payload.recommendations : [];
  const products = recommendations.map((r) => normalizeProductCard(r, language)).filter((p) => p.name);
  const amProducts = products.filter((p) => p.category === 'cleanser' || p.category === 'sunscreen' || p.category === 'moisturizer');
  const pmProducts = products.filter((p) => p.category === 'treatment' || (p.category === 'moisturizer' && !amProducts.includes(p)));

  return {
    id: normalizeCardId(card && card.card_id, 'recommendations', requestId, index),
    type: 'recommendations',
    priority: 1,
    title: language === 'CN' ? '产品推荐' : 'Product Recommendations',
    tags: [],
    sections: [
      {
        kind: 'product_cards',
        products: products.slice(0, 8),
      },
    ],
    actions: [
      { type: 'see_more_alternatives', label: language === 'CN' ? '查看更多替代品' : 'See more alternatives' },
      { type: 'optimize_existing_products', label: language === 'CN' ? '优化现有产品' : 'Optimize my current products' },
    ],
    payload,
  };
}

function mapLegacyCardToSpecCards(card, { requestId, language = 'EN', index = 0 } = {}) {
  const type = asString(card && card.type).toLowerCase();
  if (!type) return [];

  if (type === 'product_analysis') {
    return [buildProductVerdictCard({ card, requestId, index, language })];
  }
  if (type === 'recommendations') {
    return [buildRecommendationsCard({ card, requestId, index, language })];
  }
  if (type === 'routine_simulation' || type === 'conflict_heatmap') {
    return [buildCompatibilityCard({ card, requestId, index, language })];
  }
  if (type === 'analysis_summary') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '肤况总结' : 'Skin summary' })];
  }
  if (type === 'confidence_notice') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '置信度提示' : 'Confidence notice' })];
  }
  if (type === 'env_stress' || type === 'travel') {
    return [buildTravelCard({ card, requestId, index, language })];
  }
  if (type === 'analysis_story_v2') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '分析解读' : 'Analysis story' })];
  }
  if (type === 'routine_fit_summary') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? 'Routine 匹配度' : 'Routine fit' })];
  }
  if (type === 'ingredient_hub') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '成分查询入口' : 'Ingredient hub' })];
  }
  if (type === 'ingredient_goal_match') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '按功效找成分' : 'Ingredient goal match' })];
  }
  if (type === 'aurora_ingredient_report') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '成分报告' : 'Ingredient report' })];
  }
  if (type === 'diagnosis_gate') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '先做一个极简肤况确认' : 'Quick skin profile first' })];
  }
  if (type === 'budget_gate') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '预算确认' : 'Budget check' })];
  }
  if (type === 'gate_notice') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '门控提示' : 'Gate notice' })];
  }
  if (type === 'diagnosis_v2_login_prompt') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '登录后诊断更准确' : 'Log in for better diagnosis' })];
  }
  if (type === 'diagnosis_v2_intro') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '选择你的护肤目标' : 'Choose your skincare goals' })];
  }
  if (type === 'diagnosis_v2_photo_prompt') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '拍照提升准确度' : 'Photo for better accuracy' })];
  }
  if (type === 'diagnosis_v2_result') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '你的皮肤诊断报告' : 'Your skin diagnosis report' })];
  }
  if (type === 'ingredient_plan' || type === 'ingredient_plan_v2' || type === 'routine_prompt') {
    return [buildRoutineCard({ card, requestId, index, language })];
  }
  if (type === 'triage') return [buildTriageCard({ card, requestId, index, language })];
  if (type === 'skin_status') return [buildSkinStatusCard({ card, requestId, index, language })];
  if (type === 'effect_review') return [buildEffectReviewCard({ card, requestId, index, language })];
  return [buildNudgeCard({ card, requestId, index, language })];
}

function tokenOverlap(a, b) {
  const tokA = new Set(String(a || '').toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean));
  const tokB = new Set(String(b || '').toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean));
  if (!tokA.size || !tokB.size) return 0;
  let overlap = 0;
  for (const t of tokA) { if (tokB.has(t)) overlap++; }
  return overlap / Math.min(tokA.size, tokB.size);
}

function dedupeStrings(items, threshold = 0.7) {
  const out = [];
  for (const item of items) {
    const text = String(item || '').trim();
    if (!text) continue;
    const truncated = /\w+-$/.test(text);
    const cleaned = truncated ? text.replace(/-$/, '') : text;
    if (out.some((existing) => tokenOverlap(existing, cleaned) >= threshold)) continue;
    out.push(cleaned);
  }
  return out;
}

function dedupeFindings(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue;
    const key = `${String(f.cue || '').toLowerCase()}:${String(f.where || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

const OUTPUT_CAPS = Object.freeze({
  findings: 5,
  guidance_brief: 3,
  am_steps: 5,
  pm_steps: 6,
  top_concerns: 3,
  features: 5,
  reasoning: 4,
});

function dedupeAndCapOutput(analysis) {
  const a = analysis && typeof analysis === 'object' ? analysis : null;
  if (!a) return analysis;

  const findings = dedupeFindings(Array.isArray(a.findings) ? a.findings : []).slice(0, OUTPUT_CAPS.findings);
  const guidanceBrief = dedupeStrings(Array.isArray(a.guidance_brief) ? a.guidance_brief : []).slice(0, OUTPUT_CAPS.guidance_brief);
  const features = Array.isArray(a.features)
    ? dedupeStrings(a.features.map((f) => f && typeof f === 'object' ? f.observation : '')).slice(0, OUTPUT_CAPS.features).map((obs) => ({ observation: obs, confidence: 'somewhat_sure' }))
    : a.features;
  const reasoning = Array.isArray(a.reasoning)
    ? dedupeStrings(a.reasoning).slice(0, OUTPUT_CAPS.reasoning)
    : a.reasoning;

  const expert = a.routine_expert && typeof a.routine_expert === 'object' ? { ...a.routine_expert } : a.routine_expert;
  if (expert && expert.snapshot && typeof expert.snapshot === 'object') {
    const snap = { ...expert.snapshot };
    if (Array.isArray(snap.am_steps)) snap.am_steps = snap.am_steps.slice(0, OUTPUT_CAPS.am_steps);
    if (Array.isArray(snap.pm_steps)) snap.pm_steps = snap.pm_steps.slice(0, OUTPUT_CAPS.pm_steps);
    expert.snapshot = snap;
  }

  return {
    ...a,
    findings,
    guidance_brief: guidanceBrief,
    features: Array.isArray(features) ? features : a.features,
    reasoning,
    routine_expert: expert,
  };
}

module.exports = {
  mapLegacyCardToSpecCards,
  dedupeAndCapOutput,
  OUTPUT_CAPS,
};
