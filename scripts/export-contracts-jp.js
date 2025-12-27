/* eslint-disable no-console */
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

const { zodToJsonSchema } = require('zod-to-json-schema');

const { LookSpecV0Schema } = require('../src/layer2/schemas/lookSpecV0');
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

function makeLookSpecSampleJP() {
  const locale = 'ja';
  return LookSpecV0Schema.parse({
    schemaVersion: 'v0',
    market: 'JP',
    locale,
    layer2EngineVersion: 'l2-jp-0.1.0',
    layer3EngineVersion: 'l3-jp-0.1.0',
    orchestratorVersion: 'orchestrator-jp-0.1.0',
    lookTitle: 'ナチュラルツヤ',
    styleTags: ['jp_clear_soft', 'jp_natural'],
    breakdown: {
      base: {
        intent: '素肌っぽく整える',
        finish: 'ナチュラル',
        coverage: '薄め',
        keyNotes: ['薄づき', '自然なツヤ', '厚塗りしない'],
        evidence: ['contract.fixture'],
      },
      eye: {
        intent: '目元を自然に引き立てる',
        finish: 'ソフト',
        coverage: '薄め',
        keyNotes: ['細めライン', '軽い陰影', '抜け感'],
        evidence: ['contract.fixture'],
      },
      lip: {
        intent: 'うるおい感のある色味',
        finish: 'ツヤ',
        coverage: '薄め',
        keyNotes: ['透け感', '中央にツヤ', '輪郭は柔らかく'],
        evidence: ['contract.fixture'],
      },
    },
    warnings: [],
  });
}

function makeStepPlanSamplesJP(locale) {
  const base = {
    schemaVersion: 'v0',
    market: 'JP',
    locale,
    layer2EngineVersion: 'l2-jp-0.1.0',
    layer3EngineVersion: 'l3-jp-0.1.0',
    orchestratorVersion: 'orchestrator-jp-0.1.0',
  };

  const steps = [
    {
      stepId: 'l2_step_0',
      order: 0,
      impactArea: 'base',
      title: 'ベース準備',
      instruction: '保湿して、必要なら下地を薄く仕込む。',
      tips: ['スキンケアがなじんでから次へ。'],
      cautions: [],
      fitConditions: [],
      evidence: ['lookSpec.breakdown.base.intent'],
    },
    {
      stepId: 'l2_step_1',
      order: 1,
      impactArea: 'base',
      title: '薄くのせる',
      instruction: '薄づきで均一に伸ばす。必要な部分だけ重ねる。',
      tips: ['一度に厚くしない。'],
      cautions: ['厚塗りで質感が消えないように。'],
      fitConditions: [],
      evidence: ['lookSpec.breakdown.base.coverage'],
    },
    {
      stepId: 'l2_step_2',
      order: 2,
      impactArea: 'base',
      title: 'ポイント補正',
      instruction: '気になる部分だけをスポットで補正して境目をぼかす。',
      tips: [],
      cautions: [],
      fitConditions: [],
      evidence: ['lookSpec.breakdown.base.keyNotes[0]'],
    },
    {
      stepId: 'l2_step_3',
      order: 3,
      impactArea: 'eye',
      title: '眉を整える',
      instruction: '毛流れを整えて、足りない部分だけを軽く足す。',
      tips: ['短いストロークで自然に。'],
      cautions: [],
      fitConditions: [],
      evidence: ['lookSpec.breakdown.eye.keyNotes[2]'],
    },
    {
      stepId: 'l2_step_4',
      order: 4,
      impactArea: 'eye',
      title: 'ラインは細く',
      instruction: '目尻寄りから細く入れ、強くしすぎない。',
      tips: ['まつ毛の隙間を埋める意識で。'],
      cautions: ['太くすると印象が強くなりすぎる。'],
      fitConditions: [],
      evidence: ['lookSpec.breakdown.eye.finish'],
    },
    {
      stepId: 'l2_step_5',
      order: 5,
      impactArea: 'eye',
      title: '軽いマスカラ',
      instruction: 'ダマにならない程度に、軽くまつ毛を強調する。',
      tips: ['根元から軽く左右に揺らす。'],
      cautions: [],
      fitConditions: [],
      evidence: ['lookSpec.breakdown.eye.keyNotes[0]'],
    },
    {
      stepId: 'l2_step_6',
      order: 6,
      impactArea: 'lip',
      title: 'リップ下準備',
      instruction: '薄く保湿してから、余分な油分をティッシュオフ。',
      tips: [],
      cautions: [],
      fitConditions: [],
      evidence: ['lookSpec.breakdown.lip.finish'],
    },
    {
      stepId: 'l2_step_7',
      order: 7,
      impactArea: 'lip',
      title: '透け感の色味',
      instruction: '中央にツヤを残しつつ、薄く色をのせる。',
      tips: ['指でなじませると柔らかい。'],
      cautions: ['濃くしすぎない。'],
      fitConditions: [],
      evidence: ['lookSpec.breakdown.lip.coverage'],
    },
  ];

  return steps.map((s) => StepPlanV0Schema.parse({ ...base, ...s }));
}

function makeProductAttributesSampleJP({ locale, category, seed, counter, priceTier }) {
  return {
    schemaVersion: 'v0',
    market: 'JP',
    locale,
    layer2EngineVersion: 'l2-jp-0.1.0',
    layer3EngineVersion: 'l3-jp-0.1.0',
    orchestratorVersion: 'orchestrator-jp-0.1.0',
    category,
    skuId: deterministicId('role', seed, counter),
    name: `${category.toUpperCase()} 役割サンプル ${counter}`,
    brand: 'Chydan',
    price: { currency: 'JPY', amount: 1500 + counter * 100 },
    priceTier,
    imageUrl: 'https://example.com/product.png',
    availability: 'unknown',
    availabilityByMarket: { JP: 'unknown' },
    tags: { finish: ['natural'], texture: ['cream'], coverage: ['light'], effect: [] },
    undertoneFit: 'unknown',
    shadeDescriptor: 'neutral',
    whyThis: `JPサンプル（購入不可・役割ベース）: ${category} (${priceTier}).`,
    evidence: ['contract.fixture'],
    purchaseEnabled: false,
  };
}

function makeKitPlanSampleJP({ locale }) {
  const seed = 'contract.jp.kitPlanV0.v0';
  return KitPlanV0Schema.parse({
    schemaVersion: 'v0',
    market: 'JP',
    locale,
    layer2EngineVersion: 'l2-jp-0.1.0',
    layer3EngineVersion: 'l3-jp-0.1.0',
    orchestratorVersion: 'orchestrator-jp-0.1.0',
    kit: {
      base: {
        best: makeProductAttributesSampleJP({ locale, category: 'base', seed, counter: 1, priceTier: 'mid' }),
        dupe: makeProductAttributesSampleJP({ locale, category: 'base', seed, counter: 2, priceTier: 'budget' }),
      },
      eye: {
        best: makeProductAttributesSampleJP({ locale, category: 'eye', seed, counter: 3, priceTier: 'mid' }),
        dupe: makeProductAttributesSampleJP({ locale, category: 'eye', seed, counter: 4, priceTier: 'budget' }),
      },
      lip: {
        best: makeProductAttributesSampleJP({ locale, category: 'lip', seed, counter: 5, priceTier: 'mid' }),
        dupe: makeProductAttributesSampleJP({ locale, category: 'lip', seed, counter: 6, priceTier: 'budget' }),
      },
    },
    warnings: ['COMMERCE_DISABLED:JP'],
  });
}

function makeLookResultSampleJP() {
  const lookSpec = makeLookSpecSampleJP();
  const locale = lookSpec.locale;
  const steps = makeStepPlanSamplesJP(locale);
  const kit = makeKitPlanSampleJP({ locale });

  const adjustments = [
    {
      impactArea: 'base',
      title: '薄く仕上げる',
      because: '質感を残しながら整えるため。',
      do: '薄く重ねて、必要な部分だけをスポット補正する。',
      why: '薄い層は自然な質感を保ちやすい。',
      evidence: ['lookSpec.breakdown.base.coverage'],
      confidence: 'medium',
    },
    {
      impactArea: 'eye',
      title: '目尻から細く',
      because: '強すぎない印象にするため。',
      do: '目尻寄りから細くラインを入れて、角度は水平寄りに整える。',
      why: '太さと角度を抑えると、やわらかい印象になりやすい。',
      evidence: ['lookSpec.breakdown.eye.finish'],
      confidence: 'low',
    },
    {
      impactArea: 'lip',
      title: '中心にツヤ',
      because: '透け感と立体感を出すため。',
      do: '中央にツヤを残して薄く色をのせ、輪郭はぼかす。',
      why: '中心のツヤは自然な立体感を作りやすい。',
      evidence: ['lookSpec.breakdown.lip.finish'],
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
      title: '下地の提案',
      why: 'ベースの密着感を上げたいときの追加オプション。',
      techniqueId: null,
      ruleId: null,
      score: 0.15,
      rank: 4,
      isDefault: false,
      gating: { status: 'low_coverage', reason: 'この領域のテクニックがまだ不足しています。' },
    },
    {
      id: 'more:brow',
      area: 'brow',
      title: '眉の提案',
      why: '眉の形を整えると全体のバランスが変わります。',
      techniqueId: null,
      ruleId: null,
      score: 0.15,
      rank: 5,
      isDefault: false,
      gating: { status: 'low_coverage', reason: 'この領域のテクニックがまだ不足しています。' },
    },
    {
      id: 'more:blush',
      area: 'blush',
      title: 'チークの提案',
      why: 'チークの位置で雰囲気を調整できます。',
      techniqueId: null,
      ruleId: null,
      score: 0.15,
      rank: 6,
      isDefault: false,
      gating: { status: 'low_coverage', reason: 'この領域のテクニックがまだ不足しています。' },
    },
    {
      id: 'more:contour',
      area: 'contour',
      title: 'シェーディングの提案',
      why: '必要に応じて立体感を足す追加オプション。',
      techniqueId: null,
      ruleId: null,
      score: 0.15,
      rank: 7,
      isDefault: false,
      gating: { status: 'low_coverage', reason: 'この領域のテクニックがまだ不足しています。' },
    },
  ];

  return LookReplicateResultV0Schema.parse({
    schemaVersion: 'v0',
    market: 'JP',
    locale,
    layer2EngineVersion: 'l2-jp-0.1.0',
    layer3EngineVersion: 'l3-jp-0.1.0',
    orchestratorVersion: 'orchestrator-jp-0.1.0',
    commerceEnabled: false,
    breakdown: lookSpec.breakdown,
    adjustments,
    adjustmentCandidates,
    experiments: { variant: 'control_more_v0', explorationRate: 0.1 },
    steps,
    kit,
    warnings: ['COMMERCE_DISABLED:JP'],
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--layer1')) {
    throw new Error('JP export currently supports Layer2/3 only; do not pass --layer1.');
  }

  const repoRoot = path.resolve(__dirname, '..');
  const contractsDir = path.join(repoRoot, 'contracts', 'jp');
  const fixturesDir = path.join(repoRoot, 'fixtures', 'contracts', 'jp');

  const lookSpecSchema = zodToJsonSchema(LookSpecV0Schema, { name: 'LookSpecV0', $refStrategy: 'none' });
  const stepPlanSchema = zodToJsonSchema(StepPlanV0Schema, { name: 'StepPlanV0', $refStrategy: 'none' });
  const kitPlanSchema = zodToJsonSchema(KitPlanV0Schema, { name: 'KitPlanV0', $refStrategy: 'none' });
  const lookResultSchema = zodToJsonSchema(LookReplicateResultV0Schema, { name: 'LookReplicateResultV0', $refStrategy: 'none' });

  await writeJson(path.join(contractsDir, 'lookSpecV0.schema.json'), lookSpecSchema);
  await writeJson(path.join(contractsDir, 'stepPlanV0.schema.json'), stepPlanSchema);
  await writeJson(path.join(contractsDir, 'kitPlanV0.schema.json'), kitPlanSchema);
  await writeJson(path.join(contractsDir, 'lookReplicateResultV0.schema.json'), lookResultSchema);

  await writeJson(path.join(fixturesDir, 'lookSpecV0.sample.json'), makeLookSpecSampleJP());
  await writeJson(path.join(fixturesDir, 'kitPlanV0.sample.json'), makeKitPlanSampleJP({ locale: 'ja' }));
  await writeJson(path.join(fixturesDir, 'lookResultV0.sample.json'), makeLookResultSampleJP());

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
