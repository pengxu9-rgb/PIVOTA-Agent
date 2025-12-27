/* eslint-disable no-console */
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

const { zodToJsonSchema } = require('zod-to-json-schema');

const { FaceProfileV0Schema } = require('../src/layer1/schemas/faceProfileV0');
const { SimilarityReportV0Schema } = require('../src/layer1/schemas/similarityReportV0');
const { Layer1BundleV0Schema } = require('../src/layer1/schemas/layer1BundleV0');
const { runCompatibilityEngineUS } = require('../src/layer1/compatibility/us/runCompatibilityEngineUS');
const { ENGINE_VERSION } = require('../src/layer1/compatibility/us/config/version');
const { LookSpecV0Schema } = require('../src/layer2/schemas/lookSpecV0');
const { LookSpecV1Schema } = require('../src/layer2/schemas/lookSpecV1');
const { StepPlanV0Schema } = require('../src/layer2/schemas/stepPlanV0');
const { KitPlanV0Schema } = require('../src/layer3/schemas/kitPlanV0');
const { LookReplicateResultV0Schema } = require('../src/schemas/lookReplicateResultV0');

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

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256HexString(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function deterministicId(prefix, seed, counter) {
  const hex = sha256HexString(`${seed}:${counter}`).slice(0, 16);
  return `${prefix}_${hex}`;
}

function tryGetGitCommitSha(repoRoot) {
  try {
    const sha = childProcess
      .execSync('git rev-parse HEAD', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .trim();
    if (!sha) return 'unknown';
    return sha;
  } catch {
    return 'unknown';
  }
}

async function writeContractManifest({ repoRoot, manifestPath, filePaths }) {
  const repoRelativeEntries = await Promise.all(
    filePaths.map(async (absolutePath) => {
      const bytes = await fs.readFile(absolutePath);
      const rel = path.relative(repoRoot, absolutePath).split(path.sep).join('/');
      return { path: rel, sha256: sha256Hex(bytes) };
    })
  );

  repoRelativeEntries.sort((a, b) => a.path.localeCompare(b.path));

  const manifest = {
    generatedAt: '2025-01-01T00:00:00.000Z',
    refHint: tryGetGitCommitSha(repoRoot),
    files: repoRelativeEntries,
  };

  await writeJson(manifestPath, manifest);
}

async function listJsonFilesRecursively(rootDir) {
  const entries = [];
  async function walk(dir) {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) {
        await walk(p);
        continue;
      }
      if (!it.isFile()) continue;
      if (!it.name.endsWith('.json')) continue;
      if (it.name === 'manifest.json') continue;
      entries.push(p);
    }
  }
  await walk(rootDir);
  return entries.sort((a, b) => a.localeCompare(b));
}

async function writeContractManifestFromDirs({ repoRoot, manifestPath, dirs }) {
  const files = [];
  for (const d of dirs) {
    files.push(...(await listJsonFilesRecursively(d)));
  }

  await writeContractManifest({
    repoRoot,
    manifestPath,
    filePaths: files,
  });
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

function makeLookSpecSample() {
  const locale = 'en';
  const breakdown = {
    base: {
      intent: 'even skin tone, natural look',
      finish: 'natural',
      coverage: 'light',
      keyNotes: ['freckles visible', 'soft glow', 'minimal conceal'],
      evidence: ['skin looks even', 'no heavy contour', 'natural sheen'],
    },
    eye: {
      intent: 'natural enhancement',
      finish: 'soft',
      coverage: 'light',
      keyNotes: ['subtle definition', 'no heavy eyeliner', 'natural lashes'],
      evidence: ['bright eyes', 'minimal shadow', 'defined lashes'],
    },
    lip: {
      intent: 'soft, natural color',
      finish: 'hydrated',
      coverage: 'light',
      keyNotes: ['hydrated appearance', 'slight tint', 'soft sheen'],
      evidence: ['lips look moisturized', 'no bold color', 'even tint'],
    },
  };

  return LookSpecV0Schema.parse({
    schemaVersion: 'v0',
    market: 'US',
    locale,
    layer2EngineVersion: 'l2-us-0.1.0',
    layer3EngineVersion: 'l3-us-0.1.0',
    orchestratorVersion: 'orchestrator-us-0.1.0',
    lookTitle: 'Natural Glow',
    styleTags: ['natural', 'fresh', 'everyday'],
    breakdown,
    warnings: [],
  });
}

function makeLookSpecV1Sample() {
  const v0 = makeLookSpecSample();
  return LookSpecV1Schema.parse({
    ...v0,
    schemaVersion: 'v1',
    breakdown: {
      ...v0.breakdown,
      prep: { intent: 'unknown', finish: 'unknown', coverage: 'unknown', keyNotes: [], evidence: [] },
      brow: { intent: 'unknown', finish: 'unknown', coverage: 'unknown', keyNotes: [], evidence: [] },
      blush: { intent: 'unknown', finish: 'unknown', coverage: 'unknown', keyNotes: [], evidence: [] },
      contour: {
        intent: 'unknown',
        finish: 'unknown',
        coverage: 'unknown',
        keyNotes: [],
        evidence: [],
        highlight: { intensity: 'unknown' },
      },
    },
  });
}

function makeStepPlanSamples(locale) {
  const base = {
    schemaVersion: 'v0',
    market: 'US',
    locale,
    layer2EngineVersion: 'l2-us-0.1.0',
    layer3EngineVersion: 'l3-us-0.1.0',
    orchestratorVersion: 'orchestrator-us-0.1.0',
  };

  const steps = [
    {
      stepId: 'l2_step_0',
      order: 0,
      impactArea: 'base',
      title: 'Prep skin',
      instruction: 'Moisturize and apply primer as needed for a smooth base.',
      tips: ['Let skincare absorb before applying makeup.'],
      cautions: [],
      fitConditions: [],
      evidence: ['lookSpec.breakdown.base.intent'],
    },
    {
      stepId: 'l2_step_1',
      order: 1,
      impactArea: 'base',
      title: 'Apply light base',
      instruction: 'Use a light coverage foundation and blend evenly.',
      tips: ['Apply thin layers and build only where needed.'],
      cautions: ['Avoid heavy layers that hide natural skin texture.'],
      fitConditions: [],
      evidence: ['lookSpec.breakdown.base.coverage'],
    },
    {
      stepId: 'l2_step_2',
      order: 2,
      impactArea: 'base',
      title: 'Spot conceal',
      instruction: 'Conceal only where needed and re-blend edges.',
      tips: [],
      cautions: [],
      fitConditions: [],
      evidence: ['lookSpec.breakdown.base.keyNotes[2]'],
    },
    {
      stepId: 'l2_step_3',
      order: 3,
      impactArea: 'eye',
      title: 'Groom brows softly',
      instruction: 'Brush brows upward and fill sparse areas lightly.',
      tips: ['Use short strokes for a natural finish.'],
      cautions: [],
      fitConditions: [],
      evidence: ['lookSpec.breakdown.eye.keyNotes[0]'],
    },
    {
      stepId: 'l2_step_4',
      order: 4,
      impactArea: 'eye',
      title: 'Define lashes',
      instruction: 'Apply mascara with a light hand to define lashes.',
      tips: ['Wiggle at the root for lift.'],
      cautions: ['Avoid clumps by combing through.'],
      fitConditions: [],
      evidence: ['lookSpec.breakdown.eye.keyNotes[2]'],
    },
    {
      stepId: 'l2_step_5',
      order: 5,
      impactArea: 'eye',
      title: 'Optional soft shadow',
      instruction: 'Use a neutral wash of shadow only if needed for subtle definition.',
      tips: [],
      cautions: ['Skip if it makes the look too heavy.'],
      fitConditions: [],
      evidence: ['lookSpec.breakdown.eye.finish'],
    },
    {
      stepId: 'l2_step_6',
      order: 6,
      impactArea: 'lip',
      title: 'Prep lips',
      instruction: 'Apply balm and blot so lips feel hydrated but not slippery.',
      tips: [],
      cautions: [],
      fitConditions: [],
      evidence: ['lookSpec.breakdown.lip.keyNotes[0]'],
    },
    {
      stepId: 'l2_step_7',
      order: 7,
      impactArea: 'lip',
      title: 'Add soft tint',
      instruction: 'Apply a tinted balm or sheer lipstick for a natural color.',
      tips: ['Tap with a finger for a softer edge.'],
      cautions: ['Avoid bold colors.'],
      fitConditions: [],
      evidence: ['lookSpec.breakdown.lip.coverage'],
    },
  ];

  return steps.map((s) => StepPlanV0Schema.parse({ ...base, ...s }));
}

function makeProductAttributesSample({ locale, category, seed, counter, priceTier }) {
  return {
    schemaVersion: 'v0',
    market: 'US',
    locale,
    layer2EngineVersion: 'l2-us-0.1.0',
    layer3EngineVersion: 'l3-us-0.1.0',
    orchestratorVersion: 'orchestrator-us-0.1.0',
    category,
    skuId: deterministicId('sku', seed, counter),
    name: `${category.toUpperCase()} Sample ${counter}`,
    brand: 'Chydan',
    price: { currency: 'USD', amount: 19.99 + counter },
    priceTier,
    imageUrl: 'https://example.com/product.png',
    productUrl: 'https://example.com/product',
    availability: 'in_stock',
    availabilityByMarket: { US: 'in_stock' },
    tags: { finish: ['natural'], texture: ['cream'], coverage: ['light'], effect: [] },
    undertoneFit: 'unknown',
    shadeDescriptor: 'neutral',
    whyThis: `Deterministic sample for ${category} (${priceTier}).`,
    evidence: ['contract.fixture'],
  };
}

function makeKitPlanSample({ locale }) {
  const seed = 'contract.us.kitPlanV0.v0';
  return KitPlanV0Schema.parse({
    schemaVersion: 'v0',
    market: 'US',
    locale,
    layer2EngineVersion: 'l2-us-0.1.0',
    layer3EngineVersion: 'l3-us-0.1.0',
    orchestratorVersion: 'orchestrator-us-0.1.0',
    kit: {
      base: {
        best: makeProductAttributesSample({ locale, category: 'base', seed, counter: 1, priceTier: 'mid' }),
        dupe: makeProductAttributesSample({ locale, category: 'base', seed, counter: 2, priceTier: 'budget' }),
      },
      eye: {
        best: makeProductAttributesSample({ locale, category: 'eye', seed, counter: 3, priceTier: 'mid' }),
        dupe: makeProductAttributesSample({ locale, category: 'eye', seed, counter: 4, priceTier: 'budget' }),
      },
      lip: {
        best: makeProductAttributesSample({ locale, category: 'lip', seed, counter: 5, priceTier: 'mid' }),
        dupe: makeProductAttributesSample({ locale, category: 'lip', seed, counter: 6, priceTier: 'budget' }),
      },
    },
    warnings: [],
  });
}

function makeLookResultSample() {
  const lookSpec = makeLookSpecSample();
  const locale = lookSpec.locale;
  const steps = makeStepPlanSamples(locale);
  const kit = makeKitPlanSample({ locale });
  const seed = 'contracts:lookResultV0:US';
  const exposureId = deterministicId('exposure', seed, 0);
  const experimentSeed = crypto.createHash('sha256').update(`lr_more_v1:${exposureId}`).digest('hex').slice(0, 16);

  const adjustments = [
    {
      impactArea: 'base',
      title: 'Keep base light',
      because: 'Preserve skin texture while evening tone.',
      do: 'Apply thin layers and spot conceal only where needed.',
      why: 'Preserve skin texture while evening tone.',
      evidence: ['lookSpec.breakdown.base.coverage'],
      confidence: 'medium',
    },
    {
      impactArea: 'eye',
      title: 'Subtle lash definition',
      because: 'Maintain natural enhancement without harsh lines.',
      do: 'Use mascara lightly and skip heavy eyeliner.',
      why: 'Maintain natural enhancement without harsh lines.',
      evidence: ['lookSpec.breakdown.eye.keyNotes[1]'],
      confidence: 'low',
    },
    {
      impactArea: 'lip',
      title: 'Soft tinted balm',
      because: 'Match the hydrated, slightly tinted lip.',
      do: 'Use a tinted balm and blot to control intensity.',
      why: 'Match the hydrated, slightly tinted lip.',
      evidence: ['lookSpec.breakdown.lip.keyNotes[0]'],
      confidence: 'medium',
    },
  ];

  const adjustmentCandidates = [
    {
      id: 'default:base',
      area: 'base',
      title: adjustments[0].title,
      why: adjustments[0].because,
      techniqueId: null,
      ruleId: null,
      score: 0.7,
      rank: 1,
      isDefault: true,
      gating: { status: 'ok' },
    },
    {
      id: 'default:eye',
      area: 'eye',
      title: adjustments[1].title,
      why: adjustments[1].because,
      techniqueId: null,
      ruleId: null,
      score: 0.4,
      rank: 2,
      isDefault: true,
      gating: { status: 'low_confidence' },
    },
    {
      id: 'default:lip',
      area: 'lip',
      title: adjustments[2].title,
      why: adjustments[2].because,
      techniqueId: null,
      ruleId: null,
      score: 0.7,
      rank: 3,
      isDefault: true,
      gating: { status: 'ok' },
    },
    {
      id: 'more:prep',
      area: 'prep',
      title: 'Prep option',
      why: 'Optional prep tips may help the base sit better.',
      techniqueId: null,
      ruleId: null,
      score: 0.15,
      rank: 4,
      isDefault: false,
      gating: { status: 'low_coverage', reason: 'No technique coverage yet for this area.' },
    },
    {
      id: 'more:brow',
      area: 'brow',
      title: 'Brow option',
      why: 'Optional brow shaping can change the overall balance.',
      techniqueId: null,
      ruleId: null,
      score: 0.15,
      rank: 5,
      isDefault: false,
      gating: { status: 'low_coverage', reason: 'No technique coverage yet for this area.' },
    },
    {
      id: 'more:blush',
      area: 'blush',
      title: 'Blush option',
      why: 'Optional blush placement can shift the look’s mood.',
      techniqueId: null,
      ruleId: null,
      score: 0.15,
      rank: 6,
      isDefault: false,
      gating: { status: 'low_coverage', reason: 'No technique coverage yet for this area.' },
    },
    {
      id: 'more:contour',
      area: 'contour',
      title: 'Contour option',
      why: 'Optional contour can add structure if needed.',
      techniqueId: null,
      ruleId: null,
      score: 0.15,
      rank: 7,
      isDefault: false,
      gating: { status: 'low_coverage', reason: 'No technique coverage yet for this area.' },
    },
  ];

  return LookReplicateResultV0Schema.parse({
    schemaVersion: 'v0',
    market: 'US',
    locale,
    exposureId,
    layer2EngineVersion: 'l2-us-0.1.0',
    layer3EngineVersion: 'l3-us-0.1.0',
    orchestratorVersion: 'orchestrator-us-0.1.0',
    breakdown: lookSpec.breakdown,
    adjustments,
    adjustmentCandidates: adjustmentCandidates.map((c, idx) => ({
      ...c,
      impressionId: deterministicId('impression', exposureId, idx + 1),
    })),
    experiment: {
      variantId: 'lr_more_v1',
      explorationEnabled: true,
      explorationRate: 0.1,
      explorationBucket: 0,
      seed: experimentSeed,
    },
    experiments: { variant: 'control_more_v1', explorationRate: 0.1 },
    steps,
    kit,
    warnings: [],
  });
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
  const argv = process.argv.slice(2);
  const onlyLayer1 = argv.includes('--layer1');
  const onlyL2L3 = argv.includes('--l2l3');
  if (onlyLayer1 && onlyL2L3) {
    throw new Error('Use at most one of: --layer1, --l2l3');
  }

  const repoRoot = path.resolve(__dirname, '..');
  const contractsDir = path.join(repoRoot, 'contracts', 'us');
  const fixturesDir = path.join(repoRoot, 'fixtures', 'contracts', 'us');

  if (!ENGINE_VERSION || typeof ENGINE_VERSION !== 'string') {
    throw new Error('ENGINE_VERSION is missing');
  }

  if (!onlyL2L3) {
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

  if (!onlyLayer1) {
    const lookSpecSchema = zodToJsonSchema(LookSpecV0Schema, { name: 'LookSpecV0', $refStrategy: 'none' });
    const lookSpecV1Schema = zodToJsonSchema(LookSpecV1Schema, { name: 'LookSpecV1', $refStrategy: 'none' });
    const stepPlanSchema = zodToJsonSchema(StepPlanV0Schema, { name: 'StepPlanV0', $refStrategy: 'none' });
    const kitPlanSchema = zodToJsonSchema(KitPlanV0Schema, { name: 'KitPlanV0', $refStrategy: 'none' });
    const lookResultSchema = zodToJsonSchema(LookReplicateResultV0Schema, { name: 'LookReplicateResultV0', $refStrategy: 'none' });

    await writeJson(path.join(contractsDir, 'lookSpecV0.schema.json'), lookSpecSchema);
    await writeJson(path.join(contractsDir, 'lookSpecV1.schema.json'), lookSpecV1Schema);
    await writeJson(path.join(contractsDir, 'stepPlanV0.schema.json'), stepPlanSchema);
    await writeJson(path.join(contractsDir, 'kitPlanV0.schema.json'), kitPlanSchema);
    await writeJson(path.join(contractsDir, 'lookReplicateResultV0.schema.json'), lookResultSchema);

    await writeJson(path.join(fixturesDir, 'lookSpecV0.sample.json'), makeLookSpecSample());
    await writeJson(path.join(fixturesDir, 'lookSpecV1.sample.json'), makeLookSpecV1Sample());
    await writeJson(path.join(fixturesDir, 'kitPlanV0.sample.json'), makeKitPlanSample({ locale: 'en' }));
    await writeJson(path.join(fixturesDir, 'lookResultV0.sample.json'), makeLookResultSample());
  }

  await writeContractManifestFromDirs({
    repoRoot,
    manifestPath: path.join(contractsDir, 'manifest.json'),
    dirs: [contractsDir, fixturesDir],
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
