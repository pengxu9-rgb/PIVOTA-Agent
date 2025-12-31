const { CreateSignedUploadSchema, CreateLookJobSchema } = require('./schemas');
const { createSignedUpload, uploadPublicAsset } = require('./storage');
const { createJob, getJob, getShare, updateJob, listJobs } = require('./store');
const { makeMockLookResult } = require('./mockResult');
const { JobQueue } = require('./jobQueue');
const { parseMultipart, rmrf } = require('./multipart');
const { runLookReplicatePipeline, parseOptionalJsonField, normalizeLocale, normalizePreferenceMode } = require('./lookReplicatePipeline');
const { runTryOnReplicateOneClickGemini } = require("./tryOnReplicateOneClickGemini");
const { runTryOnGenerateImageGemini } = require("./tryOnGenerateImageGemini");
const { runTryOnReplicateOneClickOpenAICompat } = require("./tryOnReplicateOneClickOpenAICompat");
const { runTryOnGenerateImageOpenAICompat } = require("./tryOnGenerateImageOpenAICompat");
const { randomUUID } = require('crypto');
const axios = require('axios');
const { upsertOutcomeSampleFromJobCompletion, getOutcomeSample } = require('../telemetry/outcomeStore');
const { normalizeMarket, parseMarketFromRequest, requireMarketEnabled } = require('../markets/market');
const { InvokeRequestSchema } = require('../schema');
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

function isHttpUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isPrivateNetworkHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
  const m172 = host.match(/^172\.(\d+)\.\d+\.\d+$/);
  if (m172) {
    const n = Number(m172[1]);
    if (n >= 16 && n <= 31) return true;
  }
  if (/^169\.254\.\d+\.\d+$/.test(host)) return true;
  return false;
}

function allowlistedAssetUrl(url) {
  if (!isHttpUrl(url)) return null;
  const raw = String(url);
  const base = process.env.LOOK_REPLICATOR_PUBLIC_ASSET_BASE_URL;
  if (base) {
    const trimmed = String(base).replace(/\/+$/, '');
    if (raw.startsWith(`${trimmed}/`) || raw === trimmed) return raw;
    return null;
  }
  // Fail-closed-ish: without an explicit allowlist, block private network targets.
  try {
    const u = new URL(raw);
    if (isPrivateNetworkHost(u.hostname)) return null;
    return raw;
  } catch {
    return null;
  }
}

async function proxyImageFromUrlToRes(url, res, { maxBytes }) {
  const safeUrl = allowlistedAssetUrl(url);
  if (!safeUrl) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }

  const upstream = await axios.get(safeUrl, {
    responseType: 'stream',
    timeout: 15000,
    maxRedirects: 3,
    validateStatus: () => true,
  });

  if (upstream.status < 200 || upstream.status >= 300) {
    res.status(404).json({ error: 'NOT_FOUND' });
    upstream.data?.destroy?.();
    return;
  }

  const contentType = upstream.headers?.['content-type'];
  if (contentType) res.set('Content-Type', String(contentType));
  const contentLength = upstream.headers?.['content-length'];
  if (contentLength && Number(contentLength) > maxBytes) {
    res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
    upstream.data?.destroy?.();
    return;
  }

  let total = 0;
  upstream.data.on('data', (chunk) => {
    total += chunk?.length || 0;
    if (total > maxBytes) {
      upstream.data.destroy(new Error('PAYLOAD_TOO_LARGE'));
    }
  });
  upstream.data.on('error', () => {
    if (!res.headersSent) res.status(502).json({ error: 'UPSTREAM_ERROR' });
    else res.end();
  });
  upstream.data.pipe(res);
}

async function downloadImageFromUrlToTmpFile(url, { tmpDir, prefix, maxBytes }) {
  const safeUrl = allowlistedAssetUrl(url);
  if (!safeUrl) return null;

  const upstream = await axios.get(safeUrl, {
    responseType: 'stream',
    timeout: 15000,
    maxRedirects: 3,
    validateStatus: () => true,
  });
  if (upstream.status < 200 || upstream.status >= 300) {
    upstream.data?.destroy?.();
    return null;
  }

  const contentType = String(upstream.headers?.['content-type'] || '');
  let ext = extFromContentType(contentType);
  if (ext === 'bin') {
    try {
      const u = new URL(safeUrl);
      const fromPath = String(path.extname(u.pathname).slice(1) || '').toLowerCase();
      if (fromPath === 'jpg' || fromPath === 'jpeg') ext = 'jpg';
      else if (fromPath === 'png') ext = 'png';
      else if (fromPath === 'webp') ext = 'webp';
    } catch {
      // ignore
    }
  }
  if (ext === 'bin') ext = 'jpg';

  const dir = path.join(String(tmpDir || os.tmpdir()), 'lookreplicate-remote');
  ensureDir(dir);
  const outPath = path.join(dir, `${prefix}.${ext}`);

  const contentLength = upstream.headers?.['content-length'];
  if (contentLength && Number(contentLength) > maxBytes) {
    upstream.data?.destroy?.();
    return null;
  }

  await new Promise((resolve, reject) => {
    let total = 0;
    const out = fs.createWriteStream(outPath);
    upstream.data.on('data', (chunk) => {
      total += chunk?.length || 0;
      if (total > maxBytes) {
        upstream.data.destroy(new Error('PAYLOAD_TOO_LARGE'));
      }
    });
    upstream.data.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    upstream.data.pipe(out);
  }).catch(() => {
    try {
      fs.unlinkSync(outPath);
    } catch {
      // ignore
    }
    return null;
  });

  return outPath;
}

async function resolveAssetPathForJob({ jobId, kind, tmpDir, maxBytes }) {
  const local = findAssetFilePath({ jobId, kind });
  if (local) return local;

  const job = await getJob(jobId);
  const url =
    kind === 'reference'
      ? job?.referenceImageUrl
      : kind === 'selfie'
        ? job?.selfieImageUrl
        : job?.tryOnImageUrl;
  if (!url) return null;

  return downloadImageFromUrlToTmpFile(String(url), { tmpDir, prefix: `${kind}-${jobId}`, maxBytes });
}

function copyUploadToAssets({ jobId, kind, file }) {
  if (!file?.path) return null;
  const safeKind = kind === 'selfie' ? 'selfie' : kind === 'tryon' ? 'tryon' : 'reference';
  const ext = extFromContentType(file.contentType);
  const dir = path.join(assetRootDir(), jobId);
  ensureDir(dir);
  const outPath = path.join(dir, `${safeKind}.${ext}`);
  fs.copyFileSync(file.path, outPath);
  return `/api/look-replicate/assets/${encodeURIComponent(jobId)}/${safeKind}`;
}

function findAssetFilePath({ jobId, kind }) {
  const dir = path.join(assetRootDir(), String(jobId || ''));
  const safeKind = kind === 'selfie' ? 'selfie' : kind === 'tryon' ? 'tryon' : 'reference';
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

function normalizeProvider(v, fallback) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return fallback;
  if (s === "gemini" || s === "openai" || s === "openai_compat") return s === "openai_compat" ? "openai" : s;
  return fallback;
}

function inferMarketFromInvokeRequest(req) {
  // Prefer explicit market inside InvokeRequest payload (allowed via `.passthrough()` in InvokeRequestSchema).
  return (
    req?.body?.payload?.market ||
    req?.body?.market ||
    req?.query?.market ||
    req?.header?.('X-Market') ||
    req?.header?.('x-market') ||
    'US'
  );
}

function mountLookReplicatorRoutes(app, { logger }) {
  const MAX_UPLOAD_BYTES = Number(process.env.LOOK_REPLICATOR_MAX_UPLOAD_BYTES || 25 * 1024 * 1024);
  const allowedContentTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

  // --- Try-on: One-click replicate (Gemini, multi-image) ---
  app.post("/api/look-replicate/one-click", async (req, res) => {
    if (!requireLookReplicatorAuth(req, res)) return;
    res.set("Cache-Control", "no-store");
    if (parseBool(process.env.LOOK_REPLICATOR_DISABLE_ONE_CLICK)) {
      return res.status(501).json({ error: "ONE_CLICK_DISABLED", message: "One-click replicate is disabled" });
    }
    const oneClickProvider = normalizeProvider(process.env.LOOK_REPLICATOR_ONE_CLICK_PROVIDER, "gemini");

    let parsed;
    try {
      parsed = await parseMultipart(req, { maxBytes: MAX_UPLOAD_BYTES, allowedContentTypes });
    } catch (err) {
      return res.status(err?.statusCode || 400).json({ error: err?.code || "INVALID_MULTIPART", message: err?.message });
    }

    const { fields, files, tmpDir } = parsed;
    try {
      const jobId = String(fields.jobId || "").trim();
      const userRequest = fields.userRequest ? String(fields.userRequest).trim() : "";

      let contextJson = null;
      try {
        contextJson = fields.contextJson ? parseOptionalJsonField(fields.contextJson) : null;
      } catch {
        contextJson = null;
      }

      if (!jobId) {
        return res.status(400).json({ error: "INVALID_REQUEST", message: "jobId is required" });
      }

      const targetPath = await resolveAssetPathForJob({ jobId, kind: "reference", tmpDir, maxBytes: MAX_UPLOAD_BYTES });
      const selfiePath = await resolveAssetPathForJob({ jobId, kind: "selfie", tmpDir, maxBytes: MAX_UPLOAD_BYTES });
      if (!targetPath || !selfiePath) {
        return res.status(400).json({ error: "MISSING_ASSETS", message: "Missing reference/selfie assets for jobId" });
      }

      const currentRenderFile = files.currentRender || files.afterImage || files.tryonAfter || null;
      const currentRenderPath = currentRenderFile?.path ? String(currentRenderFile.path) : null;

      const outResolved =
        oneClickProvider === "openai"
          ? await runTryOnReplicateOneClickOpenAICompat({
              targetImagePath: targetPath,
              selfieImagePath: selfiePath,
              currentRenderImagePath: currentRenderPath,
              userRequest,
              contextJson,
            })
          : await runTryOnReplicateOneClickGemini({
              targetImagePath: targetPath,
              selfieImagePath: selfiePath,
              currentRenderImagePath: currentRenderPath,
              userRequest,
              contextJson,
            });

      if (!outResolved?.ok) {
        const status = outResolved?.error?.code === "MISSING_API_KEY" ? 501 : 502;
        return res.status(status).json({
          error: outResolved?.error?.code || "ONE_CLICK_FAILED",
          message: outResolved?.error?.message || "One-click replicate failed",
          meta: outResolved?.meta || null,
          ...(outResolved?.details ? { details: outResolved.details } : {}),
        });
      }

      return res.json({
        jobId,
        result: outResolved.value,
        meta: outResolved.meta,
      });
    } finally {
      rmrf(tmpDir);
    }
  });

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
    if (kind !== 'reference' && kind !== 'selfie' && kind !== 'tryon') return res.status(404).json({ error: 'NOT_FOUND' });

    const p = findAssetFilePath({ jobId, kind });
    if (p) {
      const ext = String(path.extname(p).slice(1) || '').toLowerCase();
      res.set('Content-Type', contentTypeFromExt(ext));
      return fs.createReadStream(p).pipe(res);
    }

    // Production is multi-instance / serverless: assets may live in object storage (stored as URLs in the job record).
    const job = await getJob(jobId);
    const url =
      kind === 'reference'
        ? job?.referenceImageUrl
        : kind === 'selfie'
          ? job?.selfieImageUrl
          : job?.tryOnImageUrl;
    if (!url) return res.status(404).json({ error: 'NOT_FOUND' });
    return proxyImageFromUrlToRes(String(url), res, { maxBytes: MAX_UPLOAD_BYTES });
  });

  // --- Try-on image generation (Gemini image editing; produces a try-on image asset) ---
  app.post("/api/look-replicate/tryon", async (req, res) => {
    if (!requireLookReplicatorAuth(req, res)) return;
    res.set("Cache-Control", "no-store");
    if (parseBool(process.env.LOOK_REPLICATOR_DISABLE_TRYON_IMAGE)) {
      return res.status(501).json({ error: "TRYON_DISABLED", message: "Try-on image generation is disabled" });
    }
    const tryOnProvider = normalizeProvider(process.env.LOOK_REPLICATOR_TRYON_PROVIDER, "gemini");

    let parsed;
    try {
      parsed = await parseMultipart(req, { maxBytes: MAX_UPLOAD_BYTES, allowedContentTypes });
    } catch (err) {
      return res.status(err?.statusCode || 400).json({ error: err?.code || "INVALID_MULTIPART", message: err?.message });
    }

    const { fields, files, tmpDir } = parsed;
    try {
      const jobId = String(fields.jobId || "").trim();
      const userRequest = fields.userRequest ? String(fields.userRequest).trim() : "";

      let contextJson = null;
      try {
        contextJson = fields.contextJson ? parseOptionalJsonField(fields.contextJson) : null;
      } catch {
        contextJson = null;
      }

      if (!jobId) {
        return res.status(400).json({ error: "INVALID_REQUEST", message: "jobId is required" });
      }

      const targetPath = await resolveAssetPathForJob({ jobId, kind: "reference", tmpDir, maxBytes: MAX_UPLOAD_BYTES });
      const selfiePath = await resolveAssetPathForJob({ jobId, kind: "selfie", tmpDir, maxBytes: MAX_UPLOAD_BYTES });
      if (!targetPath || !selfiePath) {
        return res.status(400).json({ error: "MISSING_ASSETS", message: "Missing reference/selfie assets for jobId" });
      }

      const currentRenderFile = files.currentRender || files.afterImage || files.tryonAfter || null;
      const uploadedRenderPath = currentRenderFile?.path ? String(currentRenderFile.path) : null;
      const existingTryOnPath = await resolveAssetPathForJob({ jobId, kind: "tryon", tmpDir, maxBytes: MAX_UPLOAD_BYTES });
      const currentRenderPath = uploadedRenderPath || existingTryOnPath || null;

      const out =
        tryOnProvider === "openai"
          ? await runTryOnGenerateImageOpenAICompat({
              targetImagePath: targetPath,
              selfieImagePath: selfiePath,
              currentRenderImagePath: currentRenderPath,
              userRequest,
              contextJson,
            })
          : await runTryOnGenerateImageGemini({
              targetImagePath: targetPath,
              selfieImagePath: selfiePath,
              currentRenderImagePath: currentRenderPath,
              userRequest,
              contextJson,
            });

      if (!out?.ok) {
        const status = out?.error?.code === "MISSING_API_KEY" ? 501 : 502;
        return res.status(status).json({
          error: out?.error?.code || "TRYON_FAILED",
          message: out?.error?.message || "Try-on image generation failed",
          meta: out?.meta || null,
        });
      }

      const buf = Buffer.from(out.value.data, "base64");
      let tryOnPublicUrl = null;
      try {
        const uploaded = await uploadPublicAsset({
          kind: "tryon",
          contentType: out.value.mimeType || "image/png",
          body: buf,
          cacheControl: "public, max-age=31536000, immutable",
        });
        tryOnPublicUrl = uploaded.publicUrl;
        try {
          await updateJob(jobId, { tryOnImageUrl: tryOnPublicUrl });
        } catch {
          // ignore DB write failures
        }
      } catch {
        // If object storage isn't configured, fall back to ephemeral local storage (best-effort for dev).
        const dir = path.join(assetRootDir(), jobId);
        ensureDir(dir);
        // Clear older try-on variants (different extensions) to avoid serving stale images.
        for (const ext of ["jpg", "png", "webp"]) {
          const p = path.join(dir, `tryon.${ext}`);
          if (p !== path.join(dir, out.value.filename) && fs.existsSync(p)) {
            try {
              fs.unlinkSync(p);
            } catch {
              // ignore
            }
          }
        }
        const outPath = path.join(dir, out.value.filename);
        fs.writeFileSync(outPath, buf);
      }

      return res.json({
        jobId,
        tryOnImageUrl: tryOnPublicUrl || `/api/look-replicate/assets/${encodeURIComponent(jobId)}/tryon`,
        meta: out.meta,
      });
    } finally {
      rmrf(tmpDir);
    }
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

      let referenceUrl = null;
      let selfieUrl = null;
      try {
        const uploadedRef = await uploadPublicAsset({
          kind: 'reference',
          contentType: referenceImage.contentType,
          body: fs.readFileSync(referenceImage.path),
          cacheControl: 'public, max-age=31536000, immutable',
        });
        referenceUrl = uploadedRef.publicUrl;
      } catch {
        referenceUrl = copyUploadToAssets({ jobId: job.jobId, kind: 'reference', file: referenceImage });
      }
      if (selfieImage?.path) {
        try {
          const uploadedSelfie = await uploadPublicAsset({
            kind: 'selfie',
            contentType: selfieImage.contentType,
            body: fs.readFileSync(selfieImage.path),
            cacheControl: 'public, max-age=31536000, immutable',
          });
          selfieUrl = uploadedSelfie.publicUrl;
        } catch {
          selfieUrl = copyUploadToAssets({ jobId: job.jobId, kind: 'selfie', file: selfieImage });
        }
      }
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

  // Look Replicator checkout wrapper (US-only).
  // We reuse the existing /agent/shop/v1/invoke handler instead of re-implementing commerce infra.
  app.post('/api/look-replicate/commerce/invoke', async (req, res) => {
    if (!requireLookReplicatorAuth(req, res)) return;
    res.set('Cache-Control', 'no-store');

	    let market = 'US';
	    try {
	      market = parseMarketFromRequest(inferMarketFromInvokeRequest(req), 'US');
	    } catch (err) {
	      const status = err?.httpStatus || 400;
	      return res.status(status).json({ error: err?.code || 'INVALID_MARKET', message: err?.message });
	    }

    // US-first gating: JP can exist as an experiment, but purchasing is disabled for now.
    if (market !== 'US') {
      return res.status(403).json({ error: 'PURCHASE_DISABLED', message: 'Purchases are disabled for this market' });
    }

    const parsed = InvokeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.format() });
    }

    const { operation } = parsed.data;
    const allowedOperations = new Set(['preview_quote', 'create_order', 'submit_payment']);
    if (!allowedOperations.has(operation)) {
      return res.status(400).json({ error: 'UNSUPPORTED_OPERATION', operation });
    }

    const localPort = Number(req?.socket?.localPort) || Number(process.env.PORT) || 3000;
    const upstreamUrl = `http://127.0.0.1:${localPort}/agent/shop/v1/invoke`;
    try {
      const upstream = await axios.post(upstreamUrl, parsed.data, {
        timeout: 20_000,
        headers: { 'Content-Type': 'application/json' },
        validateStatus: () => true,
      });
      return res.status(upstream.status).json(upstream.data);
    } catch (err) {
      logger?.warn?.({ err: err?.message || String(err), operation }, 'lookReplicator commerce invoke failed');
      return res.status(502).json({ error: 'UPSTREAM_UNREACHABLE', message: 'Failed to invoke commerce service' });
    }
  });
}

module.exports = {
  mountLookReplicatorRoutes,
};
