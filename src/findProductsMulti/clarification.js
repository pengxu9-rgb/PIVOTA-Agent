function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

const KNOWN_SLOTS = new Set(['scenario', 'category', 'budget', 'brand']);

function hasAnyScenarioSignal(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  const scenarioSignals = [
    '约会',
    '約會',
    '通勤',
    '上班',
    '面试',
    '面試',
    '出差',
    '旅行',
    '旅游',
    '差旅',
    '露营',
    '露營',
    '登山',
    '徒步',
    '户外',
  ];
  const zhHit = scenarioSignals.some((signal) => normalized.includes(signal));
  if (zhHit) return true;
  const enPatterns = [
    /\bhiking\b/i,
    /\boutdoor\b/i,
    /\bcommute\b/i,
    /\binterview\b/i,
    /\btravel\b/i,
    /\bbusiness[\s-]?trip\b/i,
    /\bdate[\s-]?night\b/i,
    /\bdate\b/i,
  ];
  return enPatterns.some((pattern) => pattern.test(normalized));
}

function hasSpecificScenario({ intent, rawQuery, associationPlan, slotState } = {}) {
  const resolvedScenarioFromContext = normalizeText(slotState?.resolved_slots?.scenario);
  if (resolvedScenarioFromContext) return true;
  const scenarioName = normalizeText(intent?.scenario?.name);
  if (scenarioName && !['general', 'browse', 'discovery', 'default'].includes(scenarioName)) {
    return true;
  }
  const associationScenario = normalizeText(associationPlan?.scenario_key);
  if (associationScenario && associationScenario !== 'default') {
    return true;
  }
  return hasAnyScenarioSignal(rawQuery);
}

function normalizeSlot(value) {
  const normalized = normalizeText(value);
  if (KNOWN_SLOTS.has(normalized)) return normalized;
  return '';
}

function normalizeAskedSlots(slotState) {
  const slots = Array.isArray(slotState?.asked_slots) ? slotState.asked_slots : [];
  return new Set(slots.map(normalizeSlot).filter(Boolean));
}

function hasResolvedSlot(slotState, key) {
  const normalizedKey = normalizeSlot(key);
  if (!normalizedKey) return false;
  const value = slotState?.resolved_slots?.[normalizedKey];
  return normalizeText(value).length > 0;
}

function inferCategoryResolved(intent, slotState) {
  if (hasResolvedSlot(slotState, 'category')) return true;
  const requiredCats = Array.isArray(intent?.category?.required) ? intent.category.required : [];
  return requiredCats.length > 0;
}

function inferBudgetResolved(intent, slotState) {
  if (hasResolvedSlot(slotState, 'budget')) return true;
  const min = Number(intent?.hard_constraints?.price?.min);
  const max = Number(intent?.hard_constraints?.price?.max);
  return Number.isFinite(min) || Number.isFinite(max);
}

function inferBrandResolved(intent, slotState) {
  if (hasResolvedSlot(slotState, 'brand')) return true;
  const brands = Array.isArray(intent?.soft_preferences?.brands) ? intent.soft_preferences.brands : [];
  return brands.length > 0;
}

function chooseNextSlot({ queryClass, intent, rawQuery = '', associationPlan = null, slotState = null, hints = null }) {
  const askedSlots = normalizeAskedSlots(slotState);
  const scenarioResolved = hasSpecificScenario({ intent, rawQuery, associationPlan, slotState });
  const categoryResolved = inferCategoryResolved(intent, slotState);
  const budgetResolved = inferBudgetResolved(intent, slotState);
  const brandResolved = inferBrandResolved(intent, slotState);
  const postCandidates = Number(hints?.post_candidates);
  const lowRelevance =
    (Number.isFinite(postCandidates) && postCandidates <= 0) ||
    ['none', 'weak'].includes(String(hints?.match_tier || '').toLowerCase());

  const canAsk = (slot) => !askedSlots.has(slot);

  if (queryClass === 'mission' || queryClass === 'scenario') {
    if (scenarioResolved && !categoryResolved && canAsk('category')) return 'category';
    if (scenarioResolved && categoryResolved && lowRelevance) {
      if (!budgetResolved && canAsk('budget')) return 'budget';
      if (!brandResolved && canAsk('brand')) return 'brand';
    }
    if (!scenarioResolved && canAsk('scenario')) return 'scenario';
    if (!categoryResolved && canAsk('category')) return 'category';
    if (!budgetResolved && lowRelevance && canAsk('budget')) return 'budget';
    if (!brandResolved && lowRelevance && canAsk('brand')) return 'brand';
    return '';
  }

  if (queryClass === 'attribute') {
    if (!budgetResolved && canAsk('budget')) return 'budget';
    if (!brandResolved && canAsk('brand')) return 'brand';
    if (!categoryResolved && canAsk('category')) return 'category';
    return '';
  }

  if (!scenarioResolved && canAsk('scenario')) return 'scenario';
  if (!categoryResolved && canAsk('category')) return 'category';
  if (!budgetResolved && canAsk('budget')) return 'budget';
  if (!brandResolved && canAsk('brand')) return 'brand';
  return '';
}

function buildZhClarification(queryClass, intent, context = {}, slot = '') {
  const domain = String(intent?.primary_domain || '');
  if (queryClass === 'gift') {
    return {
      question: '这是送礼吗？我可以按对象和预算快速给你筛选。',
      options: ['送女友/男友', '送朋友/同事', '给自己买', '先看热门'],
      reason_code: 'CLARIFY_GIFT_SCOPE',
      slot: 'category',
    };
  }
  if (queryClass === 'mission' || queryClass === 'scenario') {
    if (slot === 'budget') {
      return {
        question: '预算大概在哪个范围？',
        options: ['$0–25', '$25–50', '$50–100', '$100+'],
        reason_code: 'CLARIFY_BUDGET',
        slot: 'budget',
      };
    }
    if (slot === 'brand') {
      return {
        question: '有偏好的品牌方向吗？',
        options: ['没有偏好', '国际品牌', '国货/本土品牌', '性价比优先'],
        reason_code: 'CLARIFY_BRAND',
        slot: 'brand',
      };
    }
    if (slot === 'category') {
      if (domain === 'beauty') {
        return {
          question: '这次更想优先哪一类？',
          options: ['底妆', '眼妆', '唇妆', '护肤'],
          reason_code: 'CLARIFY_BEAUTY_CATEGORY',
          slot: 'category',
        };
      }
      if ((intent?.target_object?.type || '') === 'pet') {
        return {
          question: '你这次主要想要哪类宠物用品？',
          options: ['牵引/背带', '宠物衣服', '出行配件', '先看热门'],
          reason_code: 'CLARIFY_PET_CATEGORY',
          slot: 'category',
        };
      }
      return {
        question: '你想优先看哪一类商品？',
        options: ['护肤/彩妆', '穿搭/服饰', '香水/个护', '旅行/户外装备'],
        reason_code: 'CLARIFY_CATEGORY_SCOPE',
        slot: 'category',
      };
    }
    if (slot === 'scenario') {
      return {
        question: '你主要使用场景是哪一个？',
        options: ['通勤/上班', '约会', '出差/旅行', '户外/徒步'],
        reason_code: 'CLARIFY_SCENARIO',
        slot: 'scenario',
      };
    }
    if (domain === 'beauty') {
      return {
        question: '这次更想优先哪一类？',
        options: ['底妆', '眼妆', '唇妆', '护肤'],
        reason_code: 'CLARIFY_BEAUTY_CATEGORY',
        slot: 'category',
      };
    }
    if ((intent?.target_object?.type || '') === 'pet') {
      return {
        question: '你这次主要想要哪类宠物用品？',
        options: ['牵引/背带', '宠物衣服', '出行配件', '先看热门'],
        reason_code: 'CLARIFY_PET_CATEGORY',
        slot: 'category',
      };
    }
    if (hasSpecificScenario({ intent, rawQuery: context.rawQuery, associationPlan: context.associationPlan })) {
      return {
        question: '你想优先看哪一类商品？',
        options: ['护肤/彩妆', '穿搭/服饰', '香水/个护', '旅行/户外装备'],
        reason_code: 'CLARIFY_CATEGORY_SCOPE',
        slot: 'category',
      };
    }
    return {
      question: '你主要使用场景是哪一个？',
      options: ['通勤/上班', '约会', '出差/旅行', '户外/徒步'],
      reason_code: 'CLARIFY_SCENARIO',
      slot: 'scenario',
    };
  }
  if (queryClass === 'attribute') {
    if (slot === 'budget') {
      return {
        question: '预算大概在哪个范围？',
        options: ['$0–25', '$25–50', '$50–100', '$100+'],
        reason_code: 'CLARIFY_BUDGET',
        slot: 'budget',
      };
    }
    if (slot === 'brand') {
      return {
        question: '有偏好的品牌方向吗？',
        options: ['没有偏好', '国际品牌', '国货/本土品牌', '性价比优先'],
        reason_code: 'CLARIFY_BRAND',
        slot: 'brand',
      };
    }
    return {
      question: '为了更准推荐，优先补充一个条件：',
      options: ['预算范围', '品牌偏好', '使用场景', '都没有，先看基础款'],
      reason_code: 'CLARIFY_ATTRIBUTE',
      slot: 'budget',
    };
  }
  if (queryClass === 'non_shopping') {
    return {
      question: '你想直接买哪类商品？我可以马上给你可下单的清单。',
      options: ['美妆', '宠物', '旅行', '户外'],
      reason_code: 'CLARIFY_SHOPPING_INTENT',
      slot: 'category',
    };
  }
  return {
    question: '为了避免推荐跑偏，你更想先看哪一类？',
    options: ['品牌单品', '按场景清单', '按预算筛选', '先看热门'],
    reason_code: 'CLARIFY_AMBIGUOUS_QUERY',
    slot: 'category',
  };
}

function buildEnClarification(queryClass, intent, context = {}, slot = '') {
  const domain = String(intent?.primary_domain || '');
  if (queryClass === 'gift') {
    return {
      question: 'Is this a gift? I can narrow options by recipient and budget.',
      options: ['Gift for partner', 'Gift for friend/coworker', 'For myself', 'Show popular picks'],
      reason_code: 'CLARIFY_GIFT_SCOPE',
      slot: 'category',
    };
  }
  if (queryClass === 'mission' || queryClass === 'scenario') {
    if (slot === 'budget') {
      return {
        question: 'What budget range should I target first?',
        options: ['$0–25', '$25–50', '$50–100', '$100+'],
        reason_code: 'CLARIFY_BUDGET',
        slot: 'budget',
      };
    }
    if (slot === 'brand') {
      return {
        question: 'Do you have a brand preference?',
        options: ['No brand preference', 'Global brands', 'Local brands', 'Value-for-money first'],
        reason_code: 'CLARIFY_BRAND',
        slot: 'brand',
      };
    }
    if (slot === 'category') {
      if (domain === 'beauty') {
        return {
          question: 'Which beauty category should we prioritize first?',
          options: ['Base makeup', 'Eye makeup', 'Lip makeup', 'Skincare'],
          reason_code: 'CLARIFY_BEAUTY_CATEGORY',
          slot: 'category',
        };
      }
      if ((intent?.target_object?.type || '') === 'pet') {
        return {
          question: 'What do you want first for your pet?',
          options: ['Leash/harness', 'Pet apparel', 'Travel accessories', 'Show popular picks'],
          reason_code: 'CLARIFY_PET_CATEGORY',
          slot: 'category',
        };
      }
      return {
        question: 'Which product category should I prioritize first?',
        options: ['Skincare/makeup', 'Outfit/apparel', 'Fragrance/personal care', 'Travel/outdoor gear'],
        reason_code: 'CLARIFY_CATEGORY_SCOPE',
        slot: 'category',
      };
    }
    if (slot === 'scenario') {
      return {
        question: 'Which scenario should I optimize for?',
        options: ['Commute/work', 'Date night', 'Business trip/travel', 'Hiking/outdoor'],
        reason_code: 'CLARIFY_SCENARIO',
        slot: 'scenario',
      };
    }
    if (domain === 'beauty') {
      return {
        question: 'Which beauty category should we prioritize first?',
        options: ['Base makeup', 'Eye makeup', 'Lip makeup', 'Skincare'],
        reason_code: 'CLARIFY_BEAUTY_CATEGORY',
        slot: 'category',
      };
    }
    if ((intent?.target_object?.type || '') === 'pet') {
      return {
        question: 'What do you want first for your pet?',
        options: ['Leash/harness', 'Pet apparel', 'Travel accessories', 'Show popular picks'],
        reason_code: 'CLARIFY_PET_CATEGORY',
        slot: 'category',
      };
    }
    if (hasSpecificScenario({ intent, rawQuery: context.rawQuery, associationPlan: context.associationPlan })) {
      return {
        question: 'Which product category should I prioritize first?',
        options: ['Skincare/makeup', 'Outfit/apparel', 'Fragrance/personal care', 'Travel/outdoor gear'],
        reason_code: 'CLARIFY_CATEGORY_SCOPE',
        slot: 'category',
      };
    }
    return {
      question: 'Which scenario should I optimize for?',
      options: ['Commute/work', 'Date night', 'Business trip/travel', 'Hiking/outdoor'],
      reason_code: 'CLARIFY_SCENARIO',
      slot: 'scenario',
    };
  }
  if (queryClass === 'attribute') {
    if (slot === 'budget') {
      return {
        question: 'What budget range should I target first?',
        options: ['$0–25', '$25–50', '$50–100', '$100+'],
        reason_code: 'CLARIFY_BUDGET',
        slot: 'budget',
      };
    }
    if (slot === 'brand') {
      return {
        question: 'Do you have a brand preference?',
        options: ['No brand preference', 'Global brands', 'Local brands', 'Value-for-money first'],
        reason_code: 'CLARIFY_BRAND',
        slot: 'brand',
      };
    }
    return {
      question: 'To refine results, which constraint matters most?',
      options: ['Budget', 'Brand', 'Use case', 'Show baseline picks'],
      reason_code: 'CLARIFY_ATTRIBUTE',
      slot: 'budget',
    };
  }
  if (queryClass === 'non_shopping') {
    return {
      question: 'Which product domain do you want to shop now?',
      options: ['Beauty', 'Pet', 'Travel', 'Outdoor'],
      reason_code: 'CLARIFY_SHOPPING_INTENT',
      slot: 'category',
    };
  }
  return {
    question: 'To avoid off-topic recommendations, what should we prioritize?',
    options: ['Brand lookup', 'Scenario checklist', 'Budget filter', 'Popular picks'],
    reason_code: 'CLARIFY_AMBIGUOUS_QUERY',
    slot: 'category',
  };
}

function buildClarification({
  queryClass,
  intent,
  language,
  rawQuery = '',
  associationPlan = null,
  slotState = null,
  hints = null,
}) {
  const lang = String(language || intent?.language || 'en').toLowerCase();
  const normalizedClass = String(queryClass || intent?.query_class || 'exploratory').toLowerCase();
  const selectedSlot = chooseNextSlot({
    queryClass: normalizedClass,
    intent,
    rawQuery,
    associationPlan,
    slotState,
    hints,
  });
  const context = {
    rawQuery,
    associationPlan:
      associationPlan && typeof associationPlan === 'object' && !Array.isArray(associationPlan)
        ? associationPlan
        : null,
  };
  const payload =
    lang === 'zh'
      ? buildZhClarification(normalizedClass, intent, context, selectedSlot)
      : buildEnClarification(normalizedClass, intent, context, selectedSlot);
  const slot = normalizeSlot(payload.slot || selectedSlot);
  const reasonCode = String(payload.reason_code || 'CLARIFY_AMBIGUOUS_QUERY');
  return {
    question: String(payload.question || ''),
    options: Array.isArray(payload.options) ? payload.options.slice(0, 4) : [],
    reason_code: reasonCode,
    slot,
    dedup_key: `${slot || 'generic'}:${reasonCode}`,
  };
}

module.exports = {
  buildClarification,
  chooseNextSlot,
  hasAnyScenarioSignal,
  hasSpecificScenario,
};
