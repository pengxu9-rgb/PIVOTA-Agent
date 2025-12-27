const { CreateSignedUploadSchema, CreateLookJobSchema } = require('./schemas');
const { createSignedUpload } = require('./storage');
const { createJob, getJob, getShare, updateJob } = require('./store');
const { makeMockLookResult } = require('./mockResult');
const { JobQueue } = require('./jobQueue');
const { parseMultipart, rmrf } = require('./multipart');
const { runLookReplicatePipeline, parseOptionalJsonField, normalizeLocale, normalizePreferenceMode } = require('./lookReplicatePipeline');
const { randomUUID } = require('crypto');
const { upsertOutcomeSampleFromJobCompletion } = require('../telemetry/outcomeStore');
const { normalizeMarket, parseMarketFromRequest, requireMarketEnabled } = require('../markets/market');

const DEFAULT_JOB_CONCURRENCY = Number(process.env.LOOK_REPLICATOR_JOB_CONCURRENCY || 2);
const queue = new JobQueue({ concurrency: DEFAULT_JOB_CONCURRENCY });

function parseBearer(authHeader) {
  const raw = String(authHeader || '');
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function requireLookReplicatorAuth(req, res) {
  const required = process.env.LOOK_REPLICATOR_API_KEY;
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

      res.json({ jobId: job.jobId });

      queue.enqueue(async () => {
        const jobId = job.jobId;
        const log = logger || console;
        try {
          await updateJob(jobId, { status: 'processing', progress: 10 });
          const { result, telemetrySample } = await runLookReplicatePipeline({
            jobId,
            market,
            locale,
            preferenceMode,
            optInTraining,
            referenceImage,
            selfieImage,
            layer1Bundle,
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
    try {
      const job = await getJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'NOT_FOUND' });

      const status = mapStatus(job.status);
      const progressStep = progressStepFrom(job.progress, job.status);
      const payload = {
        jobId: job.jobId,
        status,
        progressStep,
        progress: job.progress,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      };

      if (status === 'done' && job.result) payload.result = job.result;
      if (status === 'error' && job.error) payload.error = job.error;

      return res.json(payload);
    } catch (err) {
      logger?.warn?.(
        { jobId: req.params.jobId, code: err?.code, err: err?.message || String(err) },
        'lookReplicate job get failed'
      );
      return res.status(500).json({ error: 'JOB_GET_FAILED' });
    }
  });

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
