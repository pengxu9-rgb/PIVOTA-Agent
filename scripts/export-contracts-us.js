/* eslint-disable no-console */
const fs = require('fs/promises');
const path = require('path');

const { zodToJsonSchema } = require('zod-to-json-schema');

const { FaceProfileV0Schema } = require('../src/layer1/schemas/faceProfileV0');
const { SimilarityReportV0Schema } = require('../src/layer1/schemas/similarityReportV0');
const { Layer1BundleV0Schema } = require('../src/layer1/schemas/layer1BundleV0');
const { runCompatibilityEngineUS } = require('../src/layer1/compatibility/us/runCompatibilityEngineUS');
const { ENGINE_VERSION } = require('../src/layer1/compatibility/us/config/version');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepSort(value) {
  if (Array.isArray(value)) return value.map(deepSort);
  if (!isPlainObject(value)) return value;

  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = deepSort(value[key]);
  }
  return out;
}

function stableJson(value) {
  return JSON.stringify(deepSort(value), null, 2) + '\n';
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, stableJson(value), 'utf8');
  console.log('[contracts] wrote', path.relative(process.cwd(), filePath));
}

function makeFaceProfileSample(source, overrides = {}) {
  const base = {
    version: 'v0',
    market: 'US',
    source,
    locale: 'en',
    quality: {
      valid: true,
      score: 95,
      faceCount: 1,
      lightingScore: 85,
      sharpnessScore: 90,
      pose: { yawDeg: 1.0, pitchDeg: -1.0, rollDeg: 0.5 },
      occlusionFlags: { eyesOccluded: false, mouthOccluded: false, faceBorderCutoff: false },
      rejectReasons: [],
    },
    geometry: {
      faceAspect: 1.05,
      jawToCheekRatio: 0.8,
      chinLengthRatio: 0.24,
      midfaceRatio: 0.38,
      eyeSpacingRatio: 0.29,
      eyeTiltDeg: 2.5,
      eyeOpennessRatio: 0.26,
      lipFullnessRatio: 0.22,
    },
    categorical: {
      faceShape: 'oval',
      eyeType: 'almond',
      lipType: 'balanced',
    },
    derived: {
      geometryVector: [],
      embeddingVersion: 'geom-v0',
    },
  };

  const merged = {
    ...base,
    ...overrides,
    quality: { ...base.quality, ...(overrides.quality || {}) },
    geometry: { ...base.geometry, ...(overrides.geometry || {}) },
    categorical: { ...base.categorical, ...(overrides.categorical || {}) },
  };

  merged.derived.geometryVector = [
    merged.geometry.faceAspect,
    merged.geometry.jawToCheekRatio,
    merged.geometry.chinLengthRatio,
    merged.geometry.midfaceRatio,
    merged.geometry.eyeSpacingRatio,
    merged.geometry.eyeTiltDeg,
    merged.geometry.eyeOpennessRatio,
    merged.geometry.lipFullnessRatio,
  ];

  return FaceProfileV0Schema.parse(merged);
}

function makeCompatibilityRequestSample() {
  const refFaceProfile = makeFaceProfileSample('reference', {
    geometry: { eyeTiltDeg: 10.0, lipFullnessRatio: 0.18 },
    categorical: { eyeType: 'almond', lipType: 'thin' },
  });
  const userFaceProfile = makeFaceProfileSample('selfie', {
    geometry: { eyeTiltDeg: 0.5, lipFullnessRatio: 0.28 },
    categorical: { eyeType: 'round', lipType: 'full' },
  });

  return {
    market: 'US',
    locale: 'en',
    preferenceMode: 'structure',
    userFaceProfile,
    refFaceProfile,
    optInTraining: false,
    sessionId: 'sess_contract_sample_01',
  };
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const contractsDir = path.join(repoRoot, 'contracts', 'us');
  const fixturesDir = path.join(repoRoot, 'fixtures', 'contracts', 'us');

  if (!ENGINE_VERSION || typeof ENGINE_VERSION !== 'string') {
    throw new Error('ENGINE_VERSION is missing');
  }

  const faceProfileSchema = zodToJsonSchema(FaceProfileV0Schema, {
    name: 'FaceProfileV0',
    $refStrategy: 'none',
  });
  const similaritySchema = zodToJsonSchema(SimilarityReportV0Schema, {
    name: 'SimilarityReportV0',
    $refStrategy: 'none',
  });
  const bundleSchema = zodToJsonSchema(Layer1BundleV0Schema, {
    name: 'Layer1BundleV0',
    $refStrategy: 'none',
  });

  await writeJson(path.join(contractsDir, 'faceProfileV0.schema.json'), faceProfileSchema);
  await writeJson(path.join(contractsDir, 'similarityReportV0.schema.json'), similaritySchema);
  await writeJson(path.join(contractsDir, 'layer1BundleV0.schema.json'), bundleSchema);

  const requestSample = makeCompatibilityRequestSample();
  const reportSample = runCompatibilityEngineUS({
    market: 'US',
    preferenceMode: requestSample.preferenceMode,
    userFaceProfile: requestSample.userFaceProfile,
    refFaceProfile: requestSample.refFaceProfile,
    locale: requestSample.locale,
  });

  const bundleSample = Layer1BundleV0Schema.parse({
    schemaVersion: 'v0',
    market: 'US',
    locale: requestSample.locale,
    preferenceMode: requestSample.preferenceMode,
    createdAt: '2025-01-01T00:00:00.000Z',
    userFaceProfile: requestSample.userFaceProfile,
    refFaceProfile: requestSample.refFaceProfile,
    similarityReport: reportSample,
  });

  await writeJson(path.join(fixturesDir, 'faceProfileV0.sample.json'), requestSample.refFaceProfile);
  await writeJson(path.join(fixturesDir, 'compatibility.request.sample.json'), requestSample);
  await writeJson(path.join(fixturesDir, 'similarityReportV0.sample.json'), reportSample);
  await writeJson(path.join(fixturesDir, 'layer1BundleV0.sample.json'), bundleSample);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
