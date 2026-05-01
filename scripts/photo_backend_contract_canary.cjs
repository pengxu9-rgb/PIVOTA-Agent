#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const { Blob } = require('node:buffer');

const DEFAULT_BASE = 'https://pivota-agent-production.up.railway.app';
const DEFAULT_BACKEND_BASE = 'https://web-production-fedb.up.railway.app';
const DEFAULT_FIXTURE = path.resolve(__dirname, '..', 'tests', 'fixtures', 'photo', 'real_face_probe.jpg');
const DEFAULT_IMAGE_URL =
  'https://raw.githubusercontent.com/pengxu9-rgb/PIVOTA-Agent/main/tests/fixtures/photo/real_face_probe.jpg';

function trimString(value) {
  return String(value == null ? '' : value).trim();
}

function trimTrailingSlash(value) {
  return trimString(value).replace(/\/+$/, '');
}

function parseArgs(argv) {
  const out = {
    base: trimTrailingSlash(process.env.BASE || DEFAULT_BASE),
    backendBase: trimTrailingSlash(process.env.BACKEND_BASE || DEFAULT_BACKEND_BASE),
    fixture: process.env.PHOTO_PATH || DEFAULT_FIXTURE,
    imageUrl: process.env.IMAGE_URL || DEFAULT_IMAGE_URL,
    lang: process.env.X_LANG || process.env.LANG_HEADER || 'CN',
    timeoutMs: Number(process.env.TIMEOUT_MS || 180000),
    agentKey:
      trimString(process.env.AGENT_API_KEY) ||
      trimString(process.env.PIVOTA_AGENT_API_KEY) ||
      trimString(process.env.PIVOTA_PRODUCTION_AGENT_API_KEY) ||
      trimString(process.env.TOKEN),
  };

  const args = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const next = args[i + 1];
    if (token === '--base' && next) {
      out.base = trimTrailingSlash(next);
      i += 1;
    } else if (token === '--backend-base' && next) {
      out.backendBase = trimTrailingSlash(next);
      i += 1;
    } else if (token === '--photo-path' && next) {
      out.fixture = next;
      i += 1;
    } else if (token === '--image-url' && next) {
      out.imageUrl = next;
      i += 1;
    } else if (token === '--lang' && next) {
      out.lang = next;
      i += 1;
    } else if (token === '--timeout-ms' && next) {
      out.timeoutMs = Number(next);
      i += 1;
    }
  }

  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs < 5000) out.timeoutMs = 180000;
  return out;
}

function timeoutSignal(timeoutMs) {
  return AbortSignal.timeout(Math.max(1000, Math.trunc(timeoutMs)));
}

async function parseJsonResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

async function requestJson(name, url, init = {}, timeoutMs = 30000) {
  const startedAt = Date.now();
  const res = await fetch(url, {
    ...init,
    signal: timeoutSignal(timeoutMs),
  });
  const body = await parseJsonResponse(res);
  return {
    name,
    http: res.status,
    ms: Date.now() - startedAt,
    body,
  };
}

function getCards(body) {
  return Array.isArray(body && body.cards) ? body.cards : [];
}

function getCard(body, type) {
  return getCards(body).find((card) => card && card.type === type) || null;
}

function hasUploadUrlFromV1Presign(body) {
  const card = getCard(body, 'photo_presign');
  return Boolean(card && card.payload && card.payload.upload && card.payload.upload.url);
}

function summarizeEnvelope(body) {
  const cards = getCards(body);
  const meta = body && body.session_patch && body.session_patch.meta ? body.session_patch.meta : {};
  const modules = getCard(body, 'photo_modules_v1');
  const error = getCard(body, 'error');
  return {
    top_status: body && body.status ? body.status : null,
    meta_status: meta.status || null,
    meta_used_photos: meta.used_photos === true,
    llm_enrichment_status: meta.llm_enrichment_status || null,
    vision_enrichment_status: meta.vision_enrichment_status || null,
    card_types: cards.map((card) => card.type).filter(Boolean),
    photo_modules_used: Boolean(modules && modules.payload && modules.payload.used_photos === true),
    has_story: Boolean(getCard(body, 'analysis_story_v2')),
    has_error: Boolean(error),
    error: error && error.payload ? error.payload.error || null : null,
    error_stage: error && error.payload ? error.payload.stage || null : null,
    detector_source: body && body.analysis_meta ? body.analysis_meta.detector_source || null : null,
    report_stage_outcome: body && body.analysis_meta ? body.analysis_meta.report_stage_outcome || null : null,
  };
}

function assertCondition(condition, message) {
  if (!condition) {
    const err = new Error(message);
    err.code = 'PHOTO_CONTRACT_CANARY_ASSERTION_FAILED';
    throw err;
  }
}

function assertStrictPhotoAnalysis(summary, label) {
  assertCondition(summary.top_status === 'success', `${label} analysis top status must be success`);
  assertCondition(summary.meta_status === 'success', `${label} analysis meta status must be success`);
  assertCondition(summary.meta_used_photos === true, `${label} analysis meta.used_photos must be true`);
  assertCondition(summary.photo_modules_used === true, `${label} analysis must use photo_modules_v1`);
  assertCondition(summary.has_story === true, `${label} analysis must return analysis_story_v2`);
  assertCondition(summary.has_error === false, `${label} analysis must not return error card`);
  assertCondition(summary.llm_enrichment_status !== 'degraded', `${label} analysis must not use degraded LLM enrichment`);
  assertCondition(summary.vision_enrichment_status !== 'degraded', `${label} analysis must not use degraded vision enrichment`);
  assertCondition(summary.report_stage_outcome === 'success', `${label} report stage must be success`);
}

function redactedStep(name, result, extra = {}) {
  return {
    name,
    http: result.http,
    ms: result.ms,
    ...extra,
  };
}

async function run() {
  const cfg = parseArgs(process.argv.slice(2));
  const uidPrefix = `photo_contract_canary_${Date.now()}`;
  const steps = [];

  const agentVersion = await requestJson('agent_version', `${cfg.base}/version`, { method: 'GET' }, 15000);
  steps.push(redactedStep('agent_version', agentVersion, {
    commit: agentVersion.body && agentVersion.body.commit ? agentVersion.body.commit : null,
    full_sha: agentVersion.body && agentVersion.body.full_sha ? String(agentVersion.body.full_sha).slice(0, 12) : null,
  }));
  assertCondition(agentVersion.http === 200, 'agent /version must return 200');

  const backendVersion = await requestJson('backend_version', `${cfg.backendBase}/version`, { method: 'GET' }, 15000);
  steps.push(redactedStep('backend_version', backendVersion, {
    version: backendVersion.body && backendVersion.body.version ? backendVersion.body.version : null,
    full_sha: backendVersion.body && backendVersion.body.full_sha ? String(backendVersion.body.full_sha).slice(0, 12) : null,
  }));
  assertCondition(backendVersion.http === 200, 'backend /version must return 200');

  const noAuthProxy = await requestJson(
    'photos_proxy_no_auth',
    `${cfg.base}/photos/presign`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_type: 'image/jpeg', consent: true, byte_size: 1234 }),
    },
    15000,
  );
  steps.push(redactedStep('photos_proxy_no_auth', noAuthProxy, {
    error: noAuthProxy.body && noAuthProxy.body.error ? noAuthProxy.body.error : null,
    has_upload_url: Boolean(noAuthProxy.body && noAuthProxy.body.upload && noAuthProxy.body.upload.url),
  }));
  assertCondition(noAuthProxy.http === 401, 'generic /photos/presign without auth must return 401');
  assertCondition(!(noAuthProxy.body && noAuthProxy.body.upload && noAuthProxy.body.upload.url), 'no-auth proxy must not expose upload URL');

  if (cfg.agentKey) {
    const authProxy = await requestJson(
      'photos_proxy_with_agent_key',
      `${cfg.base}/photos/presign`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-API-Key': cfg.agentKey,
        },
        body: JSON.stringify({ content_type: 'image/jpeg', consent: true, byte_size: 1234 }),
      },
      30000,
    );
    steps.push(redactedStep('photos_proxy_with_agent_key', authProxy, {
      has_upload_url: Boolean(authProxy.body && authProxy.body.upload && authProxy.body.upload.url),
      upload_id_prefix: authProxy.body && authProxy.body.upload_id ? String(authProxy.body.upload_id).slice(0, 12) : null,
    }));
    assertCondition(authProxy.http === 200, 'generic /photos/presign with agent key must return 200');
    assertCondition(Boolean(authProxy.body && authProxy.body.upload && authProxy.body.upload.url), 'agent-key proxy must return upload URL');
  } else {
    steps.push({
      name: 'photos_proxy_with_agent_key',
      skipped: true,
      reason: 'AGENT_API_KEY/PIVOTA_AGENT_API_KEY/PIVOTA_PRODUCTION_AGENT_API_KEY not set',
    });
  }

  const presign = await requestJson(
    'v1_photos_presign',
    `${cfg.base}/v1/photos/presign`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Aurora-UID': `${uidPrefix}_presign`,
        'X-Lang': cfg.lang,
      },
      body: JSON.stringify({ slot_id: 'front', content_type: 'image/jpeg', bytes: 12345 }),
    },
    30000,
  );
  const presignCard = getCard(presign.body, 'photo_presign');
  steps.push(redactedStep('v1_photos_presign', presign, {
    card_types: getCards(presign.body).map((card) => card.type),
    has_upload_url: hasUploadUrlFromV1Presign(presign.body),
    photo_id_prefix: presignCard && presignCard.payload && presignCard.payload.photo_id
      ? String(presignCard.payload.photo_id).slice(0, 12)
      : null,
  }));
  assertCondition(presign.http === 200, '/v1/photos/presign must return 200');
  assertCondition(hasUploadUrlFromV1Presign(presign.body), '/v1/photos/presign must return a photo_presign upload URL');

  const fixtureBuffer = await fs.readFile(cfg.fixture);
  const form = new FormData();
  form.append('slot_id', 'daylight');
  form.append('consent', 'true');
  form.append('photo', new Blob([fixtureBuffer], { type: 'image/jpeg' }), path.basename(cfg.fixture));
  const upload = await requestJson(
    'v1_photos_upload',
    `${cfg.base}/v1/photos/upload`,
    {
      method: 'POST',
      headers: {
        'X-Aurora-UID': `${uidPrefix}_upload`,
        'X-Lang': cfg.lang,
      },
      body: form,
    },
    cfg.timeoutMs,
  );
  const uploadConfirm = getCard(upload.body, 'photo_confirm');
  const uploadPhotoId = uploadConfirm && uploadConfirm.payload ? trimString(uploadConfirm.payload.photo_id) : '';
  steps.push(redactedStep('v1_photos_upload', upload, {
    card_types: getCards(upload.body).map((card) => card.type),
    photo_id_prefix: uploadPhotoId ? uploadPhotoId.slice(0, 12) : null,
    qc_status: uploadConfirm && uploadConfirm.payload ? uploadConfirm.payload.qc_status || null : null,
  }));
  assertCondition(upload.http === 200, '/v1/photos/upload must return 200');
  assertCondition(Boolean(uploadPhotoId), '/v1/photos/upload must return photo_id');
  assertCondition(uploadConfirm && uploadConfirm.payload && uploadConfirm.payload.qc_status === 'passed', 'uploaded photo must pass QC');

  const uploadedAnalysis = await requestJson(
    'v1_analysis_skin_uploaded_photo',
    `${cfg.base}/v1/analysis/skin`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Aurora-UID': `${uidPrefix}_upload`,
        'X-Lang': cfg.lang,
      },
      body: JSON.stringify({
        use_photo: true,
        skinType: 'combination',
        sensitivity: 'low',
        barrierStatus: 'stable',
        currentRoutine: cfg.lang === 'CN'
          ? 'AM 温和洁面 + 防晒；PM 洁面 + 保湿'
          : 'AM gentle cleanser + SPF; PM cleanser + moisturizer',
        photos: [{ photo_id: uploadPhotoId, slot_id: 'daylight', qc_status: 'passed' }],
      }),
    },
    cfg.timeoutMs,
  );
  const uploadedSummary = summarizeEnvelope(uploadedAnalysis.body);
  steps.push(redactedStep('v1_analysis_skin_uploaded_photo', uploadedAnalysis, uploadedSummary));
  assertCondition(uploadedAnalysis.http === 200, 'uploaded-photo analysis must return 200');
  assertStrictPhotoAnalysis(uploadedSummary, 'uploaded-photo');

  const imageUrlAnalysis = await requestJson(
    'v1_analysis_skin_external_image_url',
    `${cfg.base}/v1/analysis/skin`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Aurora-UID': `${uidPrefix}_image_url`,
        'X-Lang': cfg.lang,
      },
      body: JSON.stringify({
        use_photo: true,
        skinType: 'combination',
        sensitivity: 'low',
        barrierStatus: 'stable',
        currentRoutine: cfg.lang === 'CN'
          ? 'AM 温和洁面 + 防晒；PM 洁面 + 保湿'
          : 'AM gentle cleanser + SPF; PM cleanser + moisturizer',
        photos: [{ image_url: cfg.imageUrl, slot_id: 'daylight', source_agent: 'external_canary' }],
      }),
    },
    cfg.timeoutMs,
  );
  const imageUrlSummary = summarizeEnvelope(imageUrlAnalysis.body);
  steps.push(redactedStep('v1_analysis_skin_external_image_url', imageUrlAnalysis, imageUrlSummary));
  assertCondition(imageUrlAnalysis.http === 200, 'external image_url analysis must return 200');
  assertStrictPhotoAnalysis(imageUrlSummary, 'external image_url');

  return {
    ok: true,
    base: cfg.base,
    backend_base: cfg.backendBase,
    lang: cfg.lang,
    steps,
  };
}

run()
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((err) => {
    console.error(JSON.stringify({
      ok: false,
      error: err && err.code ? err.code : 'PHOTO_CONTRACT_CANARY_FAILED',
      message: err && err.message ? err.message : String(err),
    }, null, 2));
    process.exit(1);
  });
