const fs = require('fs');
const path = require('path');

const { LookReplicateResultV0Schema } = require('../../src/schemas/lookReplicateResultV0');

function readJson(relPath) {
  const full = path.join(__dirname, '..', '..', relPath);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function assertCandidateList(result) {
  expect(Array.isArray(result.adjustmentCandidates)).toBe(true);
  expect(result.adjustmentCandidates.length).toBeGreaterThanOrEqual(3);
  expect(result.adjustmentCandidates.length).toBeLessThanOrEqual(7);

  // If candidates are present, the response should include correlation IDs.
  expect(typeof result.exposureId).toBe('string');
  expect(result.exposureId.length).toBeGreaterThan(0);

  const ranks = result.adjustmentCandidates.map((c) => c.rank);
  expect(new Set(ranks).size).toBe(ranks.length);
  const impressionIds = result.adjustmentCandidates.map((c) => c.impressionId);
  for (const id of impressionIds) {
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  }
  expect(new Set(impressionIds).size).toBe(impressionIds.length);
  for (const c of result.adjustmentCandidates) {
    expect(typeof c.id).toBe('string');
    expect(c.id.length).toBeGreaterThan(0);
    expect(typeof c.title).toBe('string');
    expect(c.title.length).toBeGreaterThan(0);
    expect(typeof c.why).toBe('string');
    expect(c.why.length).toBeGreaterThan(0);
    expect(c.why.length).toBeLessThanOrEqual(120);
    expect(typeof c.score).toBe('number');
    expect(c.score).toBeGreaterThanOrEqual(0);
    expect(c.score).toBeLessThanOrEqual(1);
  }

  // Top3 correspond to the 3 default adjustments (by area).
  const defaultCandidates = result.adjustmentCandidates.filter((c) => c.isDefault);
  expect(defaultCandidates).toHaveLength(3);
  for (const a of result.adjustments) {
    const expectedId = `default:${a.impactArea}`;
    expect(defaultCandidates.some((c) => c.id === expectedId)).toBe(true);
  }
}

describe('AdjustmentCandidates (v0, Phase 1.5)', () => {
  test('fixtures parse with optional adjustmentCandidates (US)', () => {
    const lookResult = readJson('fixtures/contracts/us/lookResultV0.sample.json');
    const parsed = LookReplicateResultV0Schema.parse(lookResult);
    assertCandidateList(parsed);
  });

  test('fixtures parse with optional adjustmentCandidates (JP)', () => {
    const lookResult = readJson('fixtures/contracts/jp/lookResultV0.sample.json');
    const parsed = LookReplicateResultV0Schema.parse(lookResult);
    assertCandidateList(parsed);
    expect(parsed.market).toBe('JP');
    expect(parsed.commerceEnabled).toBe(false);
  });
});
