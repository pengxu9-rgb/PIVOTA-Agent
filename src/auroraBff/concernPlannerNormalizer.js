'use strict';

const crypto = require('crypto');

const CONCERN_PLANNER_PROMPT_VERSION = 'concern_semantic_plan_v2';
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

function collectConcernRoleOntologyRows(plan = null) {
  const source = isPlainObject(plan) ? plan : {};
  const rawOntology = Array.isArray(source.role_ontology?.roles)
    ? source.role_ontology.roles
    : Array.isArray(source.role_ontology)
      ? source.role_ontology
      : [];
  const out = [];
  const seen = new Set();
  const addRole = (role) => {
    if (!isPlainObject(role)) return;
    const roleId = pickFirstTrimmed(role.role_id);
    if (!roleId || seen.has(roleId)) return;
    seen.add(roleId);
    out.push(role);
  };
  for (const role of rawOntology) addRole(role);
  for (const role of Array.isArray(source.core_roles) ? source.core_roles : []) addRole(role);
  for (const role of Array.isArray(source.support_roles) ? source.support_roles : []) addRole(role);
  return out;
}

function buildPlannerRoleContextRows(plan = null) {
  return collectConcernRoleOntologyRows(plan)
    .map((role) => ({
      role_id: pickFirstTrimmed(role?.role_id) || null,
      label: pickFirstTrimmed(role?.label) || null,
      preferred_step: normalizeRecoTargetStep(role?.preferred_step) || pickFirstTrimmed(role?.preferred_step) || null,
      why_this_role: pickFirstTrimmed(role?.why_this_role) || null,
      query_terms: asStringArray(role?.query_terms, 4),
      fit_keywords: asStringArray(role?.fit_keywords, 6),
      ingredient_hypotheses: asStringArray(role?.ingredient_hypotheses, 4),
    }))
    .filter((role) => role.role_id)
    .slice(0, 24);
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
  const roleContextRows = buildPlannerRoleContextRows(plan);
  const roleIds = roleContextRows.map((role) => role.role_id).filter(Boolean);
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
      core: roleIds,
      support: roleIds,
    },
    canonical_role_ontology: roleContextRows,
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
        '只输出 JSON object，不要 markdown，不要解释。Schema：',
        '{"primary_concern":string,"primary_role_id":string,"support_role_ids":[string],"routine_mode":"routine_mix|same_role_comparison|single_product","query_intents":[{"role_id":string,"intent":string,"query_terms":[string]}],"must_satisfy_constraints":[string],"comparison_mode":"routine_mix|same_role_comparison|single_product","evidence_needed":[string],"ingredient_hypotheses":[string],"product_type_hypotheses":[string]}',
        '规则：',
        '- 只能使用 context.canonical_role_ontology / context.allowed_role_ids 里的 role_id。',
        '- 不要被 fallback 的初始顺序束缚；请基于用户真实主诉选择最贴合的 primary role。',
        '- 如果用户明确问防晒、妆前叠加、闷热通勤或 SPF，防晒/肤感适配角色可以成为 primary role。',
        '- 如果用户问痘印、色沉、肤色不均，不要把它简化成 acne/oil-control，除非用户真的在问长痘或堵塞。',
        '- routine_mix 时 support_role_ids 是需要被检索和展示的 routine support role，不是可忽略注释。',
        '- routine_mix 时保持角色覆盖完整：功效 + 保湿/屏障支持 + 日常防晒，除非用户明确只要单品或同角色横向比较。',
        '- routine_mix 时不要同时选择两个会召回同类精华的重复功效角色；痘痘/堵塞和控油高度重叠时，保留更贴合主诉的一个，再补保湿和日间防晒。',
        '- 敏感、泛红、刺激或屏障不稳的 routine_mix，任何舒缓功效角色都需要配套屏障保湿角色。',
        '- 不要返回品牌、SKU、价格、链接。',
      ]
    : [
        `[PROMPT_VERSION=${CONCERN_PLANNER_PROMPT_VERSION}]`,
        'Role: strict skincare generic-concern planner.',
        'Task: return only the first-turn care framework, not specific products.',
        'Output a JSON object only. No markdown, no explanation. Schema:',
        '{"primary_concern":string,"primary_role_id":string,"support_role_ids":[string],"routine_mode":"routine_mix|same_role_comparison|single_product","query_intents":[{"role_id":string,"intent":string,"query_terms":[string]}],"must_satisfy_constraints":[string],"comparison_mode":"routine_mix|same_role_comparison|single_product","evidence_needed":[string],"ingredient_hypotheses":[string],"product_type_hypotheses":[string]}',
        'Rules:',
        '- Only use role_ids from context.canonical_role_ontology / context.allowed_role_ids.',
        '- Do not anchor on the fallback order; choose the primary role from the user’s real complaint.',
        '- If the user explicitly asks about sunscreen, SPF, commute, humidity, white cast, or under-makeup wear, a sunscreen finish-fit role may be primary.',
        '- If the user asks about post-breakout marks, dark spots, or uneven tone, do not collapse it into acne/oil-control unless active breakouts or clogged pores are actually requested.',
        '- In routine_mix, support_role_ids are routine support roles that should be retrieved and shown, not optional commentary.',
        '- In routine_mix, keep role coverage complete: treatment + moisturizer/barrier support + daily sunscreen unless the user explicitly asks for a single product or same-role comparison.',
        '- In routine_mix, do not choose two overlapping treatment roles that will retrieve the same kind of serum; when acne/clogged-pore and oil-control overlap, keep the role that best matches the complaint, then cover moisturizer and daytime sunscreen.',
        '- For sensitive, redness, irritation, or barrier-stress asks, include a barrier moisturizer role with any soothing treatment role.',
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
    const normalizedRoleId = normalizeConcernRoleHint(role.role_id);
    if (normalizedRoleId && normalizedRoleId === normalizedToken) return role;
  }
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
    if (candidates.some((candidate) => {
      if (candidate === normalizedToken) return true;
      if (candidate.length < 12) return false;
      return normalizedToken.includes(candidate) || candidate.includes(normalizedToken);
    })) {
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

function roleListHasStep(roles = [], step = '') {
  const normalizedStep = normalizeRecoTargetStep(step);
  if (!normalizedStep) return false;
  return (Array.isArray(roles) ? roles : []).some((role) => normalizeRecoTargetStep(role?.preferred_step) === normalizedStep);
}

function roleListHasId(roles = [], roleId = '') {
  const id = String(roleId || '').trim();
  if (!id) return false;
  return (Array.isArray(roles) ? roles : []).some((role) => String(role?.role_id || '').trim() === id);
}

function isRoutineCoverageTreatmentRole(role = null) {
  const step = normalizeRecoTargetStep(role?.preferred_step);
  return step === 'treatment' || step === 'serum';
}

function normalizeRoutineCoverageRoleFamily(role = null) {
  const roleId = String(role?.role_id || '').trim();
  if (!roleId) return '';
  if (roleId === 'acne_clogged_pore_treatment' || roleId === 'oil_control_treatment') {
    return 'blemish_oil_treatment';
  }
  return roleId;
}

function orderRoutineCoverageRolesAfterRepair(roles = []) {
  const rows = (Array.isArray(roles) ? roles : []).filter((role) => isPlainObject(role));
  if (rows.length <= 2) return rows;
  const primaryRole = rows[0] || null;
  if (normalizeRoutineCoverageRoleFamily(primaryRole) !== 'blemish_oil_treatment') return rows;
  const stepWeight = (role) => {
    const step = normalizeRecoTargetStep(role?.preferred_step);
    if (step === 'moisturizer') return 1;
    if (step === 'sunscreen') return 2;
    if (step === 'treatment' || step === 'serum') return 3;
    return 4;
  };
  return [
    primaryRole,
    ...rows.slice(1).sort((left, right) => {
      const diff = stepWeight(left) - stepWeight(right);
      if (diff !== 0) return diff;
      return Number(left?.rank || 0) - Number(right?.rank || 0);
    }),
  ];
}

function pickOntologyRoleById(ontologyRoles = [], roleId = '') {
  const id = String(roleId || '').trim();
  if (!id) return null;
  return (Array.isArray(ontologyRoles) ? ontologyRoles : []).find((role) => String(role?.role_id || '').trim() === id) || null;
}

function cloneSemanticPlannerRole(role, { rank = null } = {}) {
  if (!isPlainObject(role)) return null;
  return {
    ...role,
    ...(Number.isFinite(Number(rank)) ? { rank: Number(rank) } : {}),
    support_only: false,
  };
}

function repairRoutineMixRoleCoverage({
  coreRoles = [],
  supportRoles = [],
  ontologyRoles = [],
  requestText = '',
  focus = '',
  primaryConcern = '',
  routineMode = '',
  comparisonMode = '',
} = {}) {
  const normalizedRoutineMode = String(routineMode || '').trim().toLowerCase();
  const normalizedComparisonMode = String(comparisonMode || '').trim().toLowerCase();
  if (normalizedRoutineMode !== 'routine_mix' && normalizedComparisonMode !== 'routine_mix') {
    return { coreRoles, supportRoles, repairCodes: [] };
  }
  if (normalizedComparisonMode === 'same_role_comparison' || normalizedComparisonMode === 'same_role') {
    return { coreRoles, supportRoles, repairCodes: [] };
  }

  const repaired = (Array.isArray(coreRoles) ? coreRoles : []).filter((role) => isPlainObject(role));
  const repairCodes = [];
  const roleIds = () => new Set(repaired.map((role) => String(role?.role_id || '').trim()).filter(Boolean));
  const hasRole = (roleId) => roleIds().has(String(roleId || '').trim());
  const makeRoomForDailySunscreen = () => {
    if (repaired.length < 3) return false;
    const primaryRole = repaired[0] || null;
    const primaryFamily = normalizeRoutineCoverageRoleFamily(primaryRole);
    if (!primaryFamily || !isRoutineCoverageTreatmentRole(primaryRole)) return false;
    const removableIndex = repaired.findIndex((role, index) => (
      index > 0
      && isRoutineCoverageTreatmentRole(role)
      && normalizeRoutineCoverageRoleFamily(role) === primaryFamily
    ));
    if (removableIndex < 0) return false;
    repaired.splice(removableIndex, 1);
    repairCodes.push('routine_mix_removed_redundant_treatment_for_sunscreen_coverage');
    return true;
  };
  const insertRole = (roleId, { beforeRoleId = '', afterIndex = null, code = '' } = {}) => {
    if (hasRole(roleId)) return false;
    const role = cloneSemanticPlannerRole(pickOntologyRoleById(ontologyRoles, roleId));
    if (!role) return false;
    const beforeIndex = beforeRoleId
      ? repaired.findIndex((item) => String(item?.role_id || '').trim() === beforeRoleId)
      : -1;
    if (beforeIndex >= 0) {
      repaired.splice(beforeIndex, 0, role);
    } else if (Number.isFinite(Number(afterIndex))) {
      repaired.splice(Math.max(0, Math.min(repaired.length, Number(afterIndex) + 1)), 0, role);
    } else {
      repaired.push(role);
    }
    if (code) repairCodes.push(code);
    return true;
  };

  const contextText = normalizeConcernRoleHint([requestText, focus, primaryConcern].filter(Boolean).join(' '));
  const existingIds = roleIds();
  const hasTreatment = repaired.some((role) => normalizeRecoTargetStep(role?.preferred_step) === 'treatment' || normalizeRecoTargetStep(role?.preferred_step) === 'serum');
  const hasMoisturizer = roleListHasStep(repaired, 'moisturizer');
  const hasSunscreen = roleListHasStep(repaired, 'sunscreen');
  const hasExplicitSingleProductAsk = /\b(single|one product|just one|only one|serum|essence|ampoule|treatment)\b/.test(contextText)
    && !/\b(routine|start|first|use first|what should i buy|what product should i buy|what should i use)\b/.test(contextText);
  if (hasExplicitSingleProductAsk) return { coreRoles: repaired, supportRoles, repairCodes };

  const sensitivityIntent = /\b(sensitive|redness|red|reactive|irritat|stinging|barrier|sensitized)\b/.test(contextText)
    || existingIds.has('soothing_treatment');
  const oilyIntent = /\b(oily|oil|shine|sebum|acne|breakout|clogged|pore)\b/.test(contextText)
    || existingIds.has('oil_control_treatment')
    || existingIds.has('acne_clogged_pore_treatment');
  const makeupLayeringIntent = /\b(makeup|under makeup|pilling|pill\b|rolls? off|balls? up|layering|smooth layering)\b/.test(contextText)
    || existingIds.has('layering_compatible_moisturizer_or_spf');

  if (makeupLayeringIntent) {
    const genericSunscreenIndex = repaired.findIndex((role) => String(role?.role_id || '').trim() === 'daily_sunscreen');
    const finishFitSunscreen = cloneSemanticPlannerRole(pickOntologyRoleById(ontologyRoles, 'daily_sunscreen_finish_fit'));
    if (genericSunscreenIndex >= 0 && finishFitSunscreen && !hasRole('daily_sunscreen_finish_fit')) {
      repaired.splice(genericSunscreenIndex, 1, finishFitSunscreen);
      repairCodes.push('routine_mix_replaced_generic_sunscreen_with_finish_fit');
    } else if (!hasSunscreen && repaired.length < 3) {
      insertRole('daily_sunscreen_finish_fit', {
        code: 'routine_mix_added_finish_fit_sunscreen',
      });
    }
  }

  if (hasTreatment && !hasMoisturizer) {
    if (sensitivityIntent) {
      const inserted = insertRole('barrier_moisturizer', {
        beforeRoleId: roleListHasId(repaired, 'soothing_treatment') ? 'soothing_treatment' : '',
        afterIndex: 0,
        code: 'routine_mix_added_barrier_moisturizer',
      }) || insertRole('hydrating_barrier_moisturizer', {
        beforeRoleId: roleListHasId(repaired, 'soothing_treatment') ? 'soothing_treatment' : '',
        afterIndex: 0,
        code: 'routine_mix_added_hydrating_barrier_moisturizer',
      });
      if (inserted) repairCodes.push('routine_mix_restored_treatment_moisturizer_sunscreen_coverage');
    } else if (oilyIntent) {
      if (insertRole('lightweight_moisturizer', { afterIndex: 0, code: 'routine_mix_added_lightweight_moisturizer' })) {
        repairCodes.push('routine_mix_restored_treatment_moisturizer_sunscreen_coverage');
      }
    } else if (insertRole('hydrating_barrier_moisturizer', { afterIndex: 0, code: 'routine_mix_added_hydrating_barrier_moisturizer' })) {
      repairCodes.push('routine_mix_restored_treatment_moisturizer_sunscreen_coverage');
    }
  }
  if (
    (hasTreatment || roleListHasStep(repaired, 'moisturizer'))
    && !hasSunscreen
    && !roleListHasStep(repaired, 'sunscreen')
    && !/\b(night|pm|evening|retinol|exfoliat)\b/.test(contextText)
  ) {
    if (repaired.length >= 3) makeRoomForDailySunscreen();
    if (repaired.length < 3) {
      insertRole('daily_sunscreen', { code: 'routine_mix_added_daily_sunscreen' });
    }
  }

  const finalCoreRoles = orderRoutineCoverageRolesAfterRepair(repaired).slice(0, 3);
  const finalCoreIds = new Set(finalCoreRoles.map((role) => String(role?.role_id || '').trim()).filter(Boolean));
  const finalSupportRoles = (Array.isArray(supportRoles) ? supportRoles : [])
    .filter((role) => role && !finalCoreIds.has(String(role?.role_id || '').trim()))
    .slice(0, 2);
  return {
    coreRoles: finalCoreRoles,
    supportRoles: finalSupportRoles,
    repairCodes: uniqCaseInsensitiveStrings(repairCodes, 6),
  };
}

function extractLineValue(text, labels = []) {
  const lines = String(text || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = String(rawLine || '')
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
      .trim();
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

function parseConcernPlannerJsonPayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return isPlainObject(parsed) ? parsed : null;
  } catch (_err) {
    return null;
  }
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

function buildConcernRoleSemanticPatterns(role) {
  const row = isPlainObject(role) ? role : null;
  if (!row) return [];
  return uniqCaseInsensitiveStrings(
    [
      row.role_id,
      row.label,
      ...asStringArray(row.query_terms),
      ...asStringArray(row.ingredient_hypotheses),
      row.preferred_step,
      ...asStringArray(row.product_type_hypotheses),
    ],
    24,
  )
    .map((value) => normalizeConcernRoleHint(value))
    .filter((value) => value && value.length >= 3);
}

function findConcernRoleFirstIndex(normalizedText, role) {
  if (!normalizedText) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (const pattern of buildConcernRoleSemanticPatterns(role)) {
    const index = normalizedText.indexOf(pattern);
    if (index >= 0 && index < best) best = index;
  }
  return best;
}

function scoreConcernSemanticRoleFromText(answerText, role) {
  const normalizedText = normalizeConcernRoleHint(answerText);
  const row = isPlainObject(role) ? role : null;
  if (!normalizedText || !row) return { score: 0, matched: false, first_index: null };
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
  const firstIndex = findConcernRoleFirstIndex(normalizedText, row);
  return {
    score,
    matched: score >= 2,
    first_index: Number.isFinite(firstIndex) ? firstIndex : null,
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
  const jsonPayload = parseConcernPlannerJsonPayload(answerText);
  const jsonPrimaryRoleId = pickFirstTrimmed(jsonPayload?.primary_role_id, jsonPayload?.primaryRoleId);
  const jsonSupportRoleIds = asStringArray(jsonPayload?.support_role_ids || jsonPayload?.supportRoleIds, 6);
  const jsonCoreRoleIds = asStringArray(jsonPayload?.core_role_ids || jsonPayload?.coreRoleIds, 6);
  const primaryConcern = pickFirstTrimmed(
    jsonPayload?.primary_concern,
    jsonPayload?.primaryConcern,
  ) || extractLineValue(answerText, ['PRIMARY_CONCERN', 'PRIMARY CONCERN']) || basePlan.primary_concern;
  const coreRoleLine = jsonPayload
    ? uniqCaseInsensitiveStrings([
        jsonPrimaryRoleId,
        ...jsonCoreRoleIds,
        ...jsonSupportRoleIds,
      ], 6).join(' | ')
    : extractLineValue(answerText, ['CORE_ROLE_IDS', 'CORE ROLES', 'CORE ROLE IDS']);
  const supportRoleLine = jsonPayload
    ? jsonSupportRoleIds.join(' | ')
    : extractLineValue(answerText, ['SUPPORT_ROLE_IDS', 'SUPPORT ROLES', 'SUPPORT ROLE IDS']);
  const ingredientLine = jsonPayload
    ? asStringArray(jsonPayload.ingredient_hypotheses || jsonPayload.ingredientHypotheses, 12).join(' | ')
    : extractLineValue(answerText, ['INGREDIENT_HYPOTHESES', 'INGREDIENTS', 'INGREDIENT DIRECTIONS']);
  const productTypeLine = jsonPayload
    ? asStringArray(jsonPayload.product_type_hypotheses || jsonPayload.productTypeHypotheses, 8).join(' | ')
    : extractLineValue(answerText, ['PRODUCT_TYPE_HYPOTHESES', 'PRODUCT TYPES', 'PRODUCT TYPE DIRECTIONS']);
  const routineShellLine = jsonPayload
    ? pickFirstTrimmed(jsonPayload.routine_shell_hints, jsonPayload.routineShellHints)
    : extractLineValue(answerText, ['ROUTINE_SHELL_HINTS', 'ROUTINE SHELL', 'ROUTINE']);
  const explicitCoreRoleTokens = splitSectionTokens(coreRoleLine);
  const explicitSupportRoleTokens = splitSectionTokens(supportRoleLine);
  const explicitIngredientHypotheses = splitSectionTokens(ingredientLine);
  const explicitProductTypeHypotheses = splitSectionTokens(productTypeLine);
  const ontologyRoles = collectConcernRoleOntologyRows(basePlan);
  const fallbackCoreRoles = Array.isArray(basePlan.core_roles) ? basePlan.core_roles : [];
  const fallbackSupportRoles = Array.isArray(basePlan.support_roles) ? basePlan.support_roles : [];
  const coreRoleCatalog = ontologyRoles.length ? ontologyRoles : fallbackCoreRoles;
  const supportRoleCatalog = ontologyRoles.length ? ontologyRoles : fallbackSupportRoles;

  let coreRoles = normalizeConcernRoleRows(splitSectionTokens(coreRoleLine), {
    fallbackRoles: coreRoleCatalog,
    supportOnly: false,
  });
  let supportRoles = normalizeConcernRoleRows(splitSectionTokens(supportRoleLine), {
    fallbackRoles: supportRoleCatalog,
    supportOnly: true,
  });

  if (coreRoles.length === 0) {
    const coreScoringText = String(answerText || '').split(/optional\s+support|optional\s*:/i)[0] || answerText;
    coreRoles = coreRoleCatalog
      .map((role) => ({
        role,
        match: scoreConcernSemanticRoleFromText(coreScoringText, role),
      }))
      .filter((item) => item.match.matched || item.match.score >= 2)
      .sort((left, right) => {
        const scoreDiff = Number(right?.match?.score || 0) - Number(left?.match?.score || 0);
        if (scoreDiff !== 0) return scoreDiff;
        const leftIndex = Number.isFinite(left?.match?.first_index) ? Number(left.match.first_index) : Number.POSITIVE_INFINITY;
        const rightIndex = Number.isFinite(right?.match?.first_index) ? Number(right.match.first_index) : Number.POSITIVE_INFINITY;
        const leftHasIndex = Number.isFinite(leftIndex);
        const rightHasIndex = Number.isFinite(rightIndex);
        if (leftHasIndex && rightHasIndex && leftIndex !== rightIndex) return leftIndex - rightIndex;
        if (leftHasIndex !== rightHasIndex) return leftHasIndex ? -1 : 1;
        return Number(left?.role?.rank || 0) - Number(right?.role?.rank || 0);
      })
      .map((item) => item.role)
      .slice(0, 3);
  }
  if (supportRoles.length === 0) {
    supportRoles = supportRoleCatalog
      .map((role) => ({
        role,
        match: scoreConcernSemanticRoleFromText(answerText, role),
      }))
      .filter((item) => item.match.score >= 1)
      .filter((item) => !coreRoles.some((role) => role?.role_id === item?.role?.role_id))
      .sort((left, right) => {
        const scoreDiff = Number(right?.match?.score || 0) - Number(left?.match?.score || 0);
        if (scoreDiff !== 0) return scoreDiff;
        const leftIndex = Number.isFinite(left?.match?.first_index) ? Number(left.match.first_index) : Number.POSITIVE_INFINITY;
        const rightIndex = Number.isFinite(right?.match?.first_index) ? Number(right.match.first_index) : Number.POSITIVE_INFINITY;
        if (Number.isFinite(leftIndex) && Number.isFinite(rightIndex) && leftIndex !== rightIndex) return leftIndex - rightIndex;
        if (Number.isFinite(leftIndex) !== Number.isFinite(rightIndex)) return Number.isFinite(leftIndex) ? -1 : 1;
        return Number(left?.role?.rank || 0) - Number(right?.role?.rank || 0);
      })
      .map((item) => item.role)
      .slice(0, 2);
  }
  supportRoles = supportRoles
    .filter((role) => role && !coreRoles.some((coreRole) => coreRole?.role_id === role?.role_id))
    .slice(0, 2);
  const normalizedRoutineMode = pickFirstTrimmed(jsonPayload?.routine_mode, jsonPayload?.routineMode) || null;
  const normalizedComparisonMode = pickFirstTrimmed(jsonPayload?.comparison_mode, jsonPayload?.comparisonMode) || null;
  const routineRepair = repairRoutineMixRoleCoverage({
    coreRoles,
    supportRoles,
    ontologyRoles,
    requestText,
    focus,
    primaryConcern,
    routineMode: normalizedRoutineMode,
    comparisonMode: normalizedComparisonMode,
  });
  coreRoles = routineRepair.coreRoles;
  supportRoles = routineRepair.supportRoles;

  const routineShellHints = parseRoutineShellHints(routineShellLine, { coreRoles, supportRoles });
  const hasRoutineShellHints =
    (Array.isArray(routineShellHints.am_core_roles) && routineShellHints.am_core_roles.length > 0)
    || (Array.isArray(routineShellHints.pm_core_roles) && routineShellHints.pm_core_roles.length > 0)
    || (Array.isArray(routineShellHints.optional_support_roles) && routineShellHints.optional_support_roles.length > 0);
  const hasFrameworkScaffold = /\b(priority order|start with|follow with|during the day|in the morning|at night|morning|evening|optional support|am\b|pm\b|optional\b|then\b|finally\b|core roles?\b|support roles?\b)\b/.test(
    normalizeConcernRoleHint(answerText),
  );
  const ingredientHypotheses = uniqCaseInsensitiveStrings([
    ...explicitIngredientHypotheses,
    ...coreRoles.flatMap((role) => asStringArray(role.ingredient_hypotheses)),
    ...supportRoles.flatMap((role) => asStringArray(role.ingredient_hypotheses)),
  ], 12);
  const productTypeHypotheses = uniqCaseInsensitiveStrings([
    ...explicitProductTypeHypotheses,
    ...coreRoles.flatMap((role) => asStringArray(role.product_type_hypotheses)),
    ...supportRoles.flatMap((role) => asStringArray(role.product_type_hypotheses)),
  ], 8);
  const routineShell = buildRoutineShell({ coreRoles, supportRoles, shellHints: routineShellHints });
  const trusted =
    Boolean(jsonPayload && jsonPrimaryRoleId && coreRoles.length > 0)
    || (
      Boolean(jsonPayload)
      && coreRoles.length > 0
      && (
        jsonSupportRoleIds.length > 0
        || asStringArray(jsonPayload.query_intents || jsonPayload.queryIntents, 8).length > 0
        || asStringArray(jsonPayload.evidence_needed || jsonPayload.evidenceNeeded, 8).length > 0
      )
    )
    || (explicitCoreRoleTokens.length > 0 && coreRoles.length > 0)
    || (hasFrameworkScaffold && coreRoles.length >= 2)
    || (
      hasFrameworkScaffold
      && coreRoles.length >= 1
      && (
        explicitSupportRoleTokens.length > 0
        || supportRoles.length > 0
        || hasRoutineShellHints
      )
    )
    || (
      explicitCoreRoleTokens.length > 0
      && coreRoles.length >= 1
      && (
        explicitSupportRoleTokens.length > 0
        || explicitIngredientHypotheses.length > 0
        || explicitProductTypeHypotheses.length > 0
        || hasRoutineShellHints
      )
    );
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
    role_ontology: isPlainObject(basePlan.role_ontology) ? basePlan.role_ontology : null,
    ingredient_hypotheses: ingredientHypotheses.length ? ingredientHypotheses : asStringArray(basePlan.ingredient_hypotheses, 12),
    product_type_hypotheses: productTypeHypotheses.length ? productTypeHypotheses : asStringArray(basePlan.product_type_hypotheses, 8),
    frequency_policy: routineShell.frequency,
    routine_shell: routineShell,
    routine_mode: normalizedRoutineMode,
    query_intents: Array.isArray(jsonPayload?.query_intents)
      ? jsonPayload.query_intents.filter((item) => isPlainObject(item)).slice(0, 8)
      : Array.isArray(jsonPayload?.queryIntents)
        ? jsonPayload.queryIntents.filter((item) => isPlainObject(item)).slice(0, 8)
        : [],
    must_satisfy_constraints: asStringArray(jsonPayload?.must_satisfy_constraints || jsonPayload?.mustSatisfyConstraints, 8),
    comparison_mode: normalizedComparisonMode,
    evidence_needed: asStringArray(jsonPayload?.evidence_needed || jsonPayload?.evidenceNeeded, 8),
    selection_constraints: {
      ...(isPlainObject(basePlan.selection_constraints) ? basePlan.selection_constraints : {}),
      support_cannot_replace_core: true,
      allow_price_tiers: false,
      ...(routineRepair.repairCodes.length ? { plan_invariants_applied: routineRepair.repairCodes } : {}),
      ...(normalizedComparisonMode
        ? { comparison_mode: normalizedComparisonMode }
        : {}),
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
