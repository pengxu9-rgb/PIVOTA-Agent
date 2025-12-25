const fs = require('fs');
const path = require('path');

const { FaceProfileV0Schema } = require('../../src/layer1/schemas/faceProfileV0');
const { SimilarityReportV0Schema } = require('../../src/layer1/schemas/similarityReportV0');
const { Layer1BundleV0Schema } = require('../../src/layer1/schemas/layer1BundleV0');
const { ENGINE_VERSION } = require('../../src/layer1/compatibility/us/config/version');

function readJson(relPath) {
  const full = path.join(__dirname, '..', '..', relPath);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

describe('Layer1 contracts (US)', () => {
  test('fixtures validate against Zod schemas', () => {
    const face = readJson('fixtures/contracts/us/faceProfileV0.sample.json');
    const req = readJson('fixtures/contracts/us/compatibility.request.sample.json');
    const report = readJson('fixtures/contracts/us/similarityReportV0.sample.json');
    const bundle = readJson('fixtures/contracts/us/layer1BundleV0.sample.json');

    FaceProfileV0Schema.parse(face);
    FaceProfileV0Schema.parse(req.refFaceProfile);
    FaceProfileV0Schema.parse(req.userFaceProfile);
    SimilarityReportV0Schema.parse(report);
    Layer1BundleV0Schema.parse(bundle);
  });

  test('report invariants and version fields', () => {
    const report = readJson('fixtures/contracts/us/similarityReportV0.sample.json');

    expect(report.version).toBe('v0');
    expect(report.schemaVersion).toBe('v0');
    expect(report.engineVersion).toBe(ENGINE_VERSION);
    expect(String(report.engineVersion)).toMatch(/^compat-us-\d+\.\d+\.\d+$/);

    expect(report.reasons).toHaveLength(3);
    expect(report.adjustments).toHaveLength(3);
  });
});
