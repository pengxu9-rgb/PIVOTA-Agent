/**
 * Map SkillResponse -> ChatCards v1 response envelope.
 *
 * ChatCards v1 contract (from AURORA_CHAT_CARDS_REUSE_MATRIX):
 * - MUST NOT return: assistant_message, suggested_chips, session_patch, events
 * - MUST return: cards[], ops (thread_ops, profile_patch, routine_patch, experiment_events)
 */
function mapSkillResponseToChatCardsV1(skillResponse) {
  return {
    cards: (skillResponse.cards || []).map(mapCard),
    ops: {
      thread_ops: skillResponse.ops?.thread_ops || [],
      profile_patch: skillResponse.ops?.profile_patch || {},
      routine_patch: skillResponse.ops?.routine_patch || {},
      experiment_events: buildExperimentEvents(skillResponse),
    },
  };
}

function mapCard(card) {
  const sectionType = `${card.card_type}_structured`;
  return {
    card_type: card.card_type,
    sections: card.sections.map((section) => ({
      type: section.type || sectionType,
      ...section,
    })),
    metadata: {
      ...(card.metadata || {}),
    },
  };
}

function buildExperimentEvents(skillResponse) {
  const events = [...(skillResponse.ops?.experiment_events || [])];

  events.push({
    event: 'skill_executed',
    skill_id: skillResponse.telemetry?.skill_id,
    skill_version: skillResponse.telemetry?.skill_version,
    quality_ok: skillResponse.quality?.quality_ok,
    elapsed_ms: skillResponse.telemetry?.elapsed_ms,
    llm_calls: skillResponse.telemetry?.llm_calls,
  });

  return events;
}

module.exports = { mapSkillResponseToChatCardsV1 };
