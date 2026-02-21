const scenarioCategoryMap = require('./scenario_category_map.json');

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function containsAny(text, patterns) {
  if (!text) return false;
  return patterns.some((pattern) => text.includes(String(pattern || '').toLowerCase()));
}

function resolveDomainKey({ intent, query }) {
  const normalizedQuery = normalizeText(query);
  const target = String(intent?.target_object?.type || '').toLowerCase();
  const primaryDomain = String(intent?.primary_domain || '').toLowerCase();

  if (target === 'pet') return 'pet';
  if (primaryDomain === 'beauty') return 'beauty';
  if (
    containsAny(normalizedQuery, [
      'travel',
      'trip',
      'business trip',
      'packing',
      '出差',
      '旅行',
      '旅游',
      '差旅',
    ])
  ) {
    return 'travel';
  }
  if (
    containsAny(normalizedQuery, [
      'hiking',
      'camping',
      'trail',
      'outdoor',
      '徒步',
      '登山',
      '露营',
      '户外',
    ])
  ) {
    return 'hiking';
  }
  if (primaryDomain === 'sports_outdoor') return 'hiking';
  if (primaryDomain && scenarioCategoryMap[primaryDomain]) return primaryDomain;
  return 'default';
}

function resolveScenarioKey({ intent, queryClass, query }) {
  const normalizedQuery = normalizeText(query);
  const scenarioName = String(intent?.scenario?.name || '').toLowerCase();

  if (queryClass === 'gift') return 'gift';
  if (scenarioName.includes('date') || containsAny(normalizedQuery, ['约会', '約會', 'date night', 'date'])) {
    return 'date';
  }
  if (
    scenarioName.includes('trip') ||
    containsAny(normalizedQuery, ['business trip', 'travel', '出差', '旅行', '差旅'])
  ) {
    return 'business_trip';
  }
  if (containsAny(normalizedQuery, ['hiking', 'trail', '徒步', '登山'])) return 'hiking';
  if (containsAny(normalizedQuery, ['camping', '露营', '露營'])) return 'camping';
  if (containsAny(normalizedQuery, ['walk', 'leash', 'harness', '遛狗', '狗链', '牵引'])) return 'walk';
  if (scenarioName && scenarioName !== 'general' && scenarioName !== 'browse') return scenarioName;
  return 'default';
}

function getScenarioKeywords({ domainKey, scenarioKey }) {
  const domainMap = scenarioCategoryMap[domainKey] || scenarioCategoryMap.default || {};
  const keywords = domainMap[scenarioKey] || domainMap.default || [];
  return Array.isArray(keywords) ? keywords.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function buildScenarioAssociationPlan({ query, intent, queryClass }) {
  const normalizedClass = String(queryClass || intent?.query_class || '').toLowerCase();
  if (!['mission', 'scenario', 'gift', 'exploratory'].includes(normalizedClass)) {
    return {
      applied: false,
      blocked_reason: 'query_class_not_supported',
      domain_key: null,
      scenario_key: null,
      category_keywords: [],
    };
  }

  const domainKey = resolveDomainKey({ intent, query });
  const scenarioKey = resolveScenarioKey({ intent, queryClass: normalizedClass, query });
  const categoryKeywords = getScenarioKeywords({ domainKey, scenarioKey });

  if (!categoryKeywords.length) {
    return {
      applied: false,
      blocked_reason: 'no_association_keywords',
      domain_key: domainKey,
      scenario_key: scenarioKey,
      category_keywords: [],
    };
  }

  return {
    applied: true,
    blocked_reason: null,
    domain_key: domainKey,
    scenario_key: scenarioKey,
    category_keywords: categoryKeywords.slice(0, 8),
  };
}

module.exports = {
  buildScenarioAssociationPlan,
};
