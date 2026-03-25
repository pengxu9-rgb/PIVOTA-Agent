const { buildSourceProfile, cloneSourceProfile } = require('../../modules/contracts/sourceProfile');

function normalizeSourceToken(source) {
  return String(source || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-');
}

const SOURCE_PROFILE_SPECS = Object.freeze([
  buildSourceProfile({
    source: 'search',
    caller_kind: 'public',
    default_entry_layer: 'execution_facing',
    interaction_mode: 'direct',
    allow_clarification: false,
    allow_external_supplement: false,
    allow_execution_handoff: true,
    response_contract: 'public_search',
    policy_tags: ['stable_public_search', 'override_resistant'],
  }),
  buildSourceProfile({
    source: 'shopping_agent',
    caller_kind: 'agent_tool',
    default_entry_layer: 'decisioning',
    interaction_mode: 'conversational',
    allow_clarification: true,
    allow_external_supplement: true,
    allow_execution_handoff: true,
    response_contract: 'decisioning',
    policy_tags: ['broad_commerce_search', 'internal_plus_external'],
  }),
  buildSourceProfile({
    source: 'aurora-bff',
    caller_kind: 'chat_surface',
    default_entry_layer: 'orchestration',
    interaction_mode: 'conversational',
    allow_clarification: true,
    allow_external_supplement: true,
    allow_execution_handoff: true,
    response_contract: 'orchestration',
    policy_tags: ['aurora_orchestration', 'shared_commerce_semantics'],
  }),
]);

const SOURCE_ALIASES = Object.freeze({
  search: 'search',
  'shopping-agent': 'shopping_agent',
  'shopping-agent-ui': 'shopping_agent',
  'shopping-agent-web': 'shopping_agent',
  'shopping-web': 'shopping_agent',
  'agent-sdk-fixed-delegate': 'shopping_agent',
  'aurora-bff': 'aurora-bff',
  'aurora-chatbox': 'aurora-bff',
});

const SOURCE_PROFILES_BY_CANONICAL = new Map(
  SOURCE_PROFILE_SPECS.map((profile) => [profile.source, profile]),
);

function resolveSourceProfile(source) {
  const normalized = normalizeSourceToken(source);
  const canonical = SOURCE_ALIASES[normalized] || null;
  if (!canonical) return null;
  const profile = SOURCE_PROFILES_BY_CANONICAL.get(canonical);
  return profile ? cloneSourceProfile(profile) : null;
}

function getDefaultEntryLayerForSource(source, fallback = null) {
  return resolveSourceProfile(source)?.default_entry_layer || fallback;
}

function isPublicSearchSource(source) {
  return resolveSourceProfile(source)?.source === 'search';
}

function isShoppingAgentSource(source) {
  return resolveSourceProfile(source)?.source === 'shopping_agent';
}

function isAuroraSource(source) {
  return resolveSourceProfile(source)?.source === 'aurora-bff';
}

module.exports = {
  SOURCE_PROFILE_SPECS,
  normalizeSourceToken,
  resolveSourceProfile,
  getDefaultEntryLayerForSource,
  isPublicSearchSource,
  isShoppingAgentSource,
  isAuroraSource,
};
