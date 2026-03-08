function mapSkillResponseToChatCardsV1(skillResponse) {
  return {
    cards: (skillResponse.cards || []).map(mapCard),
    ops: {
      thread_ops: skillResponse.ops?.thread_ops || [],
      profile_patch: skillResponse.ops?.profile_patch || {},
      routine_patch: skillResponse.ops?.routine_patch || {},
      experiment_events: buildExperimentEvents(skillResponse),
    },
    next_actions: skillResponse.next_actions || [],
  };
}

function mapSkillResponseToStreamEnvelope(skillResponse, thinkingSteps) {
  return {
    cards: (skillResponse.cards || []).map(mapCard),
    ops: {
      thread_ops: skillResponse.ops?.thread_ops || [],
      profile_patch: skillResponse.ops?.profile_patch || {},
      routine_patch: skillResponse.ops?.routine_patch || {},
      experiment_events: buildExperimentEvents(skillResponse),
    },
    next_actions: skillResponse.next_actions || [],
    thinking_steps: thinkingSteps || [],
    meta: {
      skill_id: skillResponse.telemetry?.skill_id || null,
      task_mode: skillResponse.telemetry?.task_mode || null,
      elapsed_ms: skillResponse.telemetry?.elapsed_ms || 0,
      quality_ok: skillResponse.quality?.quality_ok === true,
    },
  };
}

function mapCard(card) {
  return {
    card_type: card.card_type,
    sections: (card.sections || []).map((section) => ({
      type: section.type || `${card.card_type}_structured`,
      ...section,
    })),
    metadata: card.metadata || {},
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

module.exports = {
  mapSkillResponseToChatCardsV1,
  mapSkillResponseToStreamEnvelope,
};
