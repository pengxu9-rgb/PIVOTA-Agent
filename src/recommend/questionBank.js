const QUESTION_BANK = {
  Q_BUDGET: {
    id: 'Q_BUDGET',
    text: 'What budget are you thinking about?',
    chips: [
      { id: 'BUDGET_LOW', label: 'Low' },
      { id: 'BUDGET_MID', label: 'Mid' },
      { id: 'BUDGET_HIGH', label: 'High' },
    ],
    slot: 'budget',
  },
  Q_USE_CASE: {
    id: 'Q_USE_CASE',
    text: 'What will you use it for?',
    chips: [
      { id: 'USE_COMMUTE', label: 'Commute' },
      { id: 'USE_GYM', label: 'Gym' },
      { id: 'USE_TRAVEL', label: 'Travel' },
    ],
    slot: 'use_case',
  },
  Q_STYLE: {
    id: 'Q_STYLE',
    text: 'Any style preference?',
    chips: [
      { id: 'STYLE_MINIMAL', label: 'Minimal' },
      { id: 'STYLE_STREET', label: 'Street' },
      { id: 'STYLE_CLASSIC', label: 'Classic' },
    ],
    slot: 'style',
  },
};

const DEFAULT_QUESTION_ORDER = ['Q_BUDGET', 'Q_USE_CASE', 'Q_STYLE'];

function pickQuestion(state, overrides = {}) {
  // Simple deterministic pick: first unanswered slot in DEFAULT_QUESTION_ORDER.
  const answered = state.answered_slots || {};
  const ordered = overrides.order || DEFAULT_QUESTION_ORDER;
  const selected = ordered.find((qid) => {
    const q = QUESTION_BANK[qid];
    if (!q) return false;
    if (answered[q.slot]) return false;
    return true;
  });
  if (!selected) return null;
  return QUESTION_BANK[selected];
}

module.exports = {
  QUESTION_BANK,
  DEFAULT_QUESTION_ORDER,
  pickQuestion,
};
