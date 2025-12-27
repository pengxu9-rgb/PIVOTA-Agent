const fs = require('fs');
const path = require('path');

const { LookSpecV0Schema } = require('../../src/layer2/schemas/lookSpecV0');
const { LookSpecV1Schema } = require('../../src/layer2/schemas/lookSpecV1');
const { KitPlanV0Schema } = require('../../src/layer3/schemas/kitPlanV0');
const { LookReplicateResultV0Schema } = require('../../src/schemas/lookReplicateResultV0');

function readJson(relPath) {
  const full = path.join(__dirname, '..', '..', relPath);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function assertKitCompleteness(kitPlan) {
  expect(kitPlan).toBeTruthy();
  expect(kitPlan.kit).toBeTruthy();
  for (const area of ['base', 'eye', 'lip']) {
    expect(kitPlan.kit[area]).toBeTruthy();
    expect(kitPlan.kit[area].best).toBeTruthy();
    expect(kitPlan.kit[area].dupe).toBeTruthy();
    expect(kitPlan.kit[area].best.category).toBe(area);
    expect(kitPlan.kit[area].dupe.category).toBe(area);
  }
}

describe('Layer2/3 contracts (US)', () => {
  test('fixtures validate against Zod schemas', () => {
    const lookSpec = readJson('fixtures/contracts/us/lookSpecV0.sample.json');
    const lookSpecV1 = readJson('fixtures/contracts/us/lookSpecV1.sample.json');
    const kitPlan = readJson('fixtures/contracts/us/kitPlanV0.sample.json');
    const lookResult = readJson('fixtures/contracts/us/lookResultV0.sample.json');

    LookSpecV0Schema.parse(lookSpec);
    LookSpecV1Schema.parse(lookSpecV1);
    KitPlanV0Schema.parse(kitPlan);
    LookReplicateResultV0Schema.parse(lookResult);
  });

  test('invariants: adjustments=3, steps=8-12, kit complete', () => {
    const lookResult = readJson('fixtures/contracts/us/lookResultV0.sample.json');

    expect(Array.isArray(lookResult.adjustments)).toBe(true);
    expect(lookResult.adjustments).toHaveLength(3);

    expect(Array.isArray(lookResult.steps)).toBe(true);
    expect(lookResult.steps.length).toBeGreaterThanOrEqual(8);
    expect(lookResult.steps.length).toBeLessThanOrEqual(12);

    assertKitCompleteness(lookResult.kit);
  });
});
