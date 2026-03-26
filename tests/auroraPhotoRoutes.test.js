const express = require('express');
const request = require('supertest');
const { z } = require('zod');

const { mountPhotoRoutes } = require('../src/auroraBff/routes/photoRoutes');

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const deps = {
    logger: { warn: jest.fn(), error: jest.fn() },
    buildRequestContext: jest.fn(() => ({
      request_id: 'req_photo_1',
      trace_id: 'trace_photo_1',
      aurora_uid: 'uid_photo_1',
      lang: 'EN',
    })),
    requireAuroraUid: jest.fn(),
    buildEnvelope: jest.fn((ctx, payload) => ({
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      ...payload,
    })),
    makeAssistantMessage: jest.fn((text) => text),
    makeEvent: jest.fn((_ctx, eventName, data) => ({ event_name: eventName, data })),
    buildPivotaBackendAuthHeaders: jest.fn(() => ({})),
    pickUpstreamErrorDetail: jest.fn(() => 'upstream_error'),
    secondsUntilIso: jest.fn(() => 900),
    resolvePhotoQcStatus: jest.fn((payload) => payload?.qc_status || payload?.qc?.qc_status || null),
    harmonizePhotoQcCardPayload: jest.fn(({ qcStatus, qc, nextPollMs }) => ({
      qcStatus,
      qc,
      nextPollMs,
    })),
    safeBuildAutoAnalysisFromConfirmedPhoto: jest.fn(async () => null),
    setPhotoBytesCache: jest.fn(),
    sleep: jest.fn(async () => undefined),
    PhotosPresignRequestSchema: z.object({
      slot_id: z.string(),
      content_type: z.string().optional(),
      bytes: z.number().optional(),
    }),
    PhotosConfirmRequestSchema: z.object({
      photo_id: z.string(),
      slot_id: z.string().optional(),
    }),
    USE_AURORA_BFF_MOCK: true,
    PIVOTA_BACKEND_BASE_URL: '',
    PHOTO_UPLOAD_PROXY_MAX_BYTES: 8 * 1024 * 1024,
    PHOTO_UPLOAD_PARSE_TIMEOUT_MS: 30000,
  };

  mountPhotoRoutes(app, {
    ...deps,
    ...overrides,
  });

  return { app, deps: { ...deps, ...overrides } };
}

describe('mountPhotoRoutes', () => {
  test('photos presign mock mode returns photo_presign payload', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/v1/photos/presign')
      .send({ slot_id: 'daylight' })
      .expect(200);

    expect(res.body.cards[0].type).toBe('photo_presign');
    expect(res.body.cards[0].field_missing).toEqual([{ field: 'upload.url', reason: 'mock_mode' }]);
  });

  test('photos upload mock mode short-circuits before multipart parsing', async () => {
    const { app, deps } = buildApp();

    const res = await request(app)
      .post('/v1/photos/upload')
      .send({})
      .expect(200);

    expect(res.body.cards[0].type).toBe('photo_confirm');
    expect(res.body.cards[0].payload.qc_status).toBe('passed');
    expect(deps.buildPivotaBackendAuthHeaders).not.toHaveBeenCalled();
  });

  test('photos confirm without backend base returns configured field_missing contract', async () => {
    const { app } = buildApp({
      USE_AURORA_BFF_MOCK: false,
      PIVOTA_BACKEND_BASE_URL: '',
    });

    const res = await request(app)
      .post('/v1/photos/confirm')
      .send({ photo_id: 'photo_123', slot_id: 'daylight' })
      .expect(200);

    expect(res.body.cards[0].type).toBe('photo_confirm');
    expect(res.body.cards[0].field_missing).toEqual([{ field: 'qc_status', reason: 'pivota_backend_not_configured' }]);
    expect(res.body.cards[0].payload.photo_id).toBe('photo_123');
  });
});
