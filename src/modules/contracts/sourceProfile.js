const { normalizeLayerType } = require('./layerType');

function cloneJsonSafe(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function buildSourceProfile(input = {}) {
  const source = String(input.source || '').trim();
  if (!source) {
    throw new Error('SOURCE_PROFILE_INVALID:source_required');
  }

  const defaultEntryLayer = normalizeLayerType(input.default_entry_layer);
  if (!defaultEntryLayer) {
    throw new Error('SOURCE_PROFILE_INVALID:default_entry_layer_required');
  }

  return {
    source,
    caller_kind: String(input.caller_kind || '').trim() || 'public',
    default_entry_layer: defaultEntryLayer,
    interaction_mode: String(input.interaction_mode || '').trim() || 'direct',
    allow_clarification: input.allow_clarification === true,
    allow_external_supplement: input.allow_external_supplement === true,
    allow_execution_handoff: input.allow_execution_handoff !== false,
    response_contract: String(input.response_contract || '').trim() || 'public_search',
    policy_tags: Array.isArray(input.policy_tags)
      ? input.policy_tags.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
  };
}

function cloneSourceProfile(profile) {
  return buildSourceProfile(cloneJsonSafe(profile || {}));
}

module.exports = {
  buildSourceProfile,
  cloneSourceProfile,
};
