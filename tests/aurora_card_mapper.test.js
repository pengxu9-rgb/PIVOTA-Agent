const {
  mapSkillResponseToChatCardsV1,
  mapSkillResponseToStreamEnvelope,
} = require('../src/auroraBff/mappers/card_mapper');

test('card_mapper preserves next_actions params for dupe compare navigation', () => {
  const skillResponse = {
    cards: [
      {
        card_type: 'product_verdict',
        sections: [
          {
            type: 'product_verdict_structured',
            total_candidates: 2,
          },
        ],
      },
    ],
    ops: {
      thread_ops: [],
      profile_patch: {},
      routine_patch: {},
      experiment_events: [],
    },
    quality: {
      quality_ok: true,
    },
    telemetry: {
      skill_id: 'dupe.suggest',
      skill_version: '2.0.0',
      elapsed_ms: 42,
      llm_calls: 1,
    },
    next_actions: [
      {
        action_type: 'navigate_skill',
        target_skill_id: 'dupe.compare',
        label: { en: 'Compare in detail', zh: '详细对比' },
        params: {
          product_anchor: {
            brand: 'Lab Series',
            name: 'Daily Rescue',
            url: 'https://example.com/daily-rescue',
          },
          comparison_targets: [
            {
              brand: 'Clinique',
              name: 'Moisture Surge 100H',
            },
          ],
        },
      },
    ],
  };

  const mapped = mapSkillResponseToChatCardsV1(skillResponse);
  const streamed = mapSkillResponseToStreamEnvelope(skillResponse, []);

  expect(mapped.next_actions[0].params).toEqual(skillResponse.next_actions[0].params);
  expect(streamed.next_actions[0].params).toEqual(skillResponse.next_actions[0].params);
});
