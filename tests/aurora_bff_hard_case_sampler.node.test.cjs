const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

function loadSamplerFresh() {
  const resolved = require.resolve('../src/auroraBff/hardCaseSampler');
  delete require.cache[resolved];
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require('../src/auroraBff/hardCaseSampler');
}

async function withEnv(patch, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(patch || {})) {
    prev[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function makeTempStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aurora_hard_cases_'));
  const baseDir = path.join(root, 'hard_cases');
  const imageDir = path.join(root, 'hard_case_images');
  await fs.mkdir(baseDir, { recursive: true });
  await fs.mkdir(imageDir, { recursive: true });
  return {
    root,
    baseDir,
    imageDir,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function makeReq(headers = {}) {
  const headerMap = {};
  for (const [k, v] of Object.entries(headers || {})) headerMap[String(k).toLowerCase()] = v;
  return {
    get(name) {
      return headerMap[String(name).toLowerCase()] ?? undefined;
    },
  };
}

const logger = { info() {}, warn() {}, error() {}, debug() {} };

test('Hard case triggers: uncertainty_high', async () => {
  const { evaluateHardCaseTriggers } = loadSamplerFresh();
  const out = evaluateHardCaseTriggers({
    diagnosisPolicy: { uncertainty: true, uncertainty_reasons: ['top2_close'] },
  });
  assert.equal(out.triggered, true);
  assert.ok(out.reasons.includes('uncertainty_high'));
  assert.ok(out.reasons.includes('uncertainty_top2_close'));
});

test('Hard case triggers: degraded_with_findings', async () => {
  const { evaluateHardCaseTriggers } = loadSamplerFresh();
  const out = evaluateHardCaseTriggers({
    diagnosisV1: {
      quality: { grade: 'degraded', quality_factor: 0.5, reasons: ['blur'] },
      issues: [{ issue_type: 'acne', severity_level: 2, confidence: 0.6 }],
    },
    photoQuality: { grade: 'pass', reasons: [] },
  });
  assert.equal(out.triggered, true);
  assert.ok(out.reasons.includes('degraded_with_findings'));
});

test('Hard case sampler: default stores derived-only (no image)', async () => {
  const store = await makeTempStore();
  try {
    await withEnv(
      {
        AURORA_BFF_RETENTION_DAYS: '30',
        AURORA_HARD_CASE_SAMPLER_ENABLED: 'true',
        AURORA_HARD_CASE_DIR: store.baseDir,
        AURORA_HARD_CASE_IMAGE_DIR: store.imageDir,
      },
      async () => {
        const { sampleHardCase } = loadSamplerFresh();
        const resp = await sampleHardCase({
          req: makeReq({}),
          ctx: { request_id: 'req_hc_1', trace_id: 'trace_hc_1', lang: 'EN' },
          identity: { auroraUid: 'uid_hc_1', userId: 'user_hc_1' },
          pipelineVersion: 'v2',
          shadowRun: false,
          profileSummary: { region: 'CN' },
          photoQuality: { grade: 'pass', reasons: [] },
          diagnosisPolicy: { uncertainty: true, uncertainty_reasons: ['top2_close'] },
          diagnosisV1: { quality: { grade: 'pass', quality_factor: 0.9, reasons: [] }, issues: [] },
          analysis: { features: [{ observation: 'uncertain due to blur', confidence: 'low' }] },
          analysisSource: 'rule_based',
          logger,
        });

        assert.equal(resp.ok, true);
        assert.equal(resp.sampled, true);
        assert.ok(resp.record_path);

        const record = JSON.parse(await fs.readFile(resp.record_path, { encoding: 'utf8' }));
        assert.equal(record.schema_version, 'aurora.hard_case_sample.v1');
        assert.ok(Array.isArray(record.triggers));
        assert.ok(record.triggers.includes('uncertainty_high'));
        assert.equal(record.image, undefined);

        const images = await fs.readdir(store.imageDir);
        assert.equal(images.length, 0);
      },
    );
  } finally {
    await store.cleanup();
  }
});

test('Hard case sampler: opt-in stores face_crop and supports delete', async () => {
  const store = await makeTempStore();
  try {
    await withEnv(
      {
        AURORA_BFF_RETENTION_DAYS: '30',
        AURORA_HARD_CASE_SAMPLER_ENABLED: 'true',
        AURORA_HARD_CASE_DIR: store.baseDir,
        AURORA_HARD_CASE_IMAGE_DIR: store.imageDir,
      },
      async () => {
        const { sampleHardCase, deleteHardCasesForIdentity } = loadSamplerFresh();

        const imgBuf = await sharp({
          create: { width: 420, height: 320, channels: 3, background: { r: 120, g: 160, b: 200 } },
        })
          .jpeg({ quality: 90 })
          .toBuffer();

        const resp = await sampleHardCase({
          req: makeReq({ 'X-Aurora-Opt-In-Image': 'true' }),
          ctx: { request_id: 'req_hc_2', trace_id: 'trace_hc_2', lang: 'EN' },
          identity: { auroraUid: 'uid_hc_2', userId: 'user_hc_2' },
          pipelineVersion: 'v2',
          shadowRun: false,
          profileSummary: { region: 'CN' },
          photoQuality: { grade: 'degraded', reasons: ['blur'] },
          diagnosisPolicy: { uncertainty: true, uncertainty_reasons: ['top2_close'] },
          diagnosisV1: {
            quality: { grade: 'degraded', quality_factor: 0.42, reasons: ['blur'] },
            issues: [{ issue_type: 'pores', severity_level: 1, confidence: 0.51 }],
          },
          analysis: { features: [{ observation: 'mild texture', confidence: 'medium' }] },
          analysisSource: 'vision',
          diagnosisPhotoBytes: imgBuf,
          diagnosisV1Internal: { skin_bbox_norm: { x0: 0.2, y0: 0.15, x1: 0.8, y1: 0.85 } },
          logger,
        });

        assert.equal(resp.ok, true);
        assert.equal(resp.sampled, true);

        const record = JSON.parse(await fs.readFile(resp.record_path, { encoding: 'utf8' }));
        assert.ok(record.image);
        assert.equal(record.image.kind, 'face_crop');
        assert.ok(typeof record.image.file === 'string' && record.image.file.endsWith('.jpg'));
        assert.ok(typeof record.image.expires_at === 'string' && record.image.expires_at.length > 5);

        const imgPath = path.join(store.imageDir, path.basename(record.image.file));
        const imgStat = await fs.stat(imgPath);
        assert.ok(imgStat.size > 10);

        const del = await deleteHardCasesForIdentity({ auroraUid: 'uid_hc_2', userId: null, logger });
        assert.equal(del.ok, true);
        assert.equal(del.deleted >= 1, true);

        // Record + image should be gone.
        await assert.rejects(() => fs.stat(resp.record_path));
        await assert.rejects(() => fs.stat(imgPath));
      },
    );
  } finally {
    await store.cleanup();
  }
});

test('Hard case sampler: TTL cleanup deletes expired images + marks record', async () => {
  const store = await makeTempStore();
  try {
    await withEnv(
      {
        AURORA_BFF_RETENTION_DAYS: '30',
        AURORA_HARD_CASE_SAMPLER_ENABLED: 'true',
        AURORA_HARD_CASE_DIR: store.baseDir,
        AURORA_HARD_CASE_IMAGE_DIR: store.imageDir,
      },
      async () => {
        const { cleanupExpiredImages } = loadSamplerFresh();
        const imageFile = 'expired_test.jpg';
        const imagePath = path.join(store.imageDir, imageFile);
        await fs.writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

        const recordPath = path.join(store.baseDir, 'hc_expired.json');
        const pastIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
        const record = {
          schema_version: 'aurora.hard_case_sample.v1',
          hard_case_id: 'hc_expired',
          created_at: pastIso,
          request_id_hash: 'req_x',
          identity_hash: 'id_x',
          triggers: ['geometry_sanitizer_touched'],
          quality: { qc_grade: 'pass', qc_reasons: [] },
          findings: { findings_non_empty: false },
          image: { kind: 'face_crop', file: imageFile, expires_at: pastIso },
        };
        await fs.writeFile(recordPath, JSON.stringify(record), { encoding: 'utf8' });

        const out = await cleanupExpiredImages({ logger });
        assert.equal(out.ok, true);
        assert.equal(out.deleted, 1);

        await assert.rejects(() => fs.stat(imagePath));
        const updated = JSON.parse(await fs.readFile(recordPath, { encoding: 'utf8' }));
        assert.ok(updated.image);
        assert.equal(updated.image.delete_reason, 'ttl_expired');
        assert.ok(typeof updated.image.deleted_at === 'string' && updated.image.deleted_at.length > 5);
      },
    );
  } finally {
    await store.cleanup();
  }
});

test('Hard case sampler: retention=0 disables sampling (no side effects)', async () => {
  const store = await makeTempStore();
  try {
    await withEnv(
      {
        AURORA_BFF_RETENTION_DAYS: '0',
        AURORA_HARD_CASE_SAMPLER_ENABLED: 'true',
        AURORA_HARD_CASE_DIR: store.baseDir,
        AURORA_HARD_CASE_IMAGE_DIR: store.imageDir,
      },
      async () => {
        const { sampleHardCase } = loadSamplerFresh();
        const resp = await sampleHardCase({
          req: makeReq({}),
          ctx: { request_id: 'req_hc_3', trace_id: 'trace_hc_3', lang: 'EN' },
          identity: { auroraUid: 'uid_hc_3', userId: 'user_hc_3' },
          pipelineVersion: 'v2',
          shadowRun: false,
          profileSummary: { region: 'CN' },
          photoQuality: { grade: 'pass', reasons: [] },
          diagnosisPolicy: { uncertainty: true, uncertainty_reasons: ['top2_close'] },
          diagnosisV1: { quality: { grade: 'pass', quality_factor: 0.9, reasons: [] }, issues: [] },
          analysis: { features: [{ observation: 'should not persist', confidence: 'low' }] },
          analysisSource: 'rule_based',
          logger,
        });

        assert.equal(resp.ok, false);
        assert.equal(resp.sampled, false);
        assert.equal(resp.reason, 'disabled');

        const records = await fs.readdir(store.baseDir);
        assert.equal(records.length, 0);
      },
    );
  } finally {
    await store.cleanup();
  }
});

