const crypto = require('crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

function normalizeToken(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase();
}

function parseBool(value, fallback = false) {
  const v = normalizeToken(value);
  if (!v) return fallback;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'n' || v === 'off') return false;
  return fallback;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function isoNow() {
  return new Date().toISOString();
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input == null ? '' : input)).digest('hex');
}

function shortHash(input, len = 16) {
  const hex = sha256Hex(input);
  return hex.slice(0, Math.max(6, Math.min(64, len)));
}

function parseRetentionDays() {
  const raw =
    process.env.AURORA_BFF_RETENTION_DAYS ??
    process.env.AURORA_RETENTION_DAYS ??
    process.env.RETENTION_DAYS;
  if (raw === undefined || raw === null || raw === '') return 30;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 30;
  return Math.max(0, Math.min(365, Math.trunc(n)));
}

function samplerEnabled() {
  const enabled = parseBool(process.env.AURORA_HARD_CASE_SAMPLER_ENABLED, true);
  if (!enabled) return false;
  // In privacy mode, treat retention=0 as "no persistence" for *all* side-effect stores.
  return parseRetentionDays() !== 0;
}

function getStorePaths() {
  const baseDir =
    typeof process.env.AURORA_HARD_CASE_DIR === 'string' && process.env.AURORA_HARD_CASE_DIR.trim()
      ? process.env.AURORA_HARD_CASE_DIR.trim()
      : path.join(process.cwd(), 'tmp', 'hard_cases');
  const imageDir =
    typeof process.env.AURORA_HARD_CASE_IMAGE_DIR === 'string' && process.env.AURORA_HARD_CASE_IMAGE_DIR.trim()
      ? process.env.AURORA_HARD_CASE_IMAGE_DIR.trim()
      : path.join(process.cwd(), 'tmp', 'hard_case_images');
  return { baseDir, imageDir };
}

function getImageTtlDays() {
  const raw = String(process.env.AURORA_HARD_CASE_IMAGE_TTL_DAYS || '').trim();
  if (!raw) return 7;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 7;
  return Math.max(1, Math.min(90, Math.trunc(n)));
}

let LAST_CLEANUP_MS = 0;

function getCleanupIntervalMs() {
  const raw = String(process.env.AURORA_HARD_CASE_CLEANUP_INTERVAL_SEC || '').trim();
  if (!raw) return 15 * 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 15 * 60 * 1000;
  return Math.max(30, Math.min(24 * 60 * 60, Math.trunc(n))) * 1000;
}

function inferDeviceClass(req) {
  const explicit = req && typeof req.get === 'function' ? req.get('X-Device-Class') : null;
  if (explicit && String(explicit).trim()) return String(explicit).trim().slice(0, 64);
  const ua = req && typeof req.get === 'function' ? String(req.get('User-Agent') || '') : '';
  const u = ua.toLowerCase();
  if (!u) return null;
  if (/(iphone|android|ipad|mobile)/.test(u)) return 'mobile';
  if (/(macintosh|windows|linux|x11)/.test(u)) return 'desktop';
  return 'unknown';
}

function normalizeHardCaseQualitySummary({ photoQuality, diagnosisV1 } = {}) {
  const qc = photoQuality && typeof photoQuality === 'object' ? photoQuality : null;
  const dq = diagnosisV1 && diagnosisV1.quality && typeof diagnosisV1.quality === 'object' ? diagnosisV1.quality : null;

  const summary = {
    qc_grade: qc && typeof qc.grade === 'string' ? qc.grade : 'unknown',
    qc_reasons: qc && Array.isArray(qc.reasons) ? qc.reasons.slice(0, 8) : [],
    pixel_grade: dq && typeof dq.grade === 'string' ? dq.grade : null,
    pixel_quality_factor: dq && typeof dq.quality_factor === 'number' ? dq.quality_factor : null,
    pixel_reasons: dq && Array.isArray(dq.reasons) ? dq.reasons.slice(0, 8) : [],
    pixel_metrics: dq && dq.metrics && typeof dq.metrics === 'object' ? dq.metrics : null,
  };
  if (!summary.pixel_metrics) delete summary.pixel_metrics;
  if (!summary.pixel_reasons.length) delete summary.pixel_reasons;
  return summary;
}

function summarizeFindings({ analysis, diagnosisV1 } = {}) {
  const featuresRaw = analysis && Array.isArray(analysis.features) ? analysis.features : [];
  const llmFeatures = [];
  for (const raw of featuresRaw) {
    const f = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!f) continue;
    const observation = typeof f.observation === 'string' ? f.observation.trim() : '';
    if (!observation) continue;
    const confidence = typeof f.confidence === 'string' ? f.confidence.trim() : null;
    llmFeatures.push({
      observation: observation.slice(0, 160),
      ...(confidence ? { confidence } : {}),
    });
    if (llmFeatures.length >= 6) break;
  }

  const issuesRaw = diagnosisV1 && Array.isArray(diagnosisV1.issues) ? diagnosisV1.issues : [];
  const issues = [];
  for (const raw of issuesRaw) {
    const it = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!it) continue;
    const issueType = typeof it.issue_type === 'string' ? it.issue_type : null;
    if (!issueType) continue;
    const severityLevel = Number.isFinite(it.severity_level) ? it.severity_level : 0;
    const confidence = Number.isFinite(it.confidence) ? it.confidence : null;
    if (severityLevel <= 0 && (confidence == null || confidence < 0.2)) continue;
    issues.push({
      issue_type: issueType,
      severity_level: severityLevel,
      ...(confidence == null ? {} : { confidence: Math.round(confidence * 1000) / 1000 }),
    });
    if (issues.length >= 8) break;
  }

  const findingsNonEmpty = llmFeatures.length > 0 || issues.some((x) => (x.severity_level || 0) > 0);

  return {
    findings_non_empty: findingsNonEmpty,
    ...(issues.length ? { issues } : {}),
    ...(llmFeatures.length ? { llm_features: llmFeatures } : {}),
  };
}

function evaluateHardCaseTriggers({
  diagnosisPolicy,
  diagnosisV1,
  photoQuality,
  analysis,
  geometrySanitizer,
  llmCrosscheck,
} = {}) {
  const reasons = [];

  const policy = diagnosisPolicy && typeof diagnosisPolicy === 'object' ? diagnosisPolicy : null;
  const uncertaintyReasons = policy && Array.isArray(policy.uncertainty_reasons) ? policy.uncertainty_reasons : [];
  const uncertaintyHigh =
    (policy && policy.uncertainty === true) ||
    uncertaintyReasons.some((r) => r === 'top2_close' || r === 'low_top_confidence');
  if (uncertaintyHigh) {
    reasons.push('uncertainty_high');
    for (const r of uncertaintyReasons.slice(0, 6)) reasons.push(`uncertainty_${String(r)}`);
  }

  const sanitizer = geometrySanitizer && typeof geometrySanitizer === 'object' ? geometrySanitizer : null;
  const droppedN = sanitizer && Number.isFinite(sanitizer.dropped_n) ? sanitizer.dropped_n : 0;
  const fixedN = sanitizer && Number.isFinite(sanitizer.fixed_n) ? sanitizer.fixed_n : 0;
  if (droppedN > 0 || fixedN > 0) {
    reasons.push('geometry_sanitizer_touched');
    if (droppedN > 0) reasons.push('geometry_sanitizer_dropped');
    if (fixedN > 0) reasons.push('geometry_sanitizer_fixed');
  }

  const qSummary = normalizeHardCaseQualitySummary({ photoQuality, diagnosisV1 });
  const degraded =
    qSummary.pixel_grade === 'degraded' ||
    qSummary.pixel_grade === 'unknown' ||
    qSummary.qc_grade === 'degraded' ||
    qSummary.qc_grade === 'unknown';
  const findings = summarizeFindings({ analysis, diagnosisV1 });
  if (degraded && findings.findings_non_empty) reasons.push('degraded_with_findings');

  const cross = llmCrosscheck && typeof llmCrosscheck === 'object' ? llmCrosscheck : null;
  if (cross && cross.disagree === true) {
    reasons.push('llm_disagree');
    if (Array.isArray(cross.reasons)) {
      for (const r of cross.reasons.slice(0, 6)) reasons.push(`llm_disagree_${String(r)}`);
    }
  }

  return { triggered: reasons.length > 0, reasons: Array.from(new Set(reasons)).slice(0, 16) };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJsonFile(filePath, obj) {
  const json = JSON.stringify(obj);
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, json, { encoding: 'utf8' });
  await fs.rename(tmp, filePath);
}

async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
}

async function safeReadJson(filePath) {
  const raw = await fs.readFile(filePath, { encoding: 'utf8' });
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function cleanupExpiredImages({ logger } = {}) {
  if (!samplerEnabled()) return { ok: true, deleted: 0, reason: 'disabled' };
  const now = Date.now();
  const interval = getCleanupIntervalMs();
  if (now - LAST_CLEANUP_MS < interval) return { ok: true, deleted: 0, reason: 'rate_limited' };
  LAST_CLEANUP_MS = now;

  const { baseDir, imageDir } = getStorePaths();
  let entries = [];
  try {
    entries = await fs.readdir(baseDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, deleted: 0 };
    throw err;
  }

  let deleted = 0;

  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const recordPath = path.join(baseDir, name);
    const record = await safeReadJson(recordPath);
    if (!record || !record.image || typeof record.image !== 'object') continue;
    const expiresAt = typeof record.image.expires_at === 'string' ? Date.parse(record.image.expires_at) : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt > now) continue;

    const fileRel = record.image.file && typeof record.image.file === 'string' ? record.image.file : null;
    const filePath = fileRel ? path.join(imageDir, path.basename(fileRel)) : null;
    if (filePath) {
      try {
        await safeUnlink(filePath);
        deleted += 1;
      } catch (err) {
        logger?.warn?.({ err: err && err.message ? err.message : String(err) }, 'hard case sampler: failed to delete expired image');
      }
    }

    const next = {
      ...record,
      image: {
        ...record.image,
        deleted_at: isoNow(),
        delete_reason: 'ttl_expired',
      },
    };
    try {
      await writeJsonFile(recordPath, next);
    } catch (err) {
      logger?.warn?.({ err: err && err.message ? err.message : String(err) }, 'hard case sampler: failed to mark expired image');
    }
  }

  return { ok: true, deleted };
}

async function storeFaceCrop({ imageBuffer, bboxNorm, hardCaseId, logger } = {}) {
  const buf = imageBuffer && Buffer.isBuffer(imageBuffer) ? imageBuffer : null;
  const box = bboxNorm && typeof bboxNorm === 'object' ? bboxNorm : null;
  if (!buf || !box) return { ok: false, reason: 'missing_inputs' };

  const { imageDir } = getStorePaths();
  await ensureDir(imageDir);

  const ttlDays = getImageTtlDays();
  const expiresAtMs = Date.now() + ttlDays * 24 * 60 * 60 * 1000;
  const expiresAtIso = new Date(expiresAtMs).toISOString();

  const padding = 0.08;
  const x0 = clamp01((Number.isFinite(box.x0) ? box.x0 : 0) - padding);
  const y0 = clamp01((Number.isFinite(box.y0) ? box.y0 : 0) - padding);
  const x1 = clamp01((Number.isFinite(box.x1) ? box.x1 : 1) + padding);
  const y1 = clamp01((Number.isFinite(box.y1) ? box.y1 : 1) + padding);

  let out = null;
  try {
    const img = sharp(buf).rotate();
    const meta = await img.metadata();
    const w = Number.isFinite(meta.width) ? meta.width : null;
    const h = Number.isFinite(meta.height) ? meta.height : null;
    if (!w || !h) return { ok: false, reason: 'metadata_missing' };

    const left = Math.max(0, Math.min(w - 1, Math.round(x0 * w)));
    const top = Math.max(0, Math.min(h - 1, Math.round(y0 * h)));
    const right = Math.max(left + 1, Math.min(w, Math.round(x1 * w)));
    const bottom = Math.max(top + 1, Math.min(h, Math.round(y1 * h)));
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);

    out = await sharp(buf)
      .rotate()
      .extract({ left, top, width, height })
      .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch (err) {
    logger?.warn?.({ err: err && err.message ? err.message : String(err) }, 'hard case sampler: face crop failed');
    return { ok: false, reason: 'crop_failed' };
  }

  if (!out || !out.length) return { ok: false, reason: 'crop_empty' };

  const fileName = `${hardCaseId}.jpg`;
  const filePath = path.join(imageDir, fileName);
  await fs.writeFile(filePath, out);

  return { ok: true, file: fileName, expires_at: expiresAtIso };
}

async function sampleHardCase({
  req,
  ctx,
  identity,
  pipelineVersion,
  shadowRun,
  profileSummary,
  photoQuality,
  diagnosisPolicy,
  diagnosisV1,
  analysis,
  analysisSource,
  geometrySanitizer,
  llmCrosscheck,
  diagnosisPhotoBytes,
  diagnosisV1Internal,
  logger,
} = {}) {
  if (!samplerEnabled()) return { ok: false, sampled: false, reason: 'disabled' };

  // Best-effort cleanup to enforce TTL on any previously stored opt-in crops.
  try {
    await cleanupExpiredImages({ logger });
  } catch (err) {
    logger?.warn?.({ err: err && err.message ? err.message : String(err) }, 'hard case sampler: cleanup failed');
  }

  const triggers = evaluateHardCaseTriggers({
    diagnosisPolicy,
    diagnosisV1,
    photoQuality,
    analysis,
    geometrySanitizer,
    llmCrosscheck,
  });
  if (!triggers.triggered) return { ok: true, sampled: false, reason: 'not_triggered' };

  const { baseDir } = getStorePaths();
  await ensureDir(baseDir);

  const hardCaseId = `hc_${Date.now()}_${shortHash(ctx && ctx.request_id ? ctx.request_id : crypto.randomUUID(), 10)}`;

  const auroraUid = identity && identity.auroraUid ? String(identity.auroraUid) : null;
  const userId = identity && identity.userId ? String(identity.userId) : null;
  const identityHash = auroraUid ? shortHash(`aurora_uid:${auroraUid}`, 24) : userId ? shortHash(`user_id:${userId}`, 24) : null;

  const record = {
    schema_version: 'aurora.hard_case_sample.v1',
    hard_case_id: hardCaseId,
    created_at: isoNow(),
    request_id_hash: ctx && ctx.request_id ? shortHash(`request_id:${ctx.request_id}`, 24) : null,
    trace_id: ctx && ctx.trace_id ? String(ctx.trace_id).slice(0, 128) : null,
    identity_hash: identityHash,
    pipeline_version: pipelineVersion || null,
    shadow_run: Boolean(shadowRun),
    locale: ctx && ctx.lang ? ctx.lang : null,
    region: profileSummary && profileSummary.region ? String(profileSummary.region).slice(0, 64) : null,
    device_class: inferDeviceClass(req),
    analysis_source: analysisSource || null,
    triggers: triggers.reasons,
    quality: normalizeHardCaseQualitySummary({ photoQuality, diagnosisV1 }),
    findings: summarizeFindings({ analysis, diagnosisV1 }),
  };

  // Default: never store images. Only store the face crop when explicitly opted-in.
  const optInImage =
    !shadowRun &&
    parseBool(req && typeof req.get === 'function' ? req.get('X-Aurora-Opt-In-Image') : null, false);

  if (optInImage) {
    const buf = diagnosisPhotoBytes && Buffer.isBuffer(diagnosisPhotoBytes) ? diagnosisPhotoBytes : null;
    const roi = diagnosisV1Internal && typeof diagnosisV1Internal === 'object' ? diagnosisV1Internal : null;
    const bboxNorm = roi && roi.skin_bbox_norm && typeof roi.skin_bbox_norm === 'object' ? roi.skin_bbox_norm : null;
    if (buf && bboxNorm) {
      const stored = await storeFaceCrop({ imageBuffer: buf, bboxNorm, hardCaseId, logger });
      if (stored.ok) {
        record.image = { kind: 'face_crop', file: stored.file, expires_at: stored.expires_at };
      } else {
        record.image = { kind: 'face_crop', stored: false, reason: stored.reason || 'store_failed' };
      }
    } else {
      record.image = { kind: 'face_crop', stored: false, reason: 'missing_face_crop_inputs' };
    }
  }

  const filePath = path.join(baseDir, `${hardCaseId}.json`);
  await writeJsonFile(filePath, record);

  logger?.info?.(
    {
      kind: 'hard_case_sample',
      hard_case_id: hardCaseId,
      request_id: ctx && ctx.request_id ? ctx.request_id : null,
      trace_id: ctx && ctx.trace_id ? ctx.trace_id : null,
      triggers: triggers.reasons,
      qc_grade: record.quality.qc_grade,
      pixel_grade: record.quality.pixel_grade,
      has_image: Boolean(record.image && record.image.file),
    },
    'hard case sampler: sampled',
  );

  return { ok: true, sampled: true, hard_case_id: hardCaseId, record_path: filePath };
}

async function deleteHardCasesForIdentity({ auroraUid, userId, logger } = {}) {
  const uid = auroraUid ? String(auroraUid).trim() : '';
  const aid = userId ? String(userId).trim() : '';
  const target =
    uid ? shortHash(`aurora_uid:${uid}`, 24) : aid ? shortHash(`user_id:${aid}`, 24) : null;
  if (!target) return { ok: false, deleted: 0, reason: 'missing_identity' };

  const { baseDir, imageDir } = getStorePaths();
  let entries = [];
  try {
    entries = await fs.readdir(baseDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, deleted: 0 };
    throw err;
  }

  let deleted = 0;
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const recordPath = path.join(baseDir, name);
    const record = await safeReadJson(recordPath);
    if (!record || record.identity_hash !== target) continue;

    if (record.image && typeof record.image === 'object' && typeof record.image.file === 'string') {
      const imgPath = path.join(imageDir, path.basename(record.image.file));
      try {
        await safeUnlink(imgPath);
      } catch (err) {
        logger?.warn?.({ err: err && err.message ? err.message : String(err) }, 'hard case sampler: failed to delete image');
      }
    }

    try {
      await safeUnlink(recordPath);
      deleted += 1;
    } catch (err) {
      logger?.warn?.({ err: err && err.message ? err.message : String(err) }, 'hard case sampler: failed to delete record');
    }
  }

  return { ok: true, deleted };
}

module.exports = {
  samplerEnabled,
  getStorePaths,
  getImageTtlDays,
  evaluateHardCaseTriggers,
  normalizeHardCaseQualitySummary,
  summarizeFindings,
  cleanupExpiredImages,
  sampleHardCase,
  deleteHardCasesForIdentity,
  shortHash,
};
