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
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      resetVisionMetrics();

      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
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
        assert.equal(
          Array.isArray(card?.payload?.analysis?.takeaways)
            ? card.payload.analysis.takeaways.some((item) => item && item.source === 'photo')
            : false,
          true,
        );
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
