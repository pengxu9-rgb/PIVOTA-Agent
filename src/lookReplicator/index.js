const { CreateSignedUploadSchema, CreateLookJobSchema } = require('./schemas');
const { createSignedUpload } = require('./storage');
const { createJob, getJob, getShare, updateJob, listJobs } = require('./store');
const { makeMockLookResult } = require('./mockResult');
const { JobQueue } = require('./jobQueue');
const { parseMultipart, rmrf } = require('./multipart');
const { runLookReplicatePipeline, parseOptionalJsonField, normalizeLocale, normalizePreferenceMode } = require('./lookReplicatePipeline');
const { randomUUID } = require('crypto');
const { upsertOutcomeSampleFromJobCompletion, getOutcomeSample } = require('../telemetry/outcomeStore');
const { normalizeMarket, parseMarketFromRequest, requireMarketEnabled } = require('../markets/market');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { loadTechniqueKB } = require('../layer2/kb/loadTechniqueKB');
const { renderSkeletonFromKB } = require('../layer2/personalization/renderSkeletonFromKB');

const DEFAULT_JOB_CONCURRENCY = Number(process.env.LOOK_REPLICATOR_JOB_CONCURRENCY || 2);
const queue = new JobQueue({ concurrency: DEFAULT_JOB_CONCURRENCY });

function parseBearer(authHeader) {
  const raw = String(authHeader || '');
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function requireLookReplicatorAuth(req, res) {
  const required = process.env.LOOK_REPLICATOR_API_KEY || process.env.LOOK_REPLICATOR_BACKEND_API_KEY;
  if (!required) return true;
  const token = parseBearer(req.header('Authorization')) || req.header('X-API-Key') || req.header('x-api-key');
  if (!token || token !== required) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return false;
  }
  return true;
}

function scheduleMockProgress({ jobId, market, locale, logger }) {
  const stages = [
    { progress: 25, status: 'processing', delay: 800 },
    { progress: 50, status: 'processing', delay: 800 },
    { progress: 75, status: 'processing', delay: 800 },
    { progress: 100, status: 'completed', delay: 500 },
  ];

  let total = 0;
  for (const s of stages) {
    total += s.delay;
    const timer = setTimeout(async () => {
      try {
        if (s.status === 'completed') {
          const result = makeMockLookResult({ shareId: jobId, market, locale });
          await updateJob(jobId, { status: s.status, progress: s.progress, result });
        } else {
          await updateJob(jobId, { status: s.status, progress: s.progress });
        }
      } catch (err) {
        logger?.warn({ jobId, err: err?.message || String(err) }, 'lookReplicator job update failed');
      }
    }, total);
    // Avoid keeping the Node process alive in tests (Supertest runs without app.listen()).
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
}

function mapStatus(jobStatus) {
  const s = String(jobStatus || '').toLowerCase();
  if (s === 'pending') return 'queued';
  if (s === 'processing') return 'processing';
  if (s === 'completed') return 'done';
  if (s === 'failed' || s === 'error') return 'error';
  return 'queued';
}

function progressStepFrom(progress, status) {
  const st = mapStatus(status);
  if (st === 'done') return 'done';
  if (st === 'error') return 'error';
  const p = Number(progress || 0);
  if (p < 15) return 'queued';
  if (p < 35) return 'lookspec';
  if (p < 55) return 'adjustments';
  if (p < 75) return 'steps';
  if (p < 95) return 'kit';
  return 'finalizing';
}

function parseBool(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return false;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function clampInt(v, { min, max, fallback }) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function assetRootDir() {
  return path.join(os.tmpdir(), 'pivota-lookreplicator-assets');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function extFromContentType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('image/jpeg') || ct.includes('image/jpg')) return 'jpg';
  if (ct.includes('image/png')) return 'png';
  if (ct.includes('image/webp')) return 'webp';
  return 'bin';
}

function contentTypeFromExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'png') return 'image/png';
  if (e === 'webp') return 'image/webp';
  return 'application/octet-stream';
}

function copyUploadToAssets({ jobId, kind, file }) {
  if (!file?.path) return null;
  const safeKind = kind === 'selfie' ? 'selfie' : 'reference';
  const ext = extFromContentType(file.contentType);
  const dir = path.join(assetRootDir(), jobId);
  ensureDir(dir);
  const outPath = path.join(dir, `${safeKind}.${ext}`);
  fs.copyFileSync(file.path, outPath);
  return `/api/look-replicate/assets/${encodeURIComponent(jobId)}/${safeKind}`;
}

function findAssetFilePath({ jobId, kind }) {
  const dir = path.join(assetRootDir(), String(jobId || ''));
  const safeKind = kind === 'selfie' ? 'selfie' : 'reference';
  const candidates = ['jpg', 'png', 'webp', 'bin'].map((ext) => path.join(dir, `${safeKind}.${ext}`));
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function parseLocaleFromQuery(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  return normalizeLocale(s);
}

function localizeSkeletonsForLocale({ rawSkeletons, market, locale }) {
  if (!Array.isArray(rawSkeletons) || rawSkeletons.length === 0) return null;
  const kb = loadTechniqueKB(market);

  const safe = rawSkeletons.map((s) => {
    const doActionIds = Array.isArray(s?.doActionIds) ? s.doActionIds : [];
    const selectedDoActionIds = Array.isArray(s?.selectedDoActionIds)
      ? s.selectedDoActionIds
      : Array.isArray(s?.techniqueRefs)
        ? s.techniqueRefs.map((r) => r?.id).filter(Boolean)
        : [];
    const effectiveIds = selectedDoActionIds.length ? selectedDoActionIds : doActionIds;

    return {
      ...s,
      ...(effectiveIds.length ? { doActionIds: effectiveIds } : {}),
      doActions: [],
      techniqueRefs: undefined,
      techniqueCards: undefined,
    };
  });

  const rendered = renderSkeletonFromKB(safe, kb, { market, locale });
  return Array.isArray(rendered?.allSkeletons) ? rendered.allSkeletons : rendered.skeletons;
}

function mountLookReplicatorRoutes(app, { logger }) {
  const MAX_UPLOAD_BYTES = Number(process.env.LOOK_REPLICATOR_MAX_UPLOAD_BYTES || 25 * 1024 * 1024);
  const allowedContentTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

  app.post('/uploads/signed-url', async (req, res) => {
    if (!requireLookReplicatorAuth(req, res)) return;

    const parsed = CreateSignedUploadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.format() });
    }

    const { kind, contentType, sizeBytes } = parsed.data;
    if (sizeBytes > MAX_UPLOAD_BYTES) {
      return res.status(400).json({ error: 'UPLOAD_TOO_LARGE' });
    }
    if (!allowedContentTypes.has(String(contentType || '').toLowerCase())) {
      return res.status(400).json({ error: 'UNSUPPORTED_CONTENT_TYPE' });
    }

    try {
      const signed = await createSignedUpload({ kind, contentType });
      return res.json(signed);
    } catch (err) {
      const code = err?.code === 'CONFIG_MISSING' ? 501 : 500;
      return res.status(code).json({ error: 'SIGNED_URL_ERROR', message: err?.message || 'Failed to sign upload' });
    }
  });

  app.post('/look-jobs', async (req, res) => {
    if (!requireLookReplicatorAuth(req, res)) return;

    const parsed = CreateLookJobSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.format() });
    }

    const market = parsed.data.market || 'NA';
    const locale = parsed.data.locale || 'en';

    try {
      const job = await createJob({
        market,
        locale,
        referenceImageUrl: parsed.data.referenceImageUrl,
        selfieImageUrl: parsed.data.selfieImageUrl,
        undertone: parsed.data.undertone,
      });

      scheduleMockProgress({ jobId: job.jobId, market, locale, logger });
      return res.json({ jobId: job.jobId });
    } catch (err) {
      logger?.error({ err: err?.message || String(err) }, 'lookReplicator create job failed');
      return res.status(500).json({ error: 'JOB_CREATE_FAILED' });
    }
  });

  app.get('/look-jobs/:jobId', async (req, res) => {
    if (!requireLookReplicatorAuth(req, res)) return;

    const jobId = req.params.jobId;
    try {
      const job = await getJob(jobId);
      if (!job) return res.status(404).json({ error: 'NOT_FOUND' });

      return res.json({
        jobId: job.jobId,
        status: job.status,
        progress: job.progress,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        referenceImageUrl: job.referenceImageUrl,
        result: job.result,
        error: job.error,
      });
    } catch (err) {
      return res.status(500).json({ error: 'JOB_GET_FAILED' });
    }
  });

  app.get('/shares/:shareId', async (req, res) => {
    if (!requireLookReplicatorAuth(req, res)) return;

    const shareId = req.params.shareId;
    try {
      const job = await getShare(shareId);
      if (!job || !job.result) return res.status(404).json({ error: 'NOT_FOUND' });
      return res.json({
        shareId,
        jobId: job.jobId,
        result: job.result,
        referenceImageUrl: job.referenceImageUrl || '',
        canonicalUrl: null,
        createdAt: job.createdAt,
        expiresAt: null,
      });
    } catch (err) {
      return res.status(500).json({ error: 'SHARE_GET_FAILED' });
    }
  });

  // --- Look Replicator Orchestration (US-only) ---

  app.get('/api/look-replicate/assets/:jobId/:kind', async (req, res) => {
    if (!requireLookReplicatorAuth(req, res)) return;
    res.set('Cache-Control', 'no-store');

    const jobId = String(req.params.jobId || '').trim();
    const kind = String(req.params.kind || '').trim().toLowerCase();
    if (!jobId) return res.status(400).json({ error: 'INVALID_REQUEST' });
    if (kind !== 'reference' && kind !== 'selfie') return res.status(404).json({ error: 'NOT_FOUND' });

    const p = findAssetFilePath({ jobId, kind });
    if (!p) return res.status(404).json({ error: 'NOT_FOUND' });

    const ext = String(path.extname(p).slice(1) || '').toLowerCase();
    res.set('Content-Type', contentTypeFromExt(ext));
    return fs.createReadStream(p).pipe(res);
  });

  app.post('/api/look-replicate/jobs', async (req, res) => {
    if (!requireLookReplicatorAuth(req, res)) return;

    let parsed;
    try {
      parsed = await parseMultipart(req, { maxBytes: MAX_UPLOAD_BYTES, allowedContentTypes });
    } catch (err) {
      return res.status(err?.statusCode || 400).json({ error: err?.code || 'INVALID_MULTIPART', message: err?.message });
    }

    const { fields, files, tmpDir } = parsed;
    const referenceImage = files.referenceImage;
    const selfieImage = files.selfieImage;

    if (!referenceImage) {
      rmrf(tmpDir);
      return res.status(400).json({ error: 'MISSING_REFERENCE_IMAGE' });
    }

    const defaultMarket = normalizeMarket(process.env.DEFAULT_MARKET, 'US');
    let market;
    try {
      market = parseMarketFromRequest(fields.market, defaultMarket);
    } catch (err) {
      rmrf(tmpDir);
      return res.status(Number(err?.httpStatus) || 400).json({ error: err?.code || 'MARKET_NOT_SUPPORTED', message: err?.message });
    }
    try {
      requireMarketEnabled(market);
    } catch (err) {
      rmrf(tmpDir);
      return res
        .status(Number(err?.httpStatus) || 403)
        .json({ error: err?.code || 'MARKET_DISABLED', message: err?.message || 'Market disabled' });
    }

    const locale = normalizeLocale(fields.locale);
    const preferenceMode = normalizePreferenceMode(fields.preferenceMode);
    const optInTraining = parseBool(fields.optInTraining);
    const enableExtendedAreas = parseBool(fields.enableExtendedAreas);
    const enableSelfieLookSpec = parseBool(fields.enableSelfieLookSpec);
    const userId = fields.userId ? String(fields.userId).trim() : null;

    let layer1Bundle = null;
    try {
      layer1Bundle = fields.layer1Bundle ? parseOptionalJsonField(fields.layer1Bundle) : null;
    } catch (err) {
      rmrf(tmpDir);
      return res.status(400).json({ error: 'INVALID_LAYER1_BUNDLE_JSON' });
    }

    try {
      const job = await createJob({
        market,
        locale,
        referenceImageUrl: null,
        selfieImageUrl: null,
        undertone: undefined,
      });

      const referenceUrl = copyUploadToAssets({ jobId: job.jobId, kind: 'reference', file: referenceImage });
      const selfieUrl = selfieImage?.path ? copyUploadToAssets({ jobId: job.jobId, kind: 'selfie', file: selfieImage }) : null;
      if (referenceUrl || selfieUrl) {
        try {
          await updateJob(job.jobId, {
            ...(referenceUrl ? { referenceImageUrl: referenceUrl } : {}),
            ...(selfieUrl ? { selfieImageUrl: selfieUrl } : {}),
          });
        } catch (err) {
          logger?.warn?.({ jobId: job.jobId, err: err?.message || String(err) }, 'lookReplicate asset url persist failed');
        }
      }

      res.json({ jobId: job.jobId });

      queue.enqueue(async () => {
        const jobId = job.jobId;
        const log = logger || console;
        try {
          await updateJob(jobId, { status: 'processing', progress: 10 });
          let onboardingProfileV0 = null;
          try {
            onboardingProfileV0 = fields.onboardingProfileV0 ? parseOptionalJsonField(fields.onboardingProfileV0) : null;
          } catch (err) {
            // ignore invalid onboarding JSON to avoid blocking the core flow
            onboardingProfileV0 = null;
          }
          const { result, telemetrySample } = await runLookReplicatePipeline({
            jobId,
            market,
            locale,
            preferenceMode,
            optInTraining,
            referenceImage,
            selfieImage,
            layer1Bundle,
            enableExtendedAreas,
            enableSelfieLookSpec,
            userId: userId || undefined,
            onboardingProfileV0: onboardingProfileV0 || undefined,
            onProgress: async ({ progress }) => {
              await updateJob(jobId, { progress: Number(progress) || 0 });
            },
          });

          if (telemetrySample) {
            try {
              await upsertOutcomeSampleFromJobCompletion(telemetrySample);
            } catch (err) {
              log?.warn?.({ jobId, err: err?.message || String(err) }, 'outcome sample upsert failed');
            }
          }

          await updateJob(jobId, { status: 'completed', progress: 100, result });
        } catch (err) {
          const msg = err?.message ? String(err.message) : 'LOOK_REPLICATE_FAILED';
          log?.warn?.({ jobId, err: msg }, 'lookReplicate pipeline failed');
          await updateJob(jobId, { status: 'failed', progress: 100, error: msg });
        } finally {
          rmrf(tmpDir);
        }
      });
    } catch (err) {
      rmrf(tmpDir);
      logger?.error({ err: err?.message || String(err) }, 'lookReplicate create job failed');
      return res.status(500).json({ error: 'JOB_CREATE_FAILED' });
    }
  });

  app.get('/api/look-replicate/jobs/:jobId', async (req, res) => {
    if (!requireLookReplicatorAuth(req, res)) return;
    res.set('Cache-Control', 'no-store');
    try {
      const job = await getJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'NOT_FOUND' });

      const status = mapStatus(job.status);
      const progressStep = progressStepFrom(job.progress, job.status);
      const requestLocale = parseLocaleFromQuery(req.query.locale) || job.locale || 'en';
      const payload = {
        jobId: job.jobId,
        status,
        progressStep,
        progress: job.progress,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        referenceImageUrl: job.referenceImageUrl || null,
        selfieImageUrl: job.selfieImageUrl || null,
      };

      if (status === 'done' && job.result) payload.result = job.result;
      if (status === 'error' && job.error) payload.error = job.error;

      if (status === 'done') {
        try {
          const outcome = await getOutcomeSample({ market: job.market, jobId: job.jobId });
          const rawSkeletons = outcome?.replayContext?.adjustmentSkeletons;
          const localized = localizeSkeletonsForLocale({ rawSkeletons, market: job.market, locale: requestLocale });
          if (localized) payload.replayContext = { adjustmentSkeletons: localized };

          const lookDiff = outcome?.gemini && typeof outcome.gemini === 'object' ? outcome.gemini.lookDiff : null;
          const lookDiffSource = outcome?.gemini && typeof outcome.gemini === 'object' ? outcome.gemini.lookDiffSource : null;
          if (lookDiff) payload.diagnostics = { lookDiff, lookDiffSource: lookDiffSource || null };
        } catch (err) {
          logger?.warn?.({ jobId: job.jobId, err: err?.message || String(err) }, 'lookReplicate outcome attach failed');
        }
      }

      return res.json(payload);
    } catch (err) {
      logger?.warn?.(
        { jobId: req.params.jobId, code: err?.code, err: err?.message || String(err) },
        'lookReplicate job get failed'
      );
      return res.status(500).json({ error: 'JOB_GET_FAILED' });
    }
  });

  async function handleHistory(req, res) {
    if (!requireLookReplicatorAuth(req, res)) return;
    res.set('Cache-Control', 'no-store');

    const limit = clampInt(req.query.limit, { min: 1, max: 50, fallback: 20 });
    const before = req.query.before ? String(req.query.before) : null;
    const market = req.query.market ? String(req.query.market) : null;
    const locale = req.query.locale ? String(req.query.locale) : null;

    try {
      const jobs = await listJobs({ limit, before, market, locale });
      const items = jobs.map((j) => {
        const status = mapStatus(j.status);
        const progressStep = progressStepFrom(j.progress, j.status);

        const warningsCount = Array.isArray(j.result?.warnings) ? j.result.warnings.length : 0;
        const stepsCount = Array.isArray(j.result?.steps) ? j.result.steps.length : null;

        return {
          jobId: j.jobId,
          shareId: j.shareId || j.jobId,
          market: j.market,
          locale: j.locale,
          status,
          progressStep,
          progress: j.progress,
          createdAt: j.createdAt,
          updatedAt: j.updatedAt,
          hasResult: Boolean(j.result),
          summary: j.result ? { stepsCount, warningsCount } : null,
        };
      });

      const nextCursor = items.length === limit ? items[items.length - 1]?.createdAt : null;
      return res.json({ items, nextCursor });
    } catch (err) {
      logger?.warn?.({ err: err?.message || String(err) }, 'lookReplicate history get failed');
      return res.status(500).json({ error: 'HISTORY_GET_FAILED' });
    }
  }

  // History (two paths for compatibility; same handler)
  app.get('/api/look-replicate/history', handleHistory);
  app.get('/api/lookreplicate/history', handleHistory);

  app.post('/api/look-replicate/shares', async (req, res) => {
    if (!requireLookReplicatorAuth(req, res)) return;
    const jobId = String(req.body?.jobId || '').trim();
    if (!jobId) return res.status(400).json({ error: 'INVALID_REQUEST' });

    try {
      const job = await getJob(jobId);
      if (!job || !job.result) return res.status(404).json({ error: 'NOT_FOUND' });

      const shareId = randomUUID();
      const share = { shareId };
      const updatedResult = { ...job.result, share };

      await updateJob(jobId, { shareId, result: updatedResult });
      return res.json({ shareId });
    } catch (err) {
      return res.status(500).json({ error: 'SHARE_CREATE_FAILED' });
    }
  });

  app.get('/api/look-replicate/shares/:shareId', async (req, res) => {
    if (!requireLookReplicatorAuth(req, res)) return;
    res.set('Cache-Control', 'no-store');
    const shareId = req.params.shareId;
    try {
      const job = await getShare(shareId);
      if (!job || !job.result) return res.status(404).json({ error: 'NOT_FOUND' });
      return res.json({
        shareId,
        jobId: job.jobId,
        result: job.result,
        referenceImageUrl: job.referenceImageUrl || '',
        canonicalUrl: job.result?.share?.canonicalUrl ?? null,
        createdAt: job.createdAt,
        expiresAt: null,
      });
    } catch (err) {
      return res.status(500).json({ error: 'SHARE_GET_FAILED' });
    }
  });
}

module.exports = {
  mountLookReplicatorRoutes,
};
