'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

function readRepoFile(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

test('routes.js keeps current_routine alias normalization on analysis and profile-update entrypoints', () => {
  const source = readRepoFile('src/auroraBff/routes.js');

  assert.match(
    source,
    /parsed\.data\.currentRoutine !== undefined \? parsed\.data\.currentRoutine : parsed\.data\.current_routine/,
  );
  assert.match(
    source,
    /normalizedBody\.currentRoutine === undefined && rawBody\.current_routine !== undefined/,
  );
});

test('routes.js defines previousRoutine from normalized state before lifecycle usage', () => {
  const source = readRepoFile('src/auroraBff/routes.js');

  assert.match(source, /const previousRoutineState = normalizeRoutineStateFromProfile\(profile\);/);
  assert.match(source, /const previousRoutine = previousRoutineState\.current_routine_struct;/);
});

test('active ops scripts accept analysis_story_v2 as canonical analysis card', () => {
  const internalBatchHelpers = readRepoFile('scripts/internal_batch_helpers.mjs');
  const photoModulesSmoke = readRepoFile('scripts/smoke_photo_modules_production.sh');
  const evalCircleAccuracy = readRepoFile('scripts/eval_circle_accuracy.mjs');
  const verifyBudgetGuard = readRepoFile('scripts/probe_verify_budget_guard.sh');

  assert.match(internalBatchHelpers, /findCardByType\(cards, 'analysis_story_v2'\) \|\| findCardByType\(cards, 'analysis_summary'\)/);
  assert.match(photoModulesSmoke, /analysis_story_v2", "analysis_summary"/);
  assert.match(evalCircleAccuracy, /analysis_story_v2/);
  assert.match(verifyBudgetGuard, /analysis_story_v2/);
});
