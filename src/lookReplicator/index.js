const { CreateSignedUploadSchema, CreateLookJobSchema } = require('./schemas');
const { createSignedUpload } = require('./storage');
const { createJob, getJob, getShare, updateJob } = require('./store');
const { makeMockLookResult } = require('./mockResult');

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
    setTimeout(async () => {
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
  }
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
}

module.exports = {
  mountLookReplicatorRoutes,
};

