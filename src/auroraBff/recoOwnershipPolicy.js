const { extractRecoTargetStepFromText, normalizeRecoTargetStep } = require('./recoTargetStep');
const { resolveRecommendationTargetContext } = require('./recommendationSharedStack');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickFirstTrimmed(...values) {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function extractLastUserMessage(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const row = list[index];
    if (!isPlainObject(row)) continue;
    const role = String(row.role || '').trim().toLowerCase();
    if (role && role !== 'user') continue;
    const content = pickFirstTrimmed(row.content, row.text, row.message);
    if (content) return content;
  }
  return null;
}

function extractRecoUserMessage(input) {
  const payload = isPlainObject(input) ? input : {};
  const params = isPlainObject(payload.params) ? payload.params : {};
  const action = isPlainObject(payload.action) ? payload.action : {};
  const actionData = isPlainObject(action.data) ? action.data : {};
  return pickFirstTrimmed(
    params.user_message,
    params.message,
    params.text,
    payload.message,
    payload.text,
    actionData.reply_text,
    actionData.replyText,
    extractLastUserMessage(payload.messages),
  );
}

function buildRecoProfileSummary(input) {
  const payload = isPlainObject(input) ? input : {};
  const context = isPlainObject(payload.context) ? payload.context : {};
  const contextProfile = isPlainObject(context.profile) ? context.profile : {};
  const session = isPlainObject(payload.session) ? payload.session : {};
  const sessionProfile = isPlainObject(session.profile) ? session.profile : {};
  const params = isPlainObject(payload.params) ? payload.params : {};
  const paramsProfilePatch = isPlainObject(params.profile_patch) ? params.profile_patch : {};
  const action = isPlainObject(payload.action) ? payload.action : {};
  const actionData = isPlainObject(action.data) ? action.data : {};
  const actionProfilePatch = isPlainObject(actionData.profile_patch) ? actionData.profile_patch : {};
  return {
    ...contextProfile,
    ...sessionProfile,
    ...paramsProfilePatch,
    ...actionProfilePatch,
  };
}

function resolveRecoOwnershipTargetContext(input) {
  const message = extractRecoUserMessage(input);
  if (!message) return null;
  try {
    return resolveRecommendationTargetContext({
      explicitStep: '',
      focus: '',
      text: message,
      entryType: 'chat',
      profileSummary: buildRecoProfileSummary(input),
    });
  } catch {
    return null;
  }
}

function looksLikeFrameworkRecoConcernAsk(input) {
  const message = extractRecoUserMessage(input);
  if (!message) return false;
  const normalized = String(message).trim().toLowerCase();
  if (!normalized) return false;
  const hasConcernSignal = /\b(oily|dry|dehydrated|sensitive|combination|acne|breakout|redness|pores?|dark spots?)\b/.test(normalized);
  const hasProductAskSignal = /\b(product|products|routine|use|recommend|should i use|what should i use)\b/.test(normalized);
  return hasConcernSignal && hasProductAskSignal;
}

function shouldKeepTypedRecoRequestOnV1Mainline(input) {
  const targetContext = resolveRecoOwnershipTargetContext(input);
  const hasFrameworkRoles = Array.isArray(targetContext?.framework_roles) && targetContext.framework_roles.length > 0;
  return Boolean(
    hasFrameworkRoles
    || targetContext?.step_aware_intent
    || looksLikeFrameworkRecoConcernAsk(input),
  );
}

function shouldProxyFrameworkRecoToV1Mainline(input) {
  const payload = isPlainObject(input) ? input : {};
  if (shouldKeepTypedRecoRequestOnV1Mainline(payload)) return true;
  const action = isPlainObject(payload.action) ? payload.action : {};
  const actionId = pickFirstTrimmed(payload.action_id, action.action_id);
  if (actionId) {
    const normalizedActionId = String(actionId).trim().toLowerCase();
    const isRecoAction =
      normalizedActionId === 'chip.start.reco_products' ||
      normalizedActionId === 'chip_start_reco_products';
    if (!isRecoAction) return false;
    return looksLikeFrameworkRecoConcernAsk(payload);
  }
  return looksLikeFrameworkRecoConcernAsk(payload);
}

function shouldKeepFrameworkRecoOffLegacySkill({ request, classification, baseSkillId }) {
  if (baseSkillId !== 'reco.step_based') return false;
  if (classification?.intent !== 'recommend_products') return false;

  const explicitStep = normalizeRecoTargetStep(
    request?.params?.target_step
    || classification?.entities?.target_step,
  );
  if (explicitStep) return false;

  const userMessage = extractRecoUserMessage(request) || classification?.entities?.user_question || '';
  if (!String(userMessage || '').trim()) return false;

  try {
    const targetContext = resolveRecommendationTargetContext({
      explicitStep: '',
      focus: '',
      text: userMessage,
      entryType: 'chat',
      profileSummary: buildRecoProfileSummary(request),
    });
    return Array.isArray(targetContext?.framework_roles) && targetContext.framework_roles.length > 0;
  } catch {
    return false;
  }
}

module.exports = {
  buildRecoProfileSummary,
  extractRecoUserMessage,
  extractLastUserMessage,
  pickFirstTrimmed,
  shouldKeepFrameworkRecoOffLegacySkill,
  shouldKeepTypedRecoRequestOnV1Mainline,
  shouldProxyFrameworkRecoToV1Mainline,
  resolveRecoOwnershipTargetContext,
  looksLikeFrameworkRecoConcernAsk,
  isPlainObject,
  extractRecoTargetStepFromText,
};
