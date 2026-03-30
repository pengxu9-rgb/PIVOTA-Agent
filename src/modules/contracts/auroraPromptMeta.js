const { handleAuroraBeautyOrchestration } = require('../orchestration/aurora_beauty');

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

function normalizePromptMetaMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((item) => ({
      role: String(item?.role || '').trim() || 'user',
      content: String(item?.content || '').trim(),
    }))
    .filter((item) => item.content);
}

function buildPromptMetaMessages(skillRequest) {
  const params =
    skillRequest && isPlainObject(skillRequest.params) ? skillRequest.params : {};
  const messages = normalizePromptMetaMessages(params.messages);
  const latestUserMessage = pickFirstTrimmed(
    params.user_message,
    params.message,
    params.text,
  );
  if (!latestUserMessage) return messages;

  const lastMessage = messages[messages.length - 1];
  if (
    lastMessage &&
    String(lastMessage.role || '').trim().toLowerCase() === 'user' &&
    String(lastMessage.content || '').trim() === latestUserMessage
  ) {
    return messages;
  }

  return messages.concat({ role: 'user', content: latestUserMessage });
}

async function buildPromptMetaForChatRequest(skillRequest) {
  const messages = buildPromptMetaMessages(skillRequest);
  if (messages.length === 0) return null;

  const latestUserMessage =
    [...messages]
      .reverse()
      .find((item) => String(item?.role || '').trim().toLowerCase() === 'user')
      ?.content || null;

  const orchestrationMeta = await handleAuroraBeautyOrchestration({
    messages,
    context: {
      source_profile: {
        source: 'aurora-bff',
        default_entry_layer: 'orchestration',
      },
      raw_user_goal: latestUserMessage,
    },
  });

  return {
    prompt_intent: orchestrationMeta?.prompt_intent || null,
    conversation_progress: orchestrationMeta?.conversation_progress || null,
    early_decision: orchestrationMeta?.early_decision || null,
    decision_owner: orchestrationMeta?.decision_owner || null,
  };
}

function mergePromptMeta(payload, promptMeta) {
  if (!isPlainObject(promptMeta)) return payload;

  const base = isPlainObject(payload) ? { ...payload } : {};
  const meta = isPlainObject(base.meta) ? { ...base.meta } : {};
  for (const [key, value] of Object.entries(promptMeta)) {
    const normalized = String(value || '').trim();
    if (normalized) meta[key] = normalized;
  }
  const out = {
    ...base,
    meta,
  };

  const sessionPatch =
    isPlainObject(base.session_patch)
      ? { ...base.session_patch }
      : isPlainObject(base.sessionPatch)
        ? { ...base.sessionPatch }
        : null;
  if (sessionPatch) {
    const sessionMeta = isPlainObject(sessionPatch.meta) ? { ...sessionPatch.meta } : {};
    for (const [key, value] of Object.entries(promptMeta)) {
      const normalized = String(value || '').trim();
      if (normalized) sessionMeta[key] = normalized;
    }
    sessionPatch.meta = sessionMeta;
    if (isPlainObject(base.session_patch)) out.session_patch = sessionPatch;
    else out.sessionPatch = sessionPatch;
  }

  return out;
}

module.exports = {
  buildPromptMetaForChatRequest,
  mergePromptMeta,
};
