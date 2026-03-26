const FILTERABLE_CLARIFICATION_FIELDS = new Set([
  'skinType',
  'sensitivity',
  'barrierStatus',
  'goals',
  'budgetTier',
]);

const RESUME_KNOWN_PROFILE_FIELDS = Object.freeze([
  'skinType',
  'sensitivity',
  'barrierStatus',
  'goals',
  'budgetTier',
]);
const RESUME_PREFIX_KNOWN_FIELD_MAX_VALUE = 40;
const RESUME_PREFIX_KNOWN_GOALS_MAX_ITEMS = 5;

const RESUME_REASK_PATTERNS = Object.freeze({
  skinType: [
    /what(?:'s| is)\s+your\s+skin\s+type/i,
    /which\s+skin\s+type/i,
    /(?:你的|您).{0,8}(?:肤质|皮肤类型).{0,8}(?:是|属于|吗|\?|？)/i,
  ],
  barrierStatus: [
    /is\s+your\s+barrier\s+(?:stable|healthy|ok)/i,
    /do\s+you\s+have\s+stinging(?:\/|\s+or\s+)redness/i,
    /stinging\/redness/i,
    /(?:屏障).{0,12}(?:稳定|刺痛|泛红|受损).{0,6}(?:吗|\?|？)/i,
  ],
  goals: [
    /what(?:'s| is)\s+your\s+(?:main|top)\s+goal/i,
    /what\s+is\s+your\s+goal/i,
    /(?:你的|您).{0,8}(?:主要|首要|最想).{0,8}(?:目标|诉求).{0,6}(?:是|吗|\?|？)/i,
  ],
});

function parseClarificationIdFromActionId(actionId) {
  const id = String(actionId || '').trim();
  if (!id) return '';
  const parts = id.split('.');
  if (parts.length < 4) return '';
  if (parts[0] !== 'chip' || parts[1] !== 'clarify') return '';
  return String(parts[2] || '').trim();
}

function parseClarificationReplyFromActionId(actionId) {
  const id = String(actionId || '').trim();
  if (!id) return '';
  const parts = id.split('.');
  if (parts.length < 4) return '';
  if (parts[0] !== 'chip' || parts[1] !== 'clarify') return '';
  return String(parts.slice(3).join(' ') || '')
    .replace(/_/g, ' ')
    .trim();
}

function isUnsureToken(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return false;
  return (
    text === 'unknown' ||
    text === 'unsure' ||
    text === 'not sure' ||
    text === 'n/a' ||
    text === 'na' ||
    /不确定|不知道|不清楚/.test(text)
  );
}

function createClarificationStateHelpers(options = {}) {
  const {
    stableHashBase36 = (value) => String(value == null ? '' : value),
    recordClarificationIdNormalizedEmpty = () => {},
    normalizeBudgetHint = (value) => String(value || '').trim(),
  } = options;

  function normalizeClarificationField(raw) {
    const rawText = String(raw == null ? '' : raw).trim();
    const lowered = rawText.toLowerCase();
    let norm = lowered
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}_:]+/gu, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');

    if (!norm) {
      recordClarificationIdNormalizedEmpty();
      norm = `cid_${stableHashBase36(rawText).slice(0, 12)}`;
    }

    const haystack = `${lowered} ${norm}`;
    if (/(budget|price|spend|预算|价位|预算档)/.test(haystack)) return 'budgetTier';
    if (/(goal|concern|target|focus|目标|诉求|优先|最想|想解决)/.test(haystack)) return 'goals';
    if (/(barrier|sting|red|irrit|reactive|屏障|耐受|刺痛|泛红|发红|刺激)/.test(haystack)) return 'barrierStatus';
    if (/(sensit|敏感程度|敏感性)/.test(haystack)) return 'sensitivity';
    if (/(skin|肤质|皮肤类型|油皮|干皮|混合|中性|oily|dry|combo|combination|mixed|normal)/.test(haystack)) return 'skinType';
    return norm;
  }

  function hasKnownClarificationFieldValue(profileSummary, field) {
    if (!field || !profileSummary || typeof profileSummary !== 'object') return false;
    const norm = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
    if (field === 'skinType') {
      const value = norm(profileSummary.skinType);
      return Boolean(value && value !== 'unknown');
    }
    if (field === 'sensitivity') {
      const value = norm(profileSummary.sensitivity);
      return Boolean(value && value !== 'unknown');
    }
    if (field === 'barrierStatus') {
      const value = norm(profileSummary.barrierStatus);
      return Boolean(value && value !== 'unknown');
    }
    if (field === 'goals') {
      const goals = Array.isArray(profileSummary.goals) ? profileSummary.goals : [];
      return goals.some((goal) => norm(goal));
    }
    if (field === 'budgetTier') {
      const value = norm(profileSummary.budgetTier);
      return Boolean(value && value !== 'unknown');
    }
    return false;
  }

  function truncateResumeKnownValue(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text || isUnsureToken(text)) return '';
    if (text.length <= RESUME_PREFIX_KNOWN_FIELD_MAX_VALUE) return text;
    return text.slice(0, RESUME_PREFIX_KNOWN_FIELD_MAX_VALUE);
  }

  function buildResumeKnownProfileFields(profileSummary) {
    if (!profileSummary || typeof profileSummary !== 'object') return null;
    const out = {};

    if (hasKnownClarificationFieldValue(profileSummary, 'skinType')) {
      const skinType = truncateResumeKnownValue(profileSummary.skinType);
      if (skinType) out.skinType = skinType;
    }

    if (hasKnownClarificationFieldValue(profileSummary, 'sensitivity')) {
      const sensitivity = truncateResumeKnownValue(profileSummary.sensitivity);
      if (sensitivity) out.sensitivity = sensitivity;
    }

    if (hasKnownClarificationFieldValue(profileSummary, 'barrierStatus')) {
      const barrierStatus = truncateResumeKnownValue(profileSummary.barrierStatus);
      if (barrierStatus) out.barrierStatus = barrierStatus;
    }

    if (hasKnownClarificationFieldValue(profileSummary, 'goals')) {
      const goals = (Array.isArray(profileSummary.goals) ? profileSummary.goals : [])
        .map((goal) => truncateResumeKnownValue(goal))
        .filter(Boolean)
        .slice(0, RESUME_PREFIX_KNOWN_GOALS_MAX_ITEMS);
      if (goals.length) out.goals = goals;
    }

    if (hasKnownClarificationFieldValue(profileSummary, 'budgetTier')) {
      const budgetTier = truncateResumeKnownValue(profileSummary.budgetTier);
      if (budgetTier) out.budgetTier = budgetTier;
    }

    return Object.keys(out).length ? out : null;
  }

  function detectResumePlaintextReaskFields(answerText, knownProfileFields) {
    const text = String(answerText || '');
    if (!text || !knownProfileFields || typeof knownProfileFields !== 'object') return [];
    const detected = [];
    for (const field of RESUME_KNOWN_PROFILE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(knownProfileFields, field)) continue;
      const patterns = RESUME_REASK_PATTERNS[field];
      if (!Array.isArray(patterns) || !patterns.length) continue;
      if (patterns.some((pattern) => pattern.test(text))) detected.push(field);
    }
    return detected;
  }

  function isClarifyChipAction(action, { actionId, clarificationId } = {}) {
    const id =
      typeof actionId === 'string'
        ? actionId.trim()
        : typeof action === 'string'
          ? action.trim()
          : action && typeof action === 'object' && typeof action.action_id === 'string'
            ? action.action_id.trim()
            : '';
    if (id.toLowerCase().startsWith('chip.clarify.')) return true;
    if (parseClarificationIdFromActionId(id)) return true;
    return Boolean(typeof clarificationId === 'string' && clarificationId.trim());
  }

  function hasPendingClarificationStateHint(action) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) return false;
    const data = action.data && typeof action.data === 'object' ? action.data : null;
    if (!data) return false;
    if (Object.prototype.hasOwnProperty.call(data, 'clarification_step')) return true;
    if (typeof data.clarification_question_id === 'string' && data.clarification_question_id.trim()) return true;
    if (typeof data.clarificationQuestionId === 'string' && data.clarificationQuestionId.trim()) return true;
    return false;
  }

  function extractClarificationQuestionIdFromAction(action) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) return '';
    const data = action.data && typeof action.data === 'object' ? action.data : null;
    if (!data) return '';
    const raw =
      (typeof data.clarification_question_id === 'string' && data.clarification_question_id) ||
      (typeof data.clarificationQuestionId === 'string' && data.clarificationQuestionId) ||
      '';
    return String(raw || '').trim();
  }

  function inferGoalFromClarificationText(raw) {
    const text = String(raw || '').trim().toLowerCase();
    if (!text) return '';
    if (/(acne|breakout|pore|oil|控痘|痘|闭口|粉刺|毛孔|出油)/.test(text)) return 'acne';
    if (/(redness|sensitive|reactive|泛红|敏感|刺痛|修护屏障|屏障)/.test(text)) return 'redness';
    if (/(dark spot|pigment|bright|tone|淡斑|美白|提亮|暗沉|色沉|痘印)/.test(text)) return 'dark_spots';
    if (/(dry|hydrate|moist|保湿|补水|干燥|紧绷)/.test(text)) return 'dehydration';
    if (/(wrinkle|fine line|firm|anti[- ]?aging|抗老|抗衰|细纹|紧致|提拉)/.test(text)) return 'wrinkles';
    return '';
  }

  function inferProfilePatchFromClarification({ clarificationId, replyText }) {
    const field = normalizeClarificationField(clarificationId);
    const raw = String(replyText || '').trim();
    const text = raw.toLowerCase();
    if (!field || !raw) return null;

    if (field === 'skinType') {
      if (/\boily\b/.test(text) || /(油皮|油性|出油)/.test(text)) return { skinType: 'oily' };
      if (/\bdry\b/.test(text) || /(干皮|干性|干燥|紧绷)/.test(text)) return { skinType: 'dry' };
      if (/\b(combo|combination|mixed)\b/.test(text) || /混合/.test(text)) return { skinType: 'combination' };
      if (/\bnormal\b/.test(text) || /中性/.test(text)) return { skinType: 'normal' };
      if (/\bsensitive\b/.test(text) || /敏感/.test(text)) return { skinType: 'sensitive' };
      if (isUnsureToken(text)) return { skinType: 'unknown' };
      return null;
    }

    if (field === 'barrierStatus') {
      if (/(stable|healthy|normal|ok|good|稳定|健康)/.test(text)) return { barrierStatus: 'healthy' };
      if (/(sting|stinging|red|irrit|burn|reactive|impaired|damaged|刺痛|泛红|发红|刺激|不稳定|受损)/.test(text)) {
        return { barrierStatus: 'impaired' };
      }
      if (isUnsureToken(text)) return { barrierStatus: 'unknown' };
      return null;
    }

    if (field === 'sensitivity') {
      if (/(^|\b)(low|mild)\b|低|轻/.test(text)) return { sensitivity: 'low' };
      if (/(^|\b)(medium|mid|moderate)\b|中/.test(text)) return { sensitivity: 'medium' };
      if (/(^|\b)(high|severe|very)\b|高|重/.test(text)) return { sensitivity: 'high' };
      if (/(^|\b)yes(\b|$)|有|容易刺痛/.test(text)) return { sensitivity: 'high' };
      if (/(^|\b)no(\b|$)|无|不敏感/.test(text)) return { sensitivity: 'low' };
      if (isUnsureToken(text)) return { sensitivity: 'unknown' };
      return null;
    }

    if (field === 'goals') {
      if (isUnsureToken(text)) return { goals: ['unknown'] };
      const goal = inferGoalFromClarificationText(text);
      if (goal) return { goals: [goal] };
      const normalized = raw.replace(/\s+/g, ' ').trim().slice(0, 80);
      return normalized ? { goals: [normalized] } : null;
    }

    if (field === 'budgetTier') {
      const budget = normalizeBudgetHint(raw);
      return { budgetTier: budget || raw.slice(0, 40) };
    }

    return null;
  }

  return {
    filterableClarificationFields: FILTERABLE_CLARIFICATION_FIELDS,
    normalizeClarificationField,
    hasKnownClarificationFieldValue,
    buildResumeKnownProfileFields,
    detectResumePlaintextReaskFields,
    isClarifyChipAction,
    hasPendingClarificationStateHint,
    extractClarificationQuestionIdFromAction,
    inferGoalFromClarificationText,
    inferProfilePatchFromClarification,
    parseClarificationIdFromActionId,
    parseClarificationReplyFromActionId,
  };
}

module.exports = {
  FILTERABLE_CLARIFICATION_FIELDS,
  createClarificationStateHelpers,
  parseClarificationIdFromActionId,
  parseClarificationReplyFromActionId,
};
