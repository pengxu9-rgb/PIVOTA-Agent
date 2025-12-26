const fs = require('fs');
const path = require('path');

const { LookSpecV0Schema } = require('../../../layer2/schemas/lookSpecV0');
const { KitPlanV0Schema } = require('../../../layer3/schemas/kitPlanV0');
const { LookReplicateResultV0Schema } = require('../../../schemas/lookReplicateResultV0');

function readJson(relPath) {
  const full = path.join(__dirname, '..', '..', '..', '..', relPath);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertKitCompleteness(kitPlan) {
  assert(kitPlan && kitPlan.kit, 'kitPlan.kit is required');
  for (const area of ['base', 'eye', 'lip']) {
    const slot = kitPlan.kit[area];
    assert(slot && slot.best && slot.dupe, `kitPlan.kit.${area} must include best+dupe`);
    assert(slot.best.category === area, `kitPlan.kit.${area}.best.category must be ${area}`);
    assert(slot.dupe.category === area, `kitPlan.kit.${area}.dupe.category must be ${area}`);
  }
}

async function main() {
  const lookSpec = readJson('fixtures/contracts/us/lookSpecV0.sample.json');
  const kitPlan = readJson('fixtures/contracts/us/kitPlanV0.sample.json');
  const lookResult = readJson('fixtures/contracts/us/lookResultV0.sample.json');

  LookSpecV0Schema.parse(lookSpec);
  KitPlanV0Schema.parse(kitPlan);
  const parsedResult = LookReplicateResultV0Schema.parse(lookResult);

  assert(Array.isArray(parsedResult.adjustments) && parsedResult.adjustments.length === 3, 'expected 3 adjustments');
  assert(Array.isArray(parsedResult.steps) && parsedResult.steps.length >= 8 && parsedResult.steps.length <= 12, 'expected 8-12 steps');
  assertKitCompleteness(parsedResult.kit);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  });

