const { extractRecoTargetStepFromText, normalizeRecoTargetStep } = require('./recoTargetStep');
const { resolveRecommendationTargetContext } = require('./recommendationSharedStack');

const BEAUTY_EXACT_BRAND_PATTERN =
  /\b(beauty of joseon|ultra repair|first aid beauty|round lab|skin1004|paula'?s choice|glossier|supergoop|haruharu|byoma|dieux|the ordinary|good molecules|la roche-posay|la roche posay)\b/i;
const BEAUTY_EXACT_CATEGORY_PATTERN =
  /\b(beauty|skin|skincare|sunscreen|spf|moisturizer|moisturiser|cleanser|serum|toner|essence|retinol|retinoid|barrier|acne|pore|oily|dry|sensitive|hydration|dewy|matte|makeup|under makeup|tretinoin|ceramide|colloidal oatmeal)\b|护肤|防晒|洁面|洗面奶|精华|爽肤水|面霜|乳液|屏障|修护|痘|毛孔|油皮|干皮|干燥|敏感|补水|保湿|紧绷|刺痛/i;
const BEAUTY_EXACT_ASSIST_PATTERN =
  /\b(is|would|should)\b[^.?!]{0,140}\b(good|better|right|fit|suit|work|use)\b|\bbetter than\b|\bvs\.?\b|\bversus\b/i;

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

function extractBeautyRequestProductContext(input) {
  const payload = isPlainObject(input) ? input : {};
  const context = isPlainObject(payload.context) ? payload.context : {};
  const normalizedNeed = isPlainObject(context.normalized_need) ? context.normalized_need : {};
  const beautyRequest = isPlainObject(normalizedNeed.beauty_request) ? normalizedNeed.beauty_request : {};
  const params = isPlainObject(payload.params) ? payload.params : {};
  const action = isPlainObject(payload.action) ? payload.action : {};
  const actionData = isPlainObject(action.data) ? action.data : {};
  return {
    ...(isPlainObject(beautyRequest.product_context) ? beautyRequest.product_context : {}),
    ...(isPlainObject(params.product_context) ? params.product_context : {}),
    ...(isPlainObject(actionData.product_context) ? actionData.product_context : {}),
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
  const hasConcernSignal =
    /\b(oily|dry|dehydrat(?:ed|ion)?|sensitive|combination|combo|acne|breakout|redness|pores?|blackheads?|clogged|dark spots?|dull(?:ness)?|tight(?:ness)?|stinging|peeling|barrier|irritat(?:ed|ion)?)\b/.test(normalized) ||
    /(油皮|出油|控油|干皮|干燥|很干|发干|缺水|紧绷|起皮|脱皮|敏感|混合皮|痘|闭口|粉刺|毛孔|黑头|泛红|刺痛|刺激|屏障|修护|暗沉|痘印|色沉)/.test(normalized);
  const hasProductAskSignal =
    /\b(product|products|routine|use|add|recommend|should i use|what should i use|what should i add)\b/.test(normalized) ||
    /(用什么|买什么|推荐|护肤品|产品|步骤|第一步|先用|先买|怎么护肤|怎么搭)/.test(normalized);
  return hasConcernSignal && hasProductAskSignal;
}

function looksLikeBeautyExactProductAssistAsk(input) {
  const message = extractRecoUserMessage(input);
  const normalized = String(message || '').trim().toLowerCase();
  const productContext = extractBeautyRequestProductContext(input);
  const hasAnchoredProductContext = Boolean(
    pickFirstTrimmed(
      productContext.product_id,
      productContext.product_group_id,
      productContext.canonical_product_ref,
      productContext.product_ref,
      productContext.name,
      productContext.title,
    ),
  );
  const hasExactAssistSignal = BEAUTY_EXACT_ASSIST_PATTERN.test(normalized);
  if (!hasAnchoredProductContext && !hasExactAssistSignal) return false;
  const beautyRequestDomain = pickFirstTrimmed(
    input?.context?.normalized_need?.beauty_request?.domain,
    input?.params?.beauty_domain,
    input?.action?.data?.beauty_domain,
  );
  const hasBeautySignal =
    String(beautyRequestDomain || '').trim().toLowerCase() === 'beauty' ||
    BEAUTY_EXACT_CATEGORY_PATTERN.test(normalized) ||
    BEAUTY_EXACT_BRAND_PATTERN.test(normalized);
  return hasBeautySignal;
}

function shouldKeepTypedRecoRequestOnV1Mainline(input) {
  const targetContext = resolveRecoOwnershipTargetContext(input);
  const hasFrameworkRoles = Array.isArray(targetContext?.framework_roles) && targetContext.framework_roles.length > 0;
  return Boolean(
    looksLikeBeautyExactProductAssistAsk(input)
    || hasFrameworkRoles
    || targetContext?.step_aware_intent
    || looksLikeFrameworkRecoConcernAsk(input),
  );
}

/**
 * The action id a chat payload names, in the SAME spellings the two chat routers resolve.
 *
 * `normalizeIncomingChatAction` (routes/chat.js and routes.js both carry a copy) accepts five: `action_id`,
 * `id`, `data.action_id`, `data.aurora_action_id`, and `type`. Reading only `action_id` here made the gate
 * below silently inert for the shape the CURRENT FRONTEND actually sends — `{ action: { id, type } }`, the
 * one `V1ChatRequestSchema` documents and aurora_bff_v1_chat_rollout calls "current frontend action payload
 * shape with id/type aliases". A router that recognises an action and a policy that does not is how the
 * delegation cycle got in; matching the spelling list is what keeps them agreeing.
 *
 * Exported so the equivalence with `normalizeIncomingChatAction` is TESTED rather than assumed — this is a
 * third copy of that precedence, and an untested twin is how the drift starts.
 */
function extractChatActionId(input) {
  const payload = isPlainObject(input) ? input : {};
  const rawAction = payload.action;
  if (typeof rawAction === 'string') return pickFirstTrimmed(rawAction, payload.action_id);
  const action = isPlainObject(rawAction) ? rawAction : {};
  const data = isPlainObject(action.data) ? action.data : {};
  return pickFirstTrimmed(
    payload.action_id,
    action.action_id,
    action.id,
    data.action_id,
    data.aurora_action_id,
    action.type,
  );
}

/**
 * Did the BUYER type something, as opposed to a chip supplying `reply_text` on their behalf?
 *
 * Mirrors the precedence in `extractRecoUserMessage`: every source it ranks ABOVE `action.data.reply_text`.
 * A chip's own reply_text is generated copy, not a typed ask, which is exactly why an action may be judged by
 * its id — but a real typed message must not be.
 */
function hasTypedUserMessage(input) {
  const payload = isPlainObject(input) ? input : {};
  const params = isPlainObject(payload.params) ? payload.params : {};
  return Boolean(pickFirstTrimmed(
    params.user_message,
    params.message,
    params.text,
    payload.message,
    payload.text,
    extractLastUserMessage(payload.messages),
  ));
}

/**
 * Should this request be proxied from the v2 chat router to the v1 mainline?
 *
 * AN EXPLICIT ACTION IS DECIDED BY THE ACTION, NEVER BY ITS OWN reply_text. The typed-text heuristics used to
 * run FIRST, ahead of the action gate below, which made that gate unreachable for any payload whose text
 * happened to read like a reco ask: `chip.start.dupes` carrying "Find dupes for Barrier Cloud Cream" answered
 * TRUE here and was proxied to the mainline, even though `chip.start.dupes` is a v2-owned action.
 *
 * That was not merely a mis-route. The mainline's own intent contract correctly classified the action as
 * `delegate_target: 'v2'` and handed it straight back to the v2 router (routes.js, the handleChatV2 branch),
 * which asked this function again, got TRUE again, and proxied again — an unbounded mutual delegation that
 * pinned a CPU at 100% and never answered. The `withTimeoutCode` bound around the proxy call cannot save it:
 * the recursion is a chain of promise continuations, so the microtask queue never drains and the timeout's
 * timer never gets a turn. A guard that structurally cannot fire is not a guard.
 *
 * TWO BOUNDS keep that narrowing honest, and both were added because review showed the first cut was wrong:
 *   - the action id is read in EVERY spelling the routers accept (see `extractChatActionId`), or the gate is
 *     inert for the payload shape the frontend actually sends and only the kernel-side cycle guard is working;
 *   - a payload carrying a TYPED message keeps the free-text treatment. `extractRecoUserMessage` ranks a real
 *     `message` above a chip's `reply_text`, so judging "typed reco ask that happened to arrive with a
 *     non-reco chip" by the chip id would drop genuine mainline traffic — trading a hang for a mis-route in
 *     the other direction, on live `/v2/chat` and both stream surfaces.
 */
function shouldProxyFrameworkRecoToV1Mainline(input) {
  const payload = isPlainObject(input) ? input : {};
  const actionId = extractChatActionId(payload);
  if (actionId && !hasTypedUserMessage(payload)) {
    const normalizedActionId = String(actionId).trim().toLowerCase();
    const isRecoAction =
      normalizedActionId === 'chip.start.reco_products' ||
      normalizedActionId === 'chip_start_reco_products';
    if (!isRecoAction) return false;
    // A reco action still gets the full typed-request treatment — the narrowing above is only about letting a
    // NON-reco action be misread as one.
    return shouldKeepTypedRecoRequestOnV1Mainline(payload) || looksLikeFrameworkRecoConcernAsk(payload);
  }
  if (shouldKeepTypedRecoRequestOnV1Mainline(payload)) return true;
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
  extractChatActionId,
  hasTypedUserMessage,
  resolveRecoOwnershipTargetContext,
  looksLikeFrameworkRecoConcernAsk,
  looksLikeBeautyExactProductAssistAsk,
  isPlainObject,
  extractRecoTargetStepFromText,
};
