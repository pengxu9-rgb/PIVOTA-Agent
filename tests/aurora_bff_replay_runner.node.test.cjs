const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadReplayFixtures,
  runReplayFixture,
  runReplayFixtures,
} = require('../src/auroraBff/tools/replayRunner');

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('replay runner: bundled fixtures all pass', () => {
  const fixtures = loadReplayFixtures();
  assert.ok(fixtures.length >= 5);

  const report = runReplayFixtures(fixtures);
  assert.equal(report.summary.failed, 0, JSON.stringify(report.results.filter((r) => !r.pass), null, 2));
});

test('replay runner: detects ui_next_state mismatch', () => {
  const fixtures = loadReplayFixtures();
  const fixture = deepClone(fixtures[0]);
  fixture.expected = fixture.expected || {};
  fixture.expected.ui_next_state = 'IDLE_CHAT';

  const out = runReplayFixture(fixture, { index: 0 });
  assert.equal(out.pass, false);
  assert.equal(out.failures.some((f) => f && f.rule === 'ui_next_state'), true);
});

test('replay runner: hard_fail_forbidden alias maps to scorer reasons', () => {
  const fixture = {
    name: 'alias_medical_diagnosis_forbidden',
    input: {
      user_text: 'diagnose me',
      ctx: {
        lang: 'CN',
        accept_language: 'zh-CN',
        state: 'idle',
      },
      session: {
        next_state: 'IDLE_CHAT',
      },
      bootstrap: {},
      seed_envelope: {
        assistant_message: {
          role: 'assistant',
          format: 'text',
          content: '你有湿疹，我可以确诊。',
        },
        cards: [],
        suggested_chips: [],
      },
    },
    expected: {
      ui_next_state: 'IDLE_CHAT',
      quality_min_score: 0,
      hard_fail_forbidden: ['medical_diagnosis'],
    },
  };

  const out = runReplayFixture(fixture, { index: 99 });
  assert.equal(out.pass, false);
  assert.equal(out.failures.some((f) => f && f.rule === 'hard_fail_forbidden'), true);
});
