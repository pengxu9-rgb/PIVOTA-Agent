const { randomUUID } = require('crypto');
const { cloneSourceProfile } = require('./sourceProfile');
const { normalizeTaskType } = require('./taskType');
const { normalizeBeautyRequestBlock } = require('./beautyExpertContracts');

const ALLOWED_TOP_LEVEL_KEYS = Object.freeze([
  'context_id',
  'source_profile',
  'task_type',
  'vertical',
  'category',
  'raw_user_goal',
  'normalized_need',
  'conversation_state',
  'decision_state',
  'execution_state',
]);

const FORBIDDEN_CONTEXT_KEYS = new Set([
  'ranking_features',
  'rankingfeatures',
  'prompt_scratchpad',
  'promptscratchpad',
  'llm_scratchpad',
  'llmscratchpad',
  'module_cache',
  'modulecache',
  'raw_candidates',
  'rawcandidates',
  'debug',
  'debug_bundle',
  'debugbundle',
  'cache',
]);

function normalizeKeyToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clonePlainObject(value) {
  if (!isPlainObject(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function scanForbiddenContextPaths(value, pathPrefix = '', issues = []) {
  if (!isPlainObject(value)) return issues;
  for (const [key, nested] of Object.entries(value)) {
    const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (FORBIDDEN_CONTEXT_KEYS.has(normalizeKeyToken(key))) {
      issues.push(nextPath);
    }
    if (isPlainObject(nested)) {
      scanForbiddenContextPaths(nested, nextPath, issues);
    }
  }
  return issues;
}

function validateShoppingContextGrowth(input = {}) {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      unknown_top_level_keys: ['<non_object>'],
      forbidden_paths: [],
    };
  }
  const unknownTopLevelKeys = Object.keys(input).filter((key) => !ALLOWED_TOP_LEVEL_KEYS.includes(key));
  const forbiddenPaths = scanForbiddenContextPaths(input);
  return {
    ok: unknownTopLevelKeys.length === 0 && forbiddenPaths.length === 0,
    unknown_top_level_keys: unknownTopLevelKeys,
    forbidden_paths: forbiddenPaths,
  };
}

function createShoppingContext(input = {}) {
  const validation = validateShoppingContextGrowth(input);
  if (!validation.ok) {
    const parts = [];
    if (validation.unknown_top_level_keys.length) {
      parts.push(`unknown_top_level_keys=${validation.unknown_top_level_keys.join(',')}`);
    }
    if (validation.forbidden_paths.length) {
      parts.push(`forbidden_paths=${validation.forbidden_paths.join(',')}`);
    }
    throw new Error(`SHOPPING_CONTEXT_INVALID:${parts.join(';')}`);
  }

  const normalizedNeed = clonePlainObject(input.normalized_need);
  if (isPlainObject(normalizedNeed.beauty_request)) {
    normalizedNeed.beauty_request = normalizeBeautyRequestBlock(normalizedNeed.beauty_request);
  }

  return {
    context_id: String(input.context_id || '').trim() || `shopctx_${randomUUID()}`,
    source_profile: input.source_profile ? cloneSourceProfile(input.source_profile) : null,
    task_type: normalizeTaskType(input.task_type),
    vertical: String(input.vertical || '').trim() || null,
    category: String(input.category || '').trim() || null,
    raw_user_goal: String(input.raw_user_goal || '').trim() || null,
    normalized_need: normalizedNeed,
    conversation_state: clonePlainObject(input.conversation_state),
    decision_state: clonePlainObject(input.decision_state),
    execution_state: clonePlainObject(input.execution_state),
  };
}

module.exports = {
  ALLOWED_TOP_LEVEL_KEYS,
  validateShoppingContextGrowth,
  createShoppingContext,
};
