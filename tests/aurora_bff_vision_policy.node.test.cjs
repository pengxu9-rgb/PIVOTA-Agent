const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');
const sharp = require('sharp');

const {
  VisionUnavailabilityReason,
  classifyVisionAvailability,
  classifyVisionProviderFailure,
  shouldRetryVision,
  executeVisionWithRetry,
  normalizeVisionFailureReason,
  pickPrimaryVisionReason,
  buildVisionPhotoNotice,
} = require('../src/auroraBff/visionPolicy');
const { resetVisionMetrics } = require('../src/auroraBff/visionMetrics');

function withEnv(patch, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(patch || {})) {
    prev[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }

  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

function loadAuroraRoutesModule() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const mod = require('../src/auroraBff/routes');
  return { moduleId, mod };
}

test('vision availability classification: missing key and disabled flag', () => {
  const disabled = classifyVisionAvailability({ enabled: false, apiKeyConfigured: true });
  assert.equal(disabled.available, false);
  assert.equal(disabled.reason, VisionUnavailabilityReason.VISION_DISABLED_BY_FLAG);

  const missingKey = classifyVisionAvailability({ enabled: true, apiKeyConfigured: false });
  assert.equal(missingKey.available, false);
  assert.equal(missingKey.reason, VisionUnavailabilityReason.VISION_MISSING_KEY);
});

test('vision failure mapping: timeout / 429 / 4xx / 5xx / schema', () => {
  const timeout = classifyVisionProviderFailure({ name: 'AbortError', message: 'request timed out' });
  assert.equal(timeout.reason, VisionUnavailabilityReason.VISION_TIMEOUT);

  const rateLimited = classifyVisionProviderFailure({ status: 429, message: 'Too many requests' });
  assert.equal(rateLimited.reason, VisionUnavailabilityReason.VISION_RATE_LIMITED);

  const quota = classifyVisionProviderFailure({ status: 429, message: 'insufficient_quota' });
  assert.equal(quota.reason, VisionUnavailabilityReason.VISION_QUOTA_EXCEEDED);

  const badRequest = classifyVisionProviderFailure({ status: 400, message: 'invalid request' });
  assert.equal(badRequest.reason, VisionUnavailabilityReason.VISION_UPSTREAM_4XX);

  const forbidden = classifyVisionProviderFailure({ status: 403, message: 'forbidden' });
  assert.equal(forbidden.reason, VisionUnavailabilityReason.VISION_UPSTREAM_4XX);

  const serverError = classifyVisionProviderFailure({ status: 500, message: 'upstream unavailable' });
  assert.equal(serverError.reason, VisionUnavailabilityReason.VISION_UPSTREAM_5XX);

  const schemaInvalid = classifyVisionProviderFailure({ __vision_reason: VisionUnavailabilityReason.VISION_SCHEMA_INVALID });
  assert.equal(schemaInvalid.reason, VisionUnavailabilityReason.VISION_SCHEMA_INVALID);

  const geminiClientError = classifyVisionProviderFailure({ name: 'ClientError', message: 'gemini client request rejected' });
  assert.equal(geminiClientError.reason, VisionUnavailabilityReason.VISION_UPSTREAM_4XX);

  const grpcRateLimited = classifyVisionProviderFailure({ code: 'RESOURCE_EXHAUSTED', message: 'request rate exceeded' });
  assert.equal(grpcRateLimited.reason, VisionUnavailabilityReason.VISION_RATE_LIMITED);

  const grpcDeadline = classifyVisionProviderFailure({ code: 'DEADLINE_EXCEEDED', message: 'deadline exceeded' });
  assert.equal(grpcDeadline.reason, VisionUnavailabilityReason.VISION_TIMEOUT);

  const grpcUnauthenticated = classifyVisionProviderFailure({ code: 'UNAUTHENTICATED', message: 'api key invalid' });
  assert.equal(grpcUnauthenticated.reason, VisionUnavailabilityReason.VISION_UPSTREAM_4XX);
});

test('vision retry policy: only retry retryable reasons', async () => {
  let transientAttempts = 0;
  const transient = await executeVisionWithRetry({
    maxRetries: 2,
    baseDelayMs: 1,
    operation: async () => {
      transientAttempts += 1;
      if (transientAttempts < 3) {
        const err = new Error('timeout');
        err.name = 'AbortError';
        throw err;
      }
      return { ok: true };
    },
  });
  assert.equal(transient.ok, true);
  assert.equal(transient.retry.attempted, 2);
  assert.equal(transient.retry.final, 'success');

  let nonRetryAttempts = 0;
  const nonRetry = await executeVisionWithRetry({
    maxRetries: 2,
    baseDelayMs: 1,
    operation: async () => {
      nonRetryAttempts += 1;
      const err = new Error('forbidden');
      err.status = 403;
      throw err;
    },
  });
  assert.equal(nonRetry.ok, false);
  assert.equal(nonRetryAttempts, 1);
  assert.equal(nonRetry.retry.attempted, 0);
  assert.equal(nonRetry.reason, VisionUnavailabilityReason.VISION_UPSTREAM_4XX);

  assert.equal(shouldRetryVision(VisionUnavailabilityReason.VISION_TIMEOUT), true);
  assert.equal(shouldRetryVision(VisionUnavailabilityReason.VISION_UPSTREAM_5XX), true);
  assert.equal(shouldRetryVision(VisionUnavailabilityReason.VISION_RATE_LIMITED), true);
  assert.equal(shouldRetryVision(VisionUnavailabilityReason.VISION_QUOTA_EXCEEDED), false);
  assert.equal(shouldRetryVision(VisionUnavailabilityReason.VISION_UPSTREAM_4XX), false);
});

test('vision photo notice is safe and user-facing', () => {
  const n1 = buildVisionPhotoNotice({ reason: VisionUnavailabilityReason.VISION_MISSING_KEY, language: 'EN' });
  assert.match(String(n1 || ''), /temporarily unavailable/i);

  const n2 = buildVisionPhotoNotice({ reason: VisionUnavailabilityReason.VISION_UPSTREAM_4XX, language: 'EN' });
  assert.match(String(n2 || ''), /re-upload/i);

  const n3 = buildVisionPhotoNotice({ reason: 'photo_quality_fail_retake', language: 'EN' });
  assert.equal(n3, null);
});

test('non-vision reasons do not become VISION_UNKNOWN', () => {
  assert.equal(normalizeVisionFailureReason('photo_quality_fail_retake'), null);
  assert.equal(pickPrimaryVisionReason(['photo_quality_fail_retake', 'degraded_mode_vision']), null);
  assert.equal(
    pickPrimaryVisionReason(['photo_quality_fail_retake', VisionUnavailabilityReason.VISION_TIMEOUT]),
    VisionUnavailabilityReason.VISION_TIMEOUT,
  );
});

test('vision provider selection: auto picks gemini, forced gemini ignores openai key', async () => {
  await withEnv(
    {
      AURORA_SKIN_VISION_PROVIDER: 'auto',
      OPENAI_API_KEY: undefined,
      GEMINI_API_KEY: 'gemini_test_key',
    },
    async () => {
      const { moduleId, mod } = loadAuroraRoutesModule();
      try {
        const selected = mod.__internal.resolveVisionProviderSelection();
        assert.equal(selected.provider, 'gemini');
        assert.equal(selected.apiKeyConfigured, true);
      } finally {
        delete require.cache[moduleId];
      }
    },
  );

  await withEnv(
    {
      AURORA_SKIN_VISION_PROVIDER: 'gemini',
      OPENAI_API_KEY: 'openai_key_present',
      GEMINI_API_KEY: undefined,
    },
    async () => {
      const { moduleId, mod } = loadAuroraRoutesModule();
      try {
        const selected = mod.__internal.resolveVisionProviderSelection();
        assert.equal(selected.provider, 'gemini');
        assert.equal(selected.apiKeyConfigured, false);
      } finally {
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/analysis/skin: missing vision key falls back to CV findings with metrics', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_SKIN_VISION_ENABLED: 'true',
      OPENAI_API_KEY: undefined,
      AURORA_PHOTO_FETCH_RETRIES: '0',
      AURORA_PHOTO_FETCH_TOTAL_TIMEOUT_MS: '3000',
      AURORA_PHOTO_FETCH_TIMEOUT_MS: '1000',
    },
    async () => {
      resetVisionMetrics();

      const { moduleId, mod } = loadAuroraRoutesModule();
      const { mountAuroraBffRoutes } = mod;
      const axios = require('axios');
      const originalGet = axios.get;

      const pngBytes = await sharp({
        create: {
          width: 320,
          height: 320,
          channels: 3,
          background: { r: 218, g: 190, b: 170 },
        },
      })
        .png()
        .toBuffer();

      axios.get = async (url) => {
        const u = String(url || '');
        if (u.endsWith('/photos/download-url')) {
          return {
            status: 200,
            data: {
              download: {
                url: 'https://signed-download.test/open',
                expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
              },
              content_type: 'image/png',
            },
          };
        }
        if (u === 'https://signed-download.test/open') {
          return {
            status: 200,
            data: pngBytes,
            headers: { 'content-type': 'image/png' },
          };
        }
        throw new Error(`Unexpected axios.get url: ${u}`);
      };

      try {
        const app = express();
        app.use(express.json({ limit: '2mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const request = supertest(app);
        const resp = await request
          .post('/v1/analysis/skin')
          .set({
            'X-Aurora-UID': 'uid_vision_missing_key',
            'X-Trace-ID': 'trace_vision_missing_key',
            'X-Brief-ID': 'brief_vision_missing_key',
            'X-Lang': 'EN',
          })
          .send({
            use_photo: true,
            currentRoutine: 'AM cleanser + SPF; PM cleanser + moisturizer',
            photos: [{ slot_id: 'daylight', photo_id: 'photo_missing_key', qc_status: 'passed' }],
          })
          .expect(200);

        const card = Array.isArray(resp.body?.cards) ? resp.body.cards.find((item) => item && item.type === 'analysis_summary') : null;
        assert.ok(card);
        assert.equal(card?.payload?.quality_report?.llm?.vision?.decision, 'fallback');
        assert.equal(
          Array.isArray(card?.payload?.quality_report?.llm?.vision?.reasons) &&
            card.payload.quality_report.llm.vision.reasons.includes(VisionUnavailabilityReason.VISION_MISSING_KEY),
          true,
        );
        const qualityGrade = String(card?.payload?.quality_report?.photo_quality?.grade || '').toLowerCase();
        if (qualityGrade === 'fail') {
          assert.equal(
            Array.isArray(card?.payload?.analysis?.takeaways)
              ? card.payload.analysis.takeaways.some((item) => item && item.source === 'photo')
              : false,
            false,
          );
          assert.ok(card?.payload?.analysis?.next_action_card);
          assert.equal(Array.isArray(card?.payload?.analysis?.next_action_card?.retake_guide), true);
          assert.equal(Array.isArray(card?.payload?.analysis?.next_action_card?.ask_3_questions), true);
        } else {
          assert.equal(
            Array.isArray(card?.payload?.analysis?.takeaways)
              ? card.payload.analysis.takeaways.some((item) => item && item.source === 'photo')
              : false,
            true,
          );
        }
        assert.match(String(card?.payload?.analysis?.photo_notice || ''), /temporarily unavailable/i);

        const metrics = await request.get('/metrics').expect(200);
        const body = String(metrics.text || '');
        assert.match(body, /vision_calls_total\{provider="openai",decision="fallback"\}\s+1/);
        assert.match(body, /vision_fallback_total\{provider="openai",reason="VISION_MISSING_KEY"\}\s+1/);
        assert.match(body, /vision_fallback_total\{provider="openai",reason="VISION_CV_FALLBACK_USED"\}\s+1/);
      } finally {
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/analysis/skin: forced gemini with missing key reports gemini reason and metrics', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_SKIN_VISION_ENABLED: 'true',
      AURORA_SKIN_VISION_PROVIDER: 'gemini',
      OPENAI_API_KEY: 'openai_present_but_should_not_be_used',
      GEMINI_API_KEY: undefined,
      AURORA_PHOTO_FETCH_RETRIES: '0',
      AURORA_PHOTO_FETCH_TOTAL_TIMEOUT_MS: '3000',
      AURORA_PHOTO_FETCH_TIMEOUT_MS: '1000',
    },
    async () => {
      resetVisionMetrics();
      const { moduleId, mod } = loadAuroraRoutesModule();
      const { mountAuroraBffRoutes } = mod;
      const axios = require('axios');
      const originalGet = axios.get;

      const pngBytes = await sharp({
        create: {
          width: 320,
          height: 320,
          channels: 3,
          background: { r: 218, g: 190, b: 170 },
        },
      })
        .png()
        .toBuffer();

      axios.get = async (url) => {
        const u = String(url || '');
        if (u.endsWith('/photos/download-url')) {
          return {
            status: 200,
            data: {
              download: {
                url: 'https://signed-download.test/open',
                expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
              },
              content_type: 'image/png',
            },
          };
        }
        if (u === 'https://signed-download.test/open') {
          return {
            status: 200,
            data: pngBytes,
            headers: { 'content-type': 'image/png' },
          };
        }
        throw new Error(`Unexpected axios.get url: ${u}`);
      };

      try {
        const app = express();
        app.use(express.json({ limit: '2mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const request = supertest(app);
        const resp = await request
          .post('/v1/analysis/skin')
          .set({
            'X-Aurora-UID': 'uid_vision_missing_key_gemini',
            'X-Trace-ID': 'trace_vision_missing_key_gemini',
            'X-Brief-ID': 'brief_vision_missing_key_gemini',
            'X-Lang': 'EN',
          })
          .send({
            use_photo: true,
            currentRoutine: 'AM cleanser + SPF; PM cleanser + moisturizer',
            photos: [{ slot_id: 'daylight', photo_id: 'photo_missing_key_gemini', qc_status: 'passed' }],
          })
          .expect(200);

        const card = Array.isArray(resp.body?.cards) ? resp.body.cards.find((item) => item && item.type === 'analysis_summary') : null;
        assert.ok(card);
        assert.equal(card?.payload?.quality_report?.llm?.vision?.provider, 'gemini');
        assert.equal(
          Array.isArray(card?.payload?.quality_report?.llm?.vision?.reasons) &&
            card.payload.quality_report.llm.vision.reasons.includes(VisionUnavailabilityReason.VISION_MISSING_KEY),
          true,
        );

        const metrics = await request.get('/metrics').expect(200);
        const body = String(metrics.text || '');
        assert.match(body, /vision_calls_total\{provider="gemini",decision="fallback"\}\s+1/);
        assert.match(body, /vision_fallback_total\{provider="gemini",reason="VISION_MISSING_KEY"\}\s+1/);
      } finally {
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/analysis/skin: photo_quality_fail_retake does not emit VISION_UNKNOWN notice', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      AURORA_SKIN_VISION_ENABLED: 'true',
      AURORA_SKIN_VISION_PROVIDER: 'openai',
      OPENAI_API_KEY: 'dummy_openai_key',
      PIVOTA_BACKEND_BASE_URL: '',
      PIVOTA_BACKEND_AGENT_API_KEY: '',
    },
    async () => {
      resetVisionMetrics();
      const { moduleId, mod } = loadAuroraRoutesModule();
      try {
        const { mountAuroraBffRoutes } = mod;
        const app = express();
        app.use(express.json({ limit: '2mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const request = supertest(app);
        const resp = await request
          .post('/v1/analysis/skin')
          .set({
            'X-Aurora-UID': 'uid_retake_reason_guard',
            'X-Trace-ID': 'trace_retake_reason_guard',
            'X-Brief-ID': 'brief_retake_reason_guard',
            'X-Lang': 'EN',
          })
          .send({
            use_photo: true,
            currentRoutine: 'AM cleanser + SPF; PM cleanser + moisturizer',
            photos: [{ slot_id: 'daylight', photo_id: 'photo_retake', qc_status: 'failed' }],
          })
          .expect(200);

        const card = Array.isArray(resp.body?.cards) ? resp.body.cards.find((item) => item && item.type === 'analysis_summary') : null;
        assert.ok(card);
        const vision = card?.payload?.quality_report?.llm?.vision || {};
        const reasons = Array.isArray(vision.reasons) ? vision.reasons : [];
        assert.equal(vision.decision, 'skip');
        assert.equal(reasons.includes('photo_quality_fail_retake'), true);
        assert.equal(reasons.includes(VisionUnavailabilityReason.VISION_UNKNOWN), false);
        assert.equal(String(card?.payload?.analysis?.photo_notice || '').toLowerCase().includes('temporarily unavailable'), false);
      } finally {
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/analysis/skin: force vision debug bypasses retake gate on fail-grade', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      AURORA_SKIN_VISION_ENABLED: 'true',
      AURORA_SKIN_FORCE_VISION_CALL: 'true',
      AURORA_SKIN_VISION_PROVIDER: 'openai',
      OPENAI_API_KEY: undefined,
      PIVOTA_BACKEND_BASE_URL: '',
      PIVOTA_BACKEND_AGENT_API_KEY: '',
    },
    async () => {
      resetVisionMetrics();
      const { moduleId, mod } = loadAuroraRoutesModule();
      try {
        const { mountAuroraBffRoutes } = mod;
        const app = express();
        app.use(express.json({ limit: '2mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const request = supertest(app);
        const resp = await request
          .post('/v1/analysis/skin')
          .set({
            'X-Aurora-UID': 'uid_force_vision_debug',
            'X-Trace-ID': 'trace_force_vision_debug',
            'X-Brief-ID': 'brief_force_vision_debug',
            'X-Lang': 'EN',
          })
          .send({
            use_photo: true,
            currentRoutine: 'AM cleanser + SPF; PM cleanser + moisturizer',
            photos: [{ slot_id: 'daylight', photo_id: 'photo_force_vision_debug', qc_status: 'failed' }],
          })
          .expect(200);

        const card = Array.isArray(resp.body?.cards) ? resp.body.cards.find((item) => item && item.type === 'analysis_summary') : null;
        assert.ok(card);
        const vision = card?.payload?.quality_report?.llm?.vision || {};
        const reasons = Array.isArray(vision.reasons) ? vision.reasons : [];
        assert.equal(vision.decision, 'fallback');
        assert.equal(reasons.includes(VisionUnavailabilityReason.VISION_IMAGE_FETCH_FAILED), true);
        assert.notEqual(card?.payload?.analysis_source, 'retake');
      } finally {
        delete require.cache[moduleId];
      }
    },
  );
});
