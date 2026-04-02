'use strict';

const crypto = require('crypto');

const CONCERN_PLANNER_PROMPT_VERSION = 'concern_semantic_plan_v1';
const CONCERN_SEMANTIC_PLAN_NORMALIZER_VERSION = 'concern_semantic_plan_normalizer_v1';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickFirstTrimmed(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function uniqCaseInsensitiveStrings(items, max = 80) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function asStringArray(value, max = 20) {
  if (Array.isArray(value)) {
    return uniqCaseInsensitiveStrings(value.map((item) => String(item || '').trim()).filter(Boolean), max);
  }
  const token = pickFirstTrimmed(value);
  return token ? [token] : [];
}

function normalizeConcernRoleHint(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\-\/]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeRecoTargetStep(value) {
  const token = String(value || '').trim().toLowerCase();
  if (!token) return '';
  if (token.includes('sunscreen') || token.includes('spf') || token.includes('sun')) return 'sunscreen';
  if (token.includes('moistur') || token.includes('cream') || token.includes('lotion') || token.includes('gel cream')) return 'moisturizer';
  if (token.includes('mask')) return 'mask';
  if (token.includes('serum')) return 'serum';
  if (token.includes('treatment') || token.includes('retinol') || token.includes('acid')) return 'treatment';
  if (token.includes('cleanser') || token.includes('wash')) return 'cleanser';
  return token;
}

function inferSlotForStep(step) {
  const token = normalizeRecoTargetStep(step);
  if (token === 'sunscreen') return 'day';
  if (token === 'mask') return 'optional';
  return 'care';
}

function buildConcernSemanticPlanTextPromptBundle({
  requestText = '',
  focus = '',
  lang = 'EN',
  profileSummary = null,
  recommendationTaskContext = null,
  fallbackPlan = null,
} = {}) {
  const isCn = String(lang || '').trim().toUpperCase() === 'CN';
  const profile = isPlainObject(profileSummary) ? profileSummary : {};
  const taskContext = isPlainObject(recommendationTaskContext) ? recommendationTaskContext : null;
  const plan = isPlainObject(fallbackPlan) ? fallbackPlan : {};
  const contextPayload = {
    request_text: String(requestText || '').trim(),
    focus: String(focus || '').trim() || null,
    profile: {
      skin_type: pickFirstTrimmed(profile.skinType, profile.skin_type) || null,
      sensitivity: pickFirstTrimmed(profile.sensitivity) || null,
      barrier_status: pickFirstTrimmed(profile.barrierStatus, profile.barrier_status) || null,
      goals: Array.isArray(profile.goals) ? profile.goals : [],
    },
    allowed_role_ids: {
      core: Array.isArray(plan.core_roles) ? plan.core_roles.map((role) => pickFirstTrimmed(role?.role_id)).filter(Boolean).slice(0, 3) : [],
      support: Array.isArray(plan.support_roles) ? plan.support_roles.map((role) => pickFirstTrimmed(role?.role_id)).filter(Boolean).slice(0, 2) : [],
    },
    task_context: taskContext && taskContext.snapshot_fields_used
      ? {
          context_mode: String(taskContext.context_mode || '').trim() || null,
          snapshot_fields_used: Array.isArray(taskContext.snapshot_fields_used) ? taskContext.snapshot_fields_used.slice(0, 6) : [],
        }
      : null,
  };

  const instructions = isCn
    ? [
        `[PROMPT_VERSION=${CONCERN_PLANNER_PROMPT_VERSION}]`,
        '角色：严格的护肤通用关切规划器。',
        '任务：只给出第一轮护理框架，不推荐具体商品。',
        '只输出纯文本，严格使用以下键名和单行格式：',
        'PRIMARY_CONCERN: ...',
        'CORE_ROLE_IDS: role_id | role_id | role_id',
        'SUPPORT_ROLE_IDS: role_id | role_id',
        'INGREDIENT_HYPOTHESES: item | item | item',
        'PRODUCT_TYPE_HYPOTHESES: item | item | item',
        'ROUTINE_SHELL_HINTS: AM=role_id,role_id; PM=role_id,role_id; OPTIONAL=role_id',
        '规则：',
        '- 只能使用 context.allowed_role_ids 里的 role_id。',
        '- 先决定 core roles，再决定 optional support roles。',
        '- support roles 不能替代 core roles。',
        '- 不要返回 JSON。',
        '- 不要返回品牌、SKU、价格、链接。',
      ]
    : [
        `[PROMPT_VERSION=${CONCERN_PLANNER_PROMPT_VERSION}]`,
        'Role: strict skincare generic-concern planner.',
        'Task: return only the first-turn care framework, not specific products.',
        'Output plain text only in these single-line keys:',
        'PRIMARY_CONCERN: ...',
        'CORE_ROLE_IDS: role_id | role_id | role_id',
        'SUPPORT_ROLE_IDS: role_id | role_id',
        'INGREDIENT_HYPOTHESES: item | item | item',
        'PRODUCT_TYPE_HYPOTHESES: item | item | item',
        'ROUTINE_SHELL_HINTS: AM=role_id,role_id; PM=role_id,role_id; OPTIONAL=role_id',
        'Rules:',
        '- Only use role_ids from context.allowed_role_ids.',
        '- Decide core roles first, then optional support roles.',
        '- Support roles cannot replace core roles.',
        '- Do not return JSON.',
        '- Do not return brands, SKUs, prices, or links.',
      ];
  return {
    systemPrompt: instructions.join('\n'),
    userPrompt: `context=${JSON.stringify(contextPayload)}`,
    query: `${instructions.join('\n')}\ncontext=${JSON.stringify(contextPayload)}`,
  };
}

function matchFallbackRoleFromToken(token, fallbackRoles = []) {
  const normalizedToken = normalizeConcernRoleHint(token);
  if (!normalizedToken) return null;
  for (const role of Array.isArray(fallbackRoles) ? fallbackRoles : []) {
    if (!isPlainObject(role)) continue;
    const candidates = uniqCaseInsensitiveStrings([
      role.role_id,
      role.label,
      ...(Array.isArray(role.query_terms) ? role.query_terms.slice(0, 4) : []),
      ...(Array.isArray(role.fit_keywords) ? role.fit_keywords.slice(0, 4) : []),
    ], 12)
      .map((value) => normalizeConcernRoleHint(value))
      .filter(Boolean);
    if (candidates.some((candidate) => candidate === normalizedToken || normalizedToken.includes(candidate) || candidate.includes(normalizedToken))) {
      return role;
    }
  }
  return null;
}

function splitSectionTokens(value) {
  return uniqCaseInsensitiveStrings(
    String(value || '')
      .split(/[\|\n;,]+/g)
      .map((item) => String(item || '').replace(/^\d+\.\s*/, '').trim())
      .filter(Boolean),
    12,
  );
}

function extractLineValue(text, labels = []) {
  const lines = String(text || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line) continue;
    for (const label of labels) {
      const prefix = `${label}:`;
      if (line.toUpperCase().startsWith(prefix.toUpperCase())) {
        return line.slice(prefix.length).trim();
      }
    }
  }
  return '';
}

function parseRoutineShellHints(value, { coreRoles = [], supportRoles = [] } = {}) {
  const roleIds = new Set([...coreRoles, ...supportRoles].map((role) => String(role?.role_id || '').trim()).filter(Boolean));
  const mapping = {};
  const parts = String(value || '').split(/[;；]/g);
  for (const raw of parts) {
    const [keyRaw, valueRaw] = String(raw || '').split('=');
    const key = String(keyRaw || '').trim().toUpperCase();
    const roleIdsForKey = splitSectionTokens(valueRaw).filter((token) => roleIds.has(token));
    if (!roleIdsForKey.length) continue;
    if (key === 'AM') mapping.am_core_roles = roleIdsForKey;
    if (key === 'PM') mapping.pm_core_roles = roleIdsForKey;
    if (key === 'OPTIONAL') mapping.optional_support_roles = roleIdsForKey;
  }
  return mapping;
}

function scoreConcernSemanticRoleFromText(answerText, role) {
  const normalizedText = normalizeConcernRoleHint(answerText);
  const row = isPlainObject(role) ? role : null;
  if (!normalizedText || !row) return { score: 0, matched: false };
  let score = 0;
  const strongPatterns = uniqCaseInsensitiveStrings(
    [
      row.role_id,
      row.label,
      ...asStringArray(row.query_terms),
      ...asStringArray(row.fit_keywords),
    ],
    16,
  )
    .map((value) => normalizeConcernRoleHint(value))
    .filter((value) => value && value.length >= 4);
  for (const value of strongPatterns) {
    if (!normalizedText.includes(value)) continue;
    score += 2;
    if (score >= 4) break;
  }
  const ingredientPatterns = uniqCaseInsensitiveStrings(asStringArray(row.ingredient_hypotheses), 8)
    .map((value) => normalizeConcernRoleHint(value))
    .filter((value) => value && value.length >= 4);
  for (const value of ingredientPatterns) {
    if (!normalizedText.includes(value)) continue;
    score += 1;
    if (score >= 5) break;
  }
  const productTypePatterns = uniqCaseInsensitiveStrings([
    row.preferred_step,
    ...asStringArray(row.product_type_hypotheses),
  ], 8)
    .map((value) => normalizeConcernRoleHint(value))
    .filter((value) => value && value.length >= 4);
  for (const value of productTypePatterns) {
    if (!normalizedText.includes(value)) continue;
    score += 1;
    if (score >= 5) break;
  }
  return {
    score,
    matched: score >= 2,
  };
}

function normalizeConcernRoleRows(rawTokens, { fallbackRoles = [], supportOnly = false } = {}) {
  const out = [];
  for (const token of Array.isArray(rawTokens) ? rawTokens : []) {
    const matchedRole = matchFallbackRoleFromToken(token, fallbackRoles);
    if (!matchedRole) continue;
    if (out.some((role) => role.role_id === matchedRole.role_id)) continue;
    out.push({
      ...matchedRole,
      support_only: supportOnly === true || matchedRole.support_only === true,
      slot: inferSlotForStep(matchedRole.preferred_step),
      alternate_steps: uniqCaseInsensitiveStrings(
        (Array.isArray(matchedRole.alternate_steps) ? matchedRole.alternate_steps : [])
          .map((value) => normalizeRecoTargetStep(value))
          .filter(Boolean),
        4,
      ),
      product_type_hypotheses: uniqCaseInsensitiveStrings(
        [
          matchedRole.preferred_step,
          ...asStringArray(matchedRole.product_type_hypotheses),
        ]
          .map((value) => normalizeRecoTargetStep(value) || String(value || '').trim())
          .filter(Boolean),
        4,
      ),
    });
  }
  return out.slice(0, supportOnly ? 2 : 3);
}

function buildRoutineShell({ coreRoles = [], supportRoles = [], shellHints = {} } = {}) {
  const fallbackShell = {
    am_core_roles: coreRoles.filter((role) => Array.isArray(role.routine_slots) && role.routine_slots.includes('am')).map((role) => role.role_id),
    pm_core_roles: coreRoles.filter((role) => Array.isArray(role.routine_slots) && role.routine_slots.includes('pm')).map((role) => role.role_id),
    optional_support_roles: supportRoles.map((role) => role.role_id).filter(Boolean),
    frequency: Object.fromEntries([...coreRoles, ...supportRoles].filter((role) => role && role.role_id).map((role) => [role.role_id, role.frequency || null])),
    role_to_step_mapping: Object.fromEntries([...coreRoles, ...supportRoles].filter((role) => role && role.role_id).map((role) => [role.role_id, role.preferred_step || null])),
  };
  return {
    am_core_roles: Array.isArray(shellHints.am_core_roles) && shellHints.am_core_roles.length ? shellHints.am_core_roles : fallbackShell.am_core_roles,
    pm_core_roles: Array.isArray(shellHints.pm_core_roles) && shellHints.pm_core_roles.length ? shellHints.pm_core_roles : fallbackShell.pm_core_roles,
    optional_support_roles: Array.isArray(shellHints.optional_support_roles) && shellHints.optional_support_roles.length ? shellHints.optional_support_roles : fallbackShell.optional_support_roles,
    frequency: fallbackShell.frequency,
    role_to_step_mapping: fallbackShell.role_to_step_mapping,
  };
}

function normalizeConcernSemanticPlanFromText(text, { fallbackPlan, requestText = '', focus = '' } = {}) {
  const basePlan = isPlainObject(fallbackPlan) ? fallbackPlan : null;
  if (!basePlan) return null;
  const answerText = String(text || '').trim();
  if (!answerText) {
    return {
      ...basePlan,
      selection_owner_source: 'rule_concern_planner_fallback',
      selection_owner_state: 'fallback',
    };
  }
  const primaryConcern = extractLineValue(answerText, ['PRIMARY_CONCERN', 'PRIMARY CONCERN']) || basePlan.primary_concern;
  const coreRoleLine = extractLineValue(answerText, ['CORE_ROLE_IDS', 'CORE ROLES', 'CORE ROLE IDS']);
  const supportRoleLine = extractLineValue(answerText, ['SUPPORT_ROLE_IDS', 'SUPPORT ROLES', 'SUPPORT ROLE IDS']);
  const ingredientLine = extractLineValue(answerText, ['INGREDIENT_HYPOTHESES', 'INGREDIENTS', 'INGREDIENT DIRECTIONS']);
  const productTypeLine = extractLineValue(answerText, ['PRODUCT_TYPE_HYPOTHESES', 'PRODUCT TYPES', 'PRODUCT TYPE DIRECTIONS']);
  const routineShellLine = extractLineValue(answerText, ['ROUTINE_SHELL_HINTS', 'ROUTINE SHELL', 'ROUTINE']);

  let coreRoles = normalizeConcernRoleRows(splitSectionTokens(coreRoleLine), {
    fallbackRoles: Array.isArray(basePlan.core_roles) ? basePlan.core_roles : [],
    supportOnly: false,
  });
  let supportRoles = normalizeConcernRoleRows(splitSectionTokens(supportRoleLine), {
    fallbackRoles: Array.isArray(basePlan.support_roles) ? basePlan.support_roles : [],
    supportOnly: true,
  });

  if (coreRoles.length === 0) {
    coreRoles = (Array.isArray(basePlan.core_roles) ? basePlan.core_roles : [])
      .map((role) => ({
        role,
        match: scoreConcernSemanticRoleFromText(answerText, role),
      }))
      .filter((item) => item.match.matched || item.match.score >= 2)
      .sort((left, right) => {
        const scoreDiff = Number(right?.match?.score || 0) - Number(left?.match?.score || 0);
        if (scoreDiff !== 0) return scoreDiff;
        return Number(left?.role?.rank || 0) - Number(right?.role?.rank || 0);
      })
      .map((item) => item.role)
      .slice(0, 3);
  }
  if (supportRoles.length === 0) {
    supportRoles = (Array.isArray(basePlan.support_roles) ? basePlan.support_roles : [])
      .map((role) => ({
        role,
        match: scoreConcernSemanticRoleFromText(answerText, role),
      }))
      .filter((item) => item.match.score >= 1)
      .map((item) => item.role)
      .slice(0, 2);
  }

  const trusted = coreRoles.length >= 2;
  const ingredientHypotheses = uniqCaseInsensitiveStrings([
    ...splitSectionTokens(ingredientLine),
    ...coreRoles.flatMap((role) => asStringArray(role.ingredient_hypotheses)),
    ...supportRoles.flatMap((role) => asStringArray(role.ingredient_hypotheses)),
  ], 12);
  const productTypeHypotheses = uniqCaseInsensitiveStrings([
    ...splitSectionTokens(productTypeLine),
    ...coreRoles.flatMap((role) => asStringArray(role.product_type_hypotheses)),
    ...supportRoles.flatMap((role) => asStringArray(role.product_type_hypotheses)),
  ], 8);
  const routineShellHints = parseRoutineShellHints(routineShellLine, { coreRoles, supportRoles });
  const routineShell = buildRoutineShell({ coreRoles, supportRoles, shellHints: routineShellHints });
  if (!trusted) {
    return {
      ...basePlan,
      selection_owner_source: 'rule_concern_planner_fallback',
      selection_owner_state: 'fallback',
    };
  }
  const planId = `concernplan_${crypto.createHash('sha1').update(JSON.stringify({
    concern: primaryConcern || requestText || focus,
    core: coreRoles.map((role) => role.role_id),
    support: supportRoles.map((role) => role.role_id),
  })).digest('hex').slice(0, 16)}`;
  return {
    plan_id: planId,
    semantic_plan_version: pickFirstTrimmed(basePlan.semantic_plan_version, CONCERN_SEMANTIC_PLAN_NORMALIZER_VERSION) || CONCERN_SEMANTIC_PLAN_NORMALIZER_VERSION,
    intent_mode: 'generic_concern',
    primary_concern: primaryConcern || basePlan.primary_concern,
    core_roles: coreRoles,
    support_roles: supportRoles,
    ingredient_hypotheses: ingredientHypotheses.length ? ingredientHypotheses : asStringArray(basePlan.ingredient_hypotheses, 12),
    product_type_hypotheses: productTypeHypotheses.length ? productTypeHypotheses : asStringArray(basePlan.product_type_hypotheses, 8),
    frequency_policy: routineShell.frequency,
    routine_shell: routineShell,
    selection_constraints: {
      ...(isPlainObject(basePlan.selection_constraints) ? basePlan.selection_constraints : {}),
      support_cannot_replace_core: true,
      allow_price_tiers: false,
    },
    selection_owner_source: 'llm_concern_planner',
    selection_owner_state: 'trusted',
    framework_summary: {
      concern_text: primaryConcern || requestText || focus,
      headline: isPlainObject(basePlan.framework_summary) ? basePlan.framework_summary.headline : null,
      prioritized_roles: coreRoles.map((role) => ({
        role_id: role.role_id,
        label: role.label,
        why_this_role: role.why_this_role,
        rank: role.rank,
      })),
      support_roles: supportRoles.map((role) => ({
        role_id: role.role_id,
        label: role.label,
        why_this_role: role.why_this_role,
      })),
      ingredient_hypotheses: ingredientHypotheses.length ? ingredientHypotheses : asStringArray(basePlan.framework_summary?.ingredient_hypotheses),
    },
    concern_signals: isPlainObject(basePlan.concern_signals) ? basePlan.concern_signals : null,
  };
}

module.exports = {
  CONCERN_PLANNER_PROMPT_VERSION,
  CONCERN_SEMANTIC_PLAN_NORMALIZER_VERSION,
  buildConcernSemanticPlanTextPromptBundle,
  normalizeConcernSemanticPlanFromText,
};
