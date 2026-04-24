const assert = require('node:assert/strict');
const test = require('node:test');

const gate = require('../scripts/aurora_beauty_followup_gate.cjs').__internal;

test('follow-up gate resolves dynamic replies from previous refinement question field', () => {
  const turns = gate.normalizeTurns({
    case_id: 'dynamic_case',
    turns: [
      { turn_id: 't1', message: 'What should I buy?' },
      {
        turn_id: 't2',
        dynamic_reply: {
          source: 'previous_refinement_question',
          answers: {
            location_climate: 'I live in Seattle and wear makeup daily.',
            default: 'I am oily and need a simple first product.',
          },
        },
      },
    ],
  });

  assert.equal(turns[1].message, '');
  assert.equal(turns[1].dynamic_reply.source, 'previous_refinement_question');
  assert.equal(
    gate.resolveDynamicTurnMessage(turns[1], {
      last_refinement_field: 'location_climate',
      last_refinement_question: 'What city or climate are you usually in?',
    }),
    'I live in Seattle and wear makeup daily.',
  );
});

test('follow-up gate extracts assistant refinement question from recommendation card meta', () => {
  const question = gate.extractRecoRefinementQuestion({
    cards: [
      {
        type: 'recommendations',
        payload: {
          recommendation_meta: {
            assistant_refinement_question: {
              field: 'current_routine',
              question: 'What AM/PM steps or products are you already using?',
              rationale: 'current_routine_missing',
              optional: true,
            },
          },
        },
      },
    ],
  });

  assert.equal(question.field, 'current_routine');
  assert.equal(question.question, 'What AM/PM steps or products are you already using?');
});

test('follow-up gate extracts the final visible assistant question as text fallback', () => {
  assert.equal(
    gate.extractLastAssistantQuestion('Start with Product A. Product B is lighter. What city or climate are you usually in?'),
    'What city or climate are you usually in?',
  );
});
