function buildZhClarification(queryClass, intent) {
  const domain = String(intent?.primary_domain || '');
  if (queryClass === 'gift') {
    return {
      question: '这是送礼吗？我可以按对象和预算快速给你筛选。',
      options: ['送女友/男友', '送朋友/同事', '给自己买', '先看热门'],
      reason_code: 'CLARIFY_GIFT_SCOPE',
    };
  }
  if (queryClass === 'mission' || queryClass === 'scenario') {
    if (domain === 'beauty') {
      return {
        question: '这次更想优先哪一类？',
        options: ['底妆', '眼妆', '唇妆', '护肤'],
        reason_code: 'CLARIFY_BEAUTY_CATEGORY',
      };
    }
    if ((intent?.target_object?.type || '') === 'pet') {
      return {
        question: '你这次主要想要哪类宠物用品？',
        options: ['牵引/背带', '宠物衣服', '出行配件', '先看热门'],
        reason_code: 'CLARIFY_PET_CATEGORY',
      };
    }
    return {
      question: '你主要使用场景是哪一个？',
      options: ['通勤/上班', '约会', '出差/旅行', '户外/徒步'],
      reason_code: 'CLARIFY_SCENARIO',
    };
  }
  if (queryClass === 'attribute') {
    return {
      question: '为了更准推荐，优先补充一个条件：',
      options: ['预算范围', '品牌偏好', '使用场景', '都没有，先看基础款'],
      reason_code: 'CLARIFY_ATTRIBUTE',
    };
  }
  if (queryClass === 'non_shopping') {
    return {
      question: '你想直接买哪类商品？我可以马上给你可下单的清单。',
      options: ['美妆', '宠物', '旅行', '户外'],
      reason_code: 'CLARIFY_SHOPPING_INTENT',
    };
  }
  return {
    question: '为了避免推荐跑偏，你更想先看哪一类？',
    options: ['品牌单品', '按场景清单', '按预算筛选', '先看热门'],
    reason_code: 'CLARIFY_AMBIGUOUS_QUERY',
  };
}

function buildEnClarification(queryClass, intent) {
  const domain = String(intent?.primary_domain || '');
  if (queryClass === 'gift') {
    return {
      question: 'Is this a gift? I can narrow options by recipient and budget.',
      options: ['Gift for partner', 'Gift for friend/coworker', 'For myself', 'Show popular picks'],
      reason_code: 'CLARIFY_GIFT_SCOPE',
    };
  }
  if (queryClass === 'mission' || queryClass === 'scenario') {
    if (domain === 'beauty') {
      return {
        question: 'Which beauty category should we prioritize first?',
        options: ['Base makeup', 'Eye makeup', 'Lip makeup', 'Skincare'],
        reason_code: 'CLARIFY_BEAUTY_CATEGORY',
      };
    }
    if ((intent?.target_object?.type || '') === 'pet') {
      return {
        question: 'What do you want first for your pet?',
        options: ['Leash/harness', 'Pet apparel', 'Travel accessories', 'Show popular picks'],
        reason_code: 'CLARIFY_PET_CATEGORY',
      };
    }
    return {
      question: 'Which scenario should I optimize for?',
      options: ['Commute/work', 'Date night', 'Business trip/travel', 'Hiking/outdoor'],
      reason_code: 'CLARIFY_SCENARIO',
    };
  }
  if (queryClass === 'attribute') {
    return {
      question: 'To refine results, which constraint matters most?',
      options: ['Budget', 'Brand', 'Use case', 'Show baseline picks'],
      reason_code: 'CLARIFY_ATTRIBUTE',
    };
  }
  if (queryClass === 'non_shopping') {
    return {
      question: 'Which product domain do you want to shop now?',
      options: ['Beauty', 'Pet', 'Travel', 'Outdoor'],
      reason_code: 'CLARIFY_SHOPPING_INTENT',
    };
  }
  return {
    question: 'To avoid off-topic recommendations, what should we prioritize?',
    options: ['Brand lookup', 'Scenario checklist', 'Budget filter', 'Popular picks'],
    reason_code: 'CLARIFY_AMBIGUOUS_QUERY',
  };
}

function buildClarification({ queryClass, intent, language }) {
  const lang = String(language || intent?.language || 'en').toLowerCase();
  const normalizedClass = String(queryClass || intent?.query_class || 'exploratory').toLowerCase();
  const payload = lang === 'zh' ? buildZhClarification(normalizedClass, intent) : buildEnClarification(normalizedClass, intent);
  return {
    question: String(payload.question || ''),
    options: Array.isArray(payload.options) ? payload.options.slice(0, 4) : [],
    reason_code: String(payload.reason_code || 'CLARIFY_AMBIGUOUS_QUERY'),
  };
}

module.exports = {
  buildClarification,
};
