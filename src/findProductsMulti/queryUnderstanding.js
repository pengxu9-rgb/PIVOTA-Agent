const {
  detectBrandEntities,
} = require('./brandLexicon');

const QUERY_UNDERSTANDING_VERSION = 'query_understanding_v1';

const CATEGORY_TYPO_CORRECTIONS = Object.freeze([
  {
    canonical: 'fragrance',
    pattern: /\b(fragarances?|fragances?|fragrences?|fragrancee)\b/gi,
    categoryPathPrefix: 'beauty/fragrance/',
    reason: 'known_beauty_category_typo',
  },
  {
    canonical: 'oily',
    pattern: /\b(aoily|oilly|oilyskin)\b/gi,
    categoryPathPrefix: null,
    reason: 'known_beauty_profile_typo',
  },
]);

const CATEGORY_ALIAS_RULES = Object.freeze([
  {
    category: 'fragrance',
    categoryPathPrefix: 'beauty/fragrance/',
    pattern:
      /\b(perfume|perfumes|fragrance|fragrances|parfum|cologne|eau de parfum|eau de toilette|body mist|scent|scents)\b|香水|香氛|古龙|古龍|香體|香体/i,
  },
  {
    category: 'lipstick',
    categoryPathPrefix: 'beauty/makeup/lip/',
    pattern: /\b(lipsticks?|lip\s*sticks?|lip\s*colors?|lip\s*colours?|liquid\s*lips?|rouge)\b|口红|口紅/i,
  },
  {
    category: 'lip_care_or_gloss',
    categoryPathPrefix: 'beauty/makeup/lip/',
    pattern: /\b(lip\s*oils?|lip\s*balms?|lip\s*treatments?|lip\s*masks?|lip\s*gloss(?:es)?)\b|唇油|润唇|潤唇|唇膜|唇彩/i,
  },
  {
    category: 'mascara',
    categoryPathPrefix: 'beauty/makeup/eye/',
    pattern: /\bmascara\b|睫毛膏/i,
  },
  {
    category: 'sunscreen',
    categoryPathPrefix: 'beauty/skincare/sun/',
    pattern: /\b(sunscreen|sun\s*screen|sunblock|spf\b|broad spectrum|uv|uva|uvb|pa\+{1,4})\b|防晒|防曬|日焼け止め/i,
  },
  {
    category: 'cleanser',
    categoryPathPrefix: 'beauty/skincare/cleanse/',
    pattern: /\b(cleanser|cleansing|face wash|facial wash|cleansing foam|cleansing gel|wash)\b|洁面|潔面|洗顔料/i,
  },
  {
    category: 'moisturizer',
    categoryPathPrefix: 'beauty/skincare/moisturize/',
    pattern: /\b(moisturi(?:z|s)er|cream|lotion|gel cream|gel-cream|barrier cream)\b|面霜|乳液|クリーム/i,
  },
  {
    category: 'serum',
    categoryPathPrefix: 'beauty/skincare/treat/',
    pattern: /\b(serum|essence|ampoule|concentrate)\b|精华|精華|美容液/i,
  },
  {
    category: 'skincare_treatment',
    categoryPathPrefix: 'beauty/skincare/treat/',
    pattern:
      /\b(acne|blemish|breakouts?|pimples?|clogged pores?|congestion|spot treatment|acne treatment|treatment|salicylic(?: acid)?|benzoyl peroxide|azelaic|niacinamide|bha)\b|祛痘|痘痘|闭口|閉口|粉刺|水杨酸|水楊酸/i,
  },
]);

const GENERIC_CATEGORY_BY_PREFIX = Object.freeze({
  'beauty/fragrance/': 'fragrance',
  'beauty/makeup/lip/': 'lipstick',
  'beauty/makeup/eye/': 'mascara',
  'beauty/skincare/sun/': 'sunscreen',
  'beauty/skincare/cleanse/': 'cleanser',
  'beauty/skincare/moisturize/': 'moisturizer',
  'beauty/skincare/treat/': 'serum',
});

function normalizeQueryTextForUnderstanding(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMessages(messages, max = 12) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message) => {
      if (!message || typeof message !== 'object') return null;
      const role = String(message.role || '').trim().toLowerCase();
      const content = String(message.content || '').trim();
      if (!role || !content) return null;
      return {
        role,
        content,
        ...(message.id != null ? { id: String(message.id) } : {}),
        ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
      };
    })
    .filter(Boolean)
    .slice(-max);
}

function applyDeterministicCorrections(rawQuery) {
  let corrected = String(rawQuery || '').trim();
  const corrections = [];
  if (!corrected) return { corrected_query: corrected, corrections };

  for (const rule of CATEGORY_TYPO_CORRECTIONS) {
    corrected = corrected.replace(rule.pattern, (match) => {
      corrections.push({
        token: match,
        replacement: rule.canonical,
        confidence: 0.98,
        source: rule.reason,
        category_path_prefix: rule.categoryPathPrefix,
      });
      return rule.canonical;
    });
  }

  corrected = corrected.replace(/\s+/g, ' ').trim();
  return { corrected_query: corrected, corrections };
}

function hasFragranceFreeSkincareSignal(text) {
  return /\b(fragrance(?:\s|-)?free|fragranceless|unscented|without fragrance|no fragrance|sans parfum)\b/i.test(
    String(text || ''),
  );
}

function hasFragranceProductQuerySignal(text) {
  if (hasFragranceFreeSkincareSignal(text)) return false;
  const raw = String(text || '');
  if (CATEGORY_ALIAS_RULES[0].pattern.test(raw)) return true;
  const corrected = applyDeterministicCorrections(raw).corrected_query;
  return corrected !== raw && CATEGORY_ALIAS_RULES[0].pattern.test(corrected);
}

function resolveBeautyCategoryPathPrefixFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const fragranceFreeSkincare = hasFragranceFreeSkincareSignal(raw);
  for (const rule of CATEGORY_ALIAS_RULES) {
    if (fragranceFreeSkincare && rule.category === 'fragrance') continue;
    if (rule.pattern.test(raw)) return rule.categoryPathPrefix;
  }
  return '';
}

function isStrictLipstickQuery(text) {
  const raw = String(text || '');
  if (!raw) return false;
  if (!/\b(lipsticks?|lip\s*sticks?)\b/i.test(raw) && !/口红|口紅/.test(raw)) return false;
  return !/\b(lip\s*gloss(?:es)?|lip\s*oils?|lip\s*balms?|lip\s*treatments?|lip\s*masks?)\b/i.test(raw);
}

function isGenericCategoryOnlyQuery(text, categoryPathPrefix) {
  const normalized = normalizeQueryTextForUnderstanding(text)
    .replace(/\b(show|find|get|recommend|recommendations|products|items|some|me|for|please|all|shop|buy)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const categoryTerm = GENERIC_CATEGORY_BY_PREFIX[String(categoryPathPrefix || '')];
  if (!normalized || !categoryTerm) return false;
  if (categoryTerm === 'fragrance') {
    return /^(perfume|perfumes|fragrance|fragrances|parfum|cologne|scent|scents)$/.test(normalized);
  }
  if (categoryTerm === 'lipstick') {
    return /^(lipstick|lipsticks|lip stick|lip sticks|rouge)$/.test(normalized);
  }
  return normalized === categoryTerm;
}

function extractPriorUserMessages(conversationMessages, rawQuery) {
  const normalizedRaw = normalizeQueryTextForUnderstanding(rawQuery);
  const messages = normalizeMessages(conversationMessages, 12);
  const out = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const normalizedContent = normalizeQueryTextForUnderstanding(message.content);
    if (!normalizedContent) continue;
    if (!out.length && normalizedRaw && normalizedContent === normalizedRaw) continue;
    out.push(message);
    if (out.length >= 5) break;
  }
  return out;
}

function extractBeautyProfileSignals(text) {
  const raw = String(text || '');
  const normalized = normalizeQueryTextForUnderstanding(raw);
  const signals = {
    skin_type: null,
    environment: null,
    location: null,
    has_profile_signal: false,
  };

  if (
    /\b(oily|oilier|greasy|shiny|sebum|oil prone|oil-prone)\b/.test(normalized) ||
    /油皮|混油|出油/.test(raw)
  ) {
    signals.skin_type = 'oily';
  } else if (/\b(combination|combo)\b/.test(normalized) || /混合/.test(raw)) {
    signals.skin_type = 'combination';
  } else if (/\b(dry|dehydrated)\b/.test(normalized) || /干皮|乾皮|缺水/.test(raw)) {
    signals.skin_type = 'dry';
  } else if (/\b(sensitive|sensitized|reactive)\b/.test(normalized) || /敏感/.test(raw)) {
    signals.skin_type = 'sensitive';
  } else if (/\b(normal)\s+skin\b/.test(normalized) || /中性/.test(raw)) {
    signals.skin_type = 'normal';
  }

  if (/\b(sf|san francisco|bay area)\b/.test(normalized) || /旧金山|舊金山|湾区|灣區/.test(raw)) {
    signals.location = 'San Francisco';
    signals.environment = 'San Francisco';
  } else {
    const liveInMatch = normalized.match(/\b(?:live|living|based|located)\s+in\s+([a-z][a-z\s]{1,40})\b/);
    if (liveInMatch && liveInMatch[1]) {
      const value = liveInMatch[1]
        .replace(/\b(and|with|but|my|skin|type|is|i)\b.*$/i, '')
        .trim();
      if (value && value.length <= 32) {
        signals.location = value.replace(/\b\w/g, (char) => char.toUpperCase());
        signals.environment = signals.location;
      }
    }
  }

  signals.has_profile_signal = Boolean(signals.skin_type || signals.environment || signals.location);
  return signals;
}

function extractBeautyConcernSignals(text) {
  const raw = String(text || '');
  const normalized = normalizeQueryTextForUnderstanding(raw);
  const concerns = [];
  const push = (value) => {
    if (!value || concerns.includes(value)) return;
    concerns.push(value);
  };

  if (/\b(acne|blemish|breakouts?|pimples?|zits?)\b/.test(normalized) || /祛痘|痘痘|粉刺/.test(raw)) {
    push('acne');
  }
  if (/\b(clogged pores?|congestion|blackheads?|whiteheads?)\b/.test(normalized) || /闭口|閉口|黑头|黑頭|毛孔/.test(raw)) {
    push('clogged_pores');
  }
  if (/\b(oily skin|oil control|shine control|sebum|greasy|shiny)\b/.test(normalized) || /控油|出油/.test(raw)) {
    push('oil_control');
  }

  const hasConcernSignal = concerns.length > 0;
  return {
    concerns,
    primary_concern: concerns[0] || null,
    category_path_prefix: hasConcernSignal ? 'beauty/skincare/treat/' : null,
    target_step_family: hasConcernSignal ? 'treatment' : null,
    semantic_family: concerns.includes('acne')
      ? 'acne'
      : concerns.includes('oil_control')
        ? 'oil_control'
        : concerns.includes('clogged_pores')
          ? 'oil_control'
          : null,
    has_concern_signal: hasConcernSignal,
  };
}

function isBeautyProfileOnlyFollowup(text, profileSignals, concernSignals) {
  const normalized = normalizeQueryTextForUnderstanding(text);
  if (!normalized || !profileSignals?.has_profile_signal) return false;
  if (resolveBeautyCategoryPathPrefixFromText(text)) return false;
  const hasProductIntent = /\b(recommend|recommendation|products?|buy|shop|find|show|need|looking for|serum|cleanser|moisturizer|sunscreen|treatment)\b/.test(
    normalized,
  );
  const concernIsOnlyProfileSkinType =
    concernSignals?.has_concern_signal &&
    Array.isArray(concernSignals.concerns) &&
    concernSignals.concerns.length === 1 &&
    concernSignals.primary_concern === 'oil_control' &&
    Boolean(profileSignals.skin_type) &&
    !hasProductIntent;
  if (concernSignals?.has_concern_signal && !concernIsOnlyProfileSkinType) return false;
  return !hasProductIntent;
}

function buildBeautySlotContextualQuery({ concernSignals, profileSignals }) {
  const parts = [];
  if (concernSignals?.primary_concern === 'acne') parts.push('acne treatment serum');
  else if (concernSignals?.primary_concern === 'clogged_pores') parts.push('clogged pores treatment serum');
  else if (concernSignals?.primary_concern === 'oil_control') parts.push('oil control treatment serum');
  else parts.push('skincare treatment serum');

  if (profileSignals?.skin_type) parts.push(`${profileSignals.skin_type} skin`);
  if (profileSignals?.environment) parts.push(profileSignals.environment);
  return Array.from(new Set(parts.map((item) => String(item || '').trim()).filter(Boolean))).join(' ');
}

function maybeBindBeautySlotFollowupContext({
  rawQuery,
  correctedQuery,
  conversationMessages,
  currentProfileSignals,
  currentConcernSignals,
}) {
  if (!isBeautyProfileOnlyFollowup(correctedQuery || rawQuery, currentProfileSignals, currentConcernSignals)) {
    return null;
  }
  const priorUserMessages = extractPriorUserMessages(conversationMessages, rawQuery);
  for (const message of priorUserMessages) {
    const priorCorrected = applyDeterministicCorrections(message.content).corrected_query || message.content;
    const priorConcernSignals = extractBeautyConcernSignals(priorCorrected);
    if (!priorConcernSignals.has_concern_signal) continue;
    const contextualQuery = buildBeautySlotContextualQuery({
      concernSignals: priorConcernSignals,
      profileSignals: currentProfileSignals,
    });
    if (!contextualQuery) continue;
    return {
      scope: 'conversation',
      source: 'current_conversation_messages',
      source_query: message.content,
      category_path_prefix: priorConcernSignals.category_path_prefix,
      reason: 'beauty_slot_followup_conversation_context',
      contextual_query: contextualQuery,
      beauty_context: {
        concern: priorConcernSignals.primary_concern,
        concerns: priorConcernSignals.concerns,
        target_step_family: priorConcernSignals.target_step_family,
        semantic_family: priorConcernSignals.semantic_family,
        skin_type: currentProfileSignals.skin_type,
        environment: currentProfileSignals.environment,
        location: currentProfileSignals.location,
      },
    };
  }
  return null;
}

function maybeBindConversationContext({ rawQuery, correctedQuery, categoryPathPrefix, conversationMessages }) {
  if (!isGenericCategoryOnlyQuery(correctedQuery || rawQuery, categoryPathPrefix)) return null;
  const priorUserMessages = extractPriorUserMessages(conversationMessages, rawQuery);
  for (const message of priorUserMessages) {
    const prior = understandShoppingQuery({
      rawQuery: message.content,
      conversationMessages: [],
      sessionRecentQueries: [],
      allowContextBinding: false,
    });
    const priorBrand = Array.isArray(prior.brand_candidates) ? prior.brand_candidates[0] : '';
    if (!priorBrand || prior.category_path_prefix !== categoryPathPrefix) continue;
    const categoryTerm = GENERIC_CATEGORY_BY_PREFIX[categoryPathPrefix] || String(correctedQuery || rawQuery).trim();
    return {
      scope: 'conversation',
      source: 'current_conversation_messages',
      source_query: message.content,
      brand: priorBrand,
      category_path_prefix: categoryPathPrefix,
      reason: 'generic_category_followup_conversation_brand',
      contextual_query: `${priorBrand} ${categoryTerm}`.trim(),
    };
  }
  return null;
}

function isExplicitSessionContinuationQuery(text) {
  const normalized = normalizeQueryTextForUnderstanding(text);
  if (!normalized) return false;
  return (
    /\b(continue|resume|use|show|get|repeat)\s+(the\s+)?(previous|last|prior)\s+(search|query|results?)\b/.test(normalized) ||
    /\b(same|again)\s+as\s+(before|last\s+time|previous)\b/.test(normalized) ||
    /\b(previous|last)\s+(search|query|results?)\b/.test(normalized) ||
    /继续(刚才|之前|上次)|接着(刚才|之前|上次)|刚才那个|之前那个|上次那个/.test(String(text || ''))
  );
}

function maybeBindExplicitSessionContext({ rawQuery, correctedQuery, categoryPathPrefix, sessionRecentQueries }) {
  if (!isExplicitSessionContinuationQuery(correctedQuery || rawQuery)) return null;
  const history = Array.isArray(sessionRecentQueries) ? sessionRecentQueries : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const sourceQuery = String(history[i] || '').trim();
    if (!sourceQuery) continue;
    const prior = understandShoppingQuery({
      rawQuery: sourceQuery,
      conversationMessages: [],
      sessionRecentQueries: [],
      allowContextBinding: false,
    });
    const contextualQuery = String(prior?.effective_query || prior?.corrected_query || sourceQuery).trim();
    if (!contextualQuery) continue;
    if (categoryPathPrefix && prior?.category_path_prefix && prior.category_path_prefix !== categoryPathPrefix) {
      continue;
    }
    return {
      scope: 'session_explicit',
      source: 'session_recent_queries',
      source_query: sourceQuery,
      brand: Array.isArray(prior?.brand_candidates) ? prior.brand_candidates[0] || null : null,
      category_path_prefix: prior?.category_path_prefix || categoryPathPrefix || null,
      reason: 'explicit_session_previous_query',
      contextual_query: contextualQuery,
    };
  }
  return null;
}

function buildBrandCandidates(queryText) {
  const detected = detectBrandEntities(queryText, { candidateProducts: [] });
  return Array.isArray(detected?.brands) ? detected.brands : [];
}

function understandShoppingQuery({
  rawQuery,
  conversationMessages = [],
  sessionRecentQueries = [],
  market = null,
  source = null,
  allowContextBinding = true,
} = {}) {
  const raw = String(rawQuery || '').trim();
  const normalized = normalizeQueryTextForUnderstanding(raw);
  const correctionResult = applyDeterministicCorrections(raw);
  const correctedQuery = correctionResult.corrected_query || raw;
  const correctedNormalized = normalizeQueryTextForUnderstanding(correctedQuery);
  const categoryPathPrefix = resolveBeautyCategoryPathPrefixFromText(correctedQuery);
  const brandCandidates = buildBrandCandidates(correctedQuery);
  const currentProfileSignals = extractBeautyProfileSignals(correctedQuery);
  const currentConcernSignals = extractBeautyConcernSignals(correctedQuery);
  const riskFlags = [];
  if (hasFragranceFreeSkincareSignal(correctedQuery)) riskFlags.push('fragrance_free_skincare_guard');
  if (Array.isArray(sessionRecentQueries) && sessionRecentQueries.length) {
    riskFlags.push('session_recent_queries_ignored_for_context');
  }

  const contextBinding = allowContextBinding
    ? maybeBindConversationContext({
        rawQuery: raw,
        correctedQuery,
        categoryPathPrefix,
        conversationMessages,
      }) ||
      maybeBindBeautySlotFollowupContext({
        rawQuery: raw,
        correctedQuery,
        conversationMessages,
        currentProfileSignals,
        currentConcernSignals,
      }) ||
      maybeBindExplicitSessionContext({
        rawQuery: raw,
        correctedQuery,
        categoryPathPrefix,
        sessionRecentQueries,
      })
    : null;
  const effectiveQuery = contextBinding?.contextual_query || correctedQuery || raw;
  const effectiveCategoryPathPrefix =
    contextBinding?.category_path_prefix ||
    resolveBeautyCategoryPathPrefixFromText(effectiveQuery) ||
    categoryPathPrefix ||
    null;
  const effectiveProfileSignals = extractBeautyProfileSignals(effectiveQuery);
  const effectiveConcernSignals = extractBeautyConcernSignals(effectiveQuery);
  if (contextBinding?.reason === 'beauty_slot_followup_conversation_context') {
    riskFlags.push('beauty_slot_followup_bound');
  }
  const decision = contextBinding
    ? 'apply_conversation_context'
    : correctionResult.corrections.length
      ? 'apply_correction'
      : 'apply_raw';

  return {
    version: QUERY_UNDERSTANDING_VERSION,
    query_understanding_executed: true,
    raw_query: raw,
    normalized_query: normalized,
    corrected_query: correctedQuery,
    corrected_normalized_query: correctedNormalized,
    effective_query: effectiveQuery,
    corrections: correctionResult.corrections,
    brand_candidates: brandCandidates,
    category_path_prefix: effectiveCategoryPathPrefix,
    context_binding: contextBinding,
    context_scope: contextBinding?.scope || 'none',
    risk_flags: riskFlags,
    decision,
    beauty_context: {
      current_profile: currentProfileSignals,
      current_concerns: currentConcernSignals,
      effective_profile: effectiveProfileSignals,
      effective_concerns: effectiveConcernSignals,
      ...(contextBinding?.beauty_context ? { bound: contextBinding.beauty_context } : {}),
    },
    hard_negatives: {
      fragrance_free_skincare: hasFragranceFreeSkincareSignal(correctedQuery),
      strict_lipstick: isStrictLipstickQuery(correctedQuery),
    },
    ...(market ? { market: String(market).trim().toUpperCase() } : {}),
    ...(source ? { source: String(source).trim() } : {}),
  };
}

module.exports = {
  QUERY_UNDERSTANDING_VERSION,
  understandShoppingQuery,
  normalizeQueryTextForUnderstanding,
  resolveBeautyCategoryPathPrefixFromText,
  hasFragranceFreeSkincareSignal,
  hasFragranceProductQuerySignal,
  isStrictLipstickQuery,
};
