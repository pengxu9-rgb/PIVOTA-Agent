const axios = require('axios');
const fs = require('fs');
const { parseMultipart, rmrf } = require('../../platform/shared/multipart');

function ensureFunction(name, value) {
  if (typeof value === 'function') return value;
  throw new Error(`aurora photo routes missing dependency: ${name}`);
}

function ensureSchema(name, value) {
  if (value && typeof value.safeParse === 'function') return value;
  throw new Error(`aurora photo routes missing schema: ${name}`);
}

function mountPhotoRoutes(app, deps = {}) {
  const buildRequestContext = ensureFunction('buildRequestContext', deps.buildRequestContext);
  const requireAuroraUid = ensureFunction('requireAuroraUid', deps.requireAuroraUid);
  const buildEnvelope = ensureFunction('buildEnvelope', deps.buildEnvelope);
  const makeAssistantMessage = ensureFunction('makeAssistantMessage', deps.makeAssistantMessage);
  const makeEvent = ensureFunction('makeEvent', deps.makeEvent);
  const buildPivotaBackendAuthHeaders = ensureFunction(
    'buildPivotaBackendAuthHeaders',
    deps.buildPivotaBackendAuthHeaders,
  );
  const pickUpstreamErrorDetail = ensureFunction('pickUpstreamErrorDetail', deps.pickUpstreamErrorDetail);
  const secondsUntilIso = ensureFunction('secondsUntilIso', deps.secondsUntilIso);
  const resolvePhotoQcStatus = ensureFunction('resolvePhotoQcStatus', deps.resolvePhotoQcStatus);
  const harmonizePhotoQcCardPayload = ensureFunction(
    'harmonizePhotoQcCardPayload',
    deps.harmonizePhotoQcCardPayload,
  );
  const safeBuildAutoAnalysisFromConfirmedPhoto = ensureFunction(
    'safeBuildAutoAnalysisFromConfirmedPhoto',
    deps.safeBuildAutoAnalysisFromConfirmedPhoto,
  );
  const setPhotoBytesCache = ensureFunction('setPhotoBytesCache', deps.setPhotoBytesCache);
  const sleep = ensureFunction('sleep', deps.sleep);

  const PhotosPresignRequestSchema = ensureSchema('PhotosPresignRequestSchema', deps.PhotosPresignRequestSchema);
  const PhotosConfirmRequestSchema = ensureSchema('PhotosConfirmRequestSchema', deps.PhotosConfirmRequestSchema);

  const logger = deps && typeof deps.logger === 'object' ? deps.logger : null;
  const useAuroraBffMock = deps.USE_AURORA_BFF_MOCK === true;
  const pivotaBackendBaseUrl =
    typeof deps.PIVOTA_BACKEND_BASE_URL === 'string' ? deps.PIVOTA_BACKEND_BASE_URL.trim() : '';
  const photoUploadProxyMaxBytes = Number.isFinite(Number(deps.PHOTO_UPLOAD_PROXY_MAX_BYTES))
    ? Number(deps.PHOTO_UPLOAD_PROXY_MAX_BYTES)
    : 8 * 1024 * 1024;
  const photoUploadParseTimeoutMs = Number.isFinite(Number(deps.PHOTO_UPLOAD_PARSE_TIMEOUT_MS))
    ? Number(deps.PHOTO_UPLOAD_PARSE_TIMEOUT_MS)
    : 30000;

  app.post('/v1/photos/presign', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = PhotosPresignRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: { error: 'BAD_REQUEST', details: parsed.error.format() },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      if (useAuroraBffMock) {
        const photoId = `photo_${ctx.request_id}_${Date.now()}`;
        const payload = {
          photo_id: photoId,
          slot_id: parsed.data.slot_id,
          upload: {
            method: 'PUT',
            url: null,
            headers: {},
            expires_in_seconds: 600,
          },
        };

        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `presign_${ctx.request_id}`,
              type: 'photo_presign',
              payload,
              field_missing: [{ field: 'upload.url', reason: 'mock_mode' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_presign' })],
        });
        return res.json(envelope);
      }

      if (!pivotaBackendBaseUrl) {
        const photoId = `photo_${ctx.request_id}_${Date.now()}`;
        const payload = {
          photo_id: photoId,
          slot_id: parsed.data.slot_id,
          upload: {
            method: 'PUT',
            url: null,
            headers: {},
            expires_in_seconds: 600,
          },
        };

        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `presign_${ctx.request_id}`,
              type: 'photo_presign',
              payload,
              field_missing: [{ field: 'upload.url', reason: 'pivota_backend_not_configured' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_presign' })],
        });
        return res.json(envelope);
      }

      const authHeaders = buildPivotaBackendAuthHeaders(req);
      if (!Object.keys(authHeaders).length) {
        const photoId = `photo_${ctx.request_id}_${Date.now()}`;
        const payload = {
          photo_id: photoId,
          slot_id: parsed.data.slot_id,
          upload: {
            method: 'PUT',
            url: null,
            headers: {},
            expires_in_seconds: 600,
          },
        };

        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `presign_${ctx.request_id}`,
              type: 'photo_presign',
              payload,
              field_missing: [{ field: 'upload.url', reason: 'pivota_backend_auth_not_configured' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_presign' })],
        });
        return res.json(envelope);
      }

      const contentType =
        typeof parsed.data.content_type === 'string' && parsed.data.content_type.trim()
          ? parsed.data.content_type.trim()
          : 'image/jpeg';
      const byteSize =
        typeof parsed.data.bytes === 'number' && Number.isFinite(parsed.data.bytes) ? parsed.data.bytes : null;

      const upstreamResp = await axios.post(
        `${pivotaBackendBaseUrl}/photos/presign`,
        {
          content_type: contentType,
          ...(byteSize ? { byte_size: byteSize } : {}),
          consent: true,
          user_id: ctx.aurora_uid,
        },
        {
          timeout: 12000,
          validateStatus: () => true,
          headers: { 'Content-Type': 'application/json', ...authHeaders },
        },
      );

      if (upstreamResp.status !== 200 || !upstreamResp.data || !upstreamResp.data.upload_id || !upstreamResp.data.upload) {
        const detail = pickUpstreamErrorDetail(upstreamResp.data);
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Failed to presign upload.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: {
                error: 'PHOTO_PRESIGN_UPSTREAM_FAILED',
                status: upstreamResp.status,
                detail: detail || null,
              },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_PRESIGN_UPSTREAM_FAILED', status: upstreamResp.status })],
        });
        return res.status(upstreamResp.status >= 400 ? upstreamResp.status : 502).json(envelope);
      }

      const uploadId = String(upstreamResp.data.upload_id);
      const upstreamUpload = upstreamResp.data.upload || {};
      const expiresInSeconds = secondsUntilIso(upstreamResp.data.expires_at) ?? 900;

      const payload = {
        photo_id: uploadId,
        slot_id: parsed.data.slot_id,
        upload: {
          method: upstreamUpload.method || 'PUT',
          url: upstreamUpload.url || null,
          headers: upstreamUpload.headers || {},
          expires_in_seconds: expiresInSeconds,
        },
        ...(typeof upstreamResp.data.max_bytes === 'number' ? { max_bytes: upstreamResp.data.max_bytes } : {}),
        ...(upstreamResp.data.tips ? { tips: upstreamResp.data.tips } : {}),
      };

      const fieldMissing = [];
      if (!payload.upload.url) fieldMissing.push({ field: 'upload.url', reason: 'upstream_missing_upload_url' });

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `presign_${ctx.request_id}`,
            type: 'photo_presign',
            payload,
            ...(fieldMissing.length ? { field_missing: fieldMissing } : {}),
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'value_moment', { kind: 'photo_presign' })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to presign upload.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: { error: err.code || 'PHOTO_PRESIGN_FAILED' },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'PHOTO_PRESIGN_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/photos/upload', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    let tmpDir = null;
    try {
      requireAuroraUid(ctx);

      if (useAuroraBffMock) {
        const photoId = `photo_${ctx.request_id}_${Date.now()}`;
        const payload = {
          photo_id: photoId,
          slot_id: 'daylight',
          qc_status: 'passed',
          qc: { state: 'done', qc_status: 'passed', advice: { summary: 'Mock: photo looks good.', suggestions: [] } },
        };
        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `confirm_${ctx.request_id}`,
              type: 'photo_confirm',
              payload,
              field_missing: [{ field: 'upload.url', reason: 'mock_mode' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_upload', qc_status: 'passed' })],
        });
        return res.json(envelope);
      }

      const authHeaders = buildPivotaBackendAuthHeaders(req);
      if (!pivotaBackendBaseUrl) {
        const payload = { photo_id: null, slot_id: null, qc_status: null };
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Photo upload is not configured.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `confirm_${ctx.request_id}`,
              type: 'photo_confirm',
              payload,
              field_missing: [{ field: 'photo_id', reason: 'pivota_backend_not_configured' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_UPLOAD_NOT_CONFIGURED' })],
        });
        return res.status(501).json(envelope);
      }
      if (!Object.keys(authHeaders).length) {
        const payload = { photo_id: null, slot_id: null, qc_status: null };
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Photo upload auth is not configured.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `confirm_${ctx.request_id}`,
              type: 'photo_confirm',
              payload,
              field_missing: [{ field: 'photo_id', reason: 'pivota_backend_auth_not_configured' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_UPLOAD_AUTH_NOT_CONFIGURED' })],
        });
        return res.status(501).json(envelope);
      }

      const reqContentType = String(req.headers['content-type'] || '').toLowerCase();
      if (!reqContentType.includes('multipart/form-data') || !reqContentType.includes('boundary=')) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: { error: 'BAD_REQUEST', detail: 'multipart_required' },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const { fields, files, tmpDir: parsedTmpDir } = await parseMultipart(req, {
        maxBytes: photoUploadProxyMaxBytes,
        parseTimeoutMs: photoUploadParseTimeoutMs,
        allowedContentTypes: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']),
        requiredFields: ['slot_id', 'consent'],
      });
      tmpDir = parsedTmpDir;

      const slotId = String(fields.slot_id || '').trim();
      if (!slotId) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Missing slot_id.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: { error: 'BAD_REQUEST', detail: 'slot_id_required' },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const consentRaw = String(fields.consent || '').trim().toLowerCase();
      const consent = consentRaw === 'true' || consentRaw === '1' || consentRaw === 'yes';
      if (!consent) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('User consent is required.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'USER_CONSENT_REQUIRED' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'USER_CONSENT_REQUIRED' })],
        });
        return res.status(400).json(envelope);
      }

      const fileEntry = files.photo || files.file || files.image || Object.values(files || {})[0];
      if (!fileEntry || !fileEntry.path) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Missing photo file.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: { error: 'BAD_REQUEST', detail: 'photo_file_required' },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const stat = fs.statSync(fileEntry.path);
      const byteSize = Number.isFinite(stat.size) ? stat.size : null;
      const contentType = fileEntry.contentType || 'image/jpeg';

      const presignResp = await axios.post(
        `${pivotaBackendBaseUrl}/photos/presign`,
        {
          content_type: contentType,
          ...(byteSize ? { byte_size: byteSize } : {}),
          consent: true,
          user_id: ctx.aurora_uid,
        },
        {
          timeout: 12000,
          validateStatus: () => true,
          headers: { 'Content-Type': 'application/json', ...authHeaders },
        },
      );

      if (presignResp.status !== 200 || !presignResp.data || !presignResp.data.upload_id || !presignResp.data.upload) {
        const detail = pickUpstreamErrorDetail(presignResp.data);
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Failed to start photo upload.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: { error: 'PHOTO_PRESIGN_UPSTREAM_FAILED', status: presignResp.status, detail: detail || null },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_PRESIGN_UPSTREAM_FAILED', status: presignResp.status })],
        });
        return res.status(presignResp.status >= 400 ? presignResp.status : 502).json(envelope);
      }

      const uploadId = String(presignResp.data.upload_id);
      const upstreamUpload = presignResp.data.upload || {};
      const uploadUrl = typeof upstreamUpload.url === 'string' ? upstreamUpload.url.trim() : '';
      const uploadMethod =
        typeof upstreamUpload.method === 'string' && upstreamUpload.method.trim()
          ? upstreamUpload.method.trim().toUpperCase()
          : 'PUT';
      const uploadHeaders =
        upstreamUpload.headers && typeof upstreamUpload.headers === 'object' ? upstreamUpload.headers : {};

      if (!uploadUrl) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Upload URL is missing from upstream.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'UPSTREAM_MISSING_UPLOAD_URL' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'UPSTREAM_MISSING_UPLOAD_URL' })],
        });
        return res.status(502).json(envelope);
      }

      const hasHeader = (headersObj, key) => {
        const wanted = String(key || '').toLowerCase();
        for (const headerKey of Object.keys(headersObj || {})) {
          if (String(headerKey).toLowerCase() === wanted) return true;
        }
        return false;
      };

      const finalUploadHeaders = { ...uploadHeaders };
      if (byteSize && !hasHeader(finalUploadHeaders, 'content-length')) {
        finalUploadHeaders['Content-Length'] = String(byteSize);
      }
      if (contentType && !hasHeader(finalUploadHeaders, 'content-type')) {
        finalUploadHeaders['Content-Type'] = contentType;
      }

      const uploadResp = await axios.request({
        method: uploadMethod,
        url: uploadUrl,
        headers: finalUploadHeaders,
        data: fs.createReadStream(fileEntry.path),
        timeout: 120000,
        maxBodyLength: 30 * 1024 * 1024,
        maxContentLength: 30 * 1024 * 1024,
        validateStatus: () => true,
      });

      if (uploadResp.status < 200 || uploadResp.status >= 300) {
        const detail =
          typeof uploadResp.data === 'string'
            ? uploadResp.data.slice(0, 4000)
            : uploadResp.data && typeof uploadResp.data === 'object'
              ? JSON.stringify(uploadResp.data).slice(0, 4000)
              : null;
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Failed to upload photo bytes.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: { error: 'PHOTO_UPLOAD_BYTES_FAILED', status: uploadResp.status, detail },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_UPLOAD_BYTES_FAILED', status: uploadResp.status })],
        });
        return res.status(502).json(envelope);
      }

      const confirmResp = await axios.post(
        `${pivotaBackendBaseUrl}/photos/confirm`,
        { upload_id: uploadId, ...(byteSize ? { byte_size: byteSize } : {}) },
        {
          timeout: 12000,
          validateStatus: () => true,
          headers: { 'Content-Type': 'application/json', ...authHeaders },
        },
      );

      if (confirmResp.status !== 200 || !confirmResp.data) {
        const detail = pickUpstreamErrorDetail(confirmResp.data);
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Failed to confirm upload.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: { error: 'PHOTO_CONFIRM_UPSTREAM_FAILED', status: confirmResp.status, detail: detail || null },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_CONFIRM_UPSTREAM_FAILED', status: confirmResp.status })],
        });
        return res.status(confirmResp.status >= 400 ? confirmResp.status : 502).json(envelope);
      }

      let qcStatus = resolvePhotoQcStatus(confirmResp.data);
      let qc = confirmResp.data.qc && typeof confirmResp.data.qc === 'object' ? confirmResp.data.qc : null;
      let nextPollMs = typeof confirmResp.data.next_poll_ms === 'number' ? confirmResp.data.next_poll_ms : null;

      const deadlineMs = Date.now() + 6000;
      let lastQcData = null;
      while (!qcStatus && Date.now() < deadlineMs) {
        const waitMs = Math.min(1200, Math.max(400, nextPollMs || 1000));
        await sleep(waitMs);

        const qcResp = await axios.get(`${pivotaBackendBaseUrl}/photos/qc`, {
          timeout: 12000,
          validateStatus: () => true,
          headers: authHeaders,
          params: { upload_id: uploadId },
        });

        if (qcResp.status !== 200 || !qcResp.data) break;
        lastQcData = qcResp.data;
        const resolvedPollStatus = resolvePhotoQcStatus(qcResp.data);
        if (resolvedPollStatus) qcStatus = resolvedPollStatus;
        qc = qcResp.data.qc && typeof qcResp.data.qc === 'object' ? qcResp.data.qc : qc;
        nextPollMs = typeof qcResp.data.next_poll_ms === 'number' ? qcResp.data.next_poll_ms : nextPollMs;
      }

      const normalizedQcPayload = harmonizePhotoQcCardPayload({
        qcStatus,
        qc,
        nextPollMs,
        language: ctx.lang,
      });
      qcStatus = normalizedQcPayload.qcStatus;
      qc = normalizedQcPayload.qc;
      nextPollMs = normalizedQcPayload.nextPollMs;

      const payload = {
        photo_id: uploadId,
        slot_id: slotId,
        qc_status: qcStatus,
        ...(qc ? { qc } : {}),
        ...(typeof nextPollMs === 'number' ? { next_poll_ms: nextPollMs } : {}),
        ...(!qcStatus && lastQcData ? { qc_pending: true } : {}),
      };

      try {
        const uploadBuffer = fs.readFileSync(fileEntry.path);
        setPhotoBytesCache({
          photoId: uploadId,
          auroraUid: ctx.aurora_uid,
          buffer: uploadBuffer,
          contentType,
        });
      } catch (cacheErr) {
        logger?.warn(
          { err: cacheErr && cacheErr.message ? cacheErr.message : String(cacheErr) },
          'aurora bff: failed to cache upload bytes',
        );
      }

      const fieldMissing = [];
      if (!qcStatus) fieldMissing.push({ field: 'qc_status', reason: 'qc_pending' });

      const photoConfirmCard = {
        card_id: `confirm_${ctx.request_id}`,
        type: 'photo_confirm',
        payload,
        ...(fieldMissing.length ? { field_missing: fieldMissing } : {}),
      };
      const autoAnalysis = await safeBuildAutoAnalysisFromConfirmedPhoto({
        req,
        ctx,
        photoId: uploadId,
        slotId,
        qcStatus,
        logger,
      });

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [photoConfirmCard, ...(autoAnalysis && Array.isArray(autoAnalysis.cards) ? autoAnalysis.cards : [])],
        session_patch: autoAnalysis && autoAnalysis.session_patch ? autoAnalysis.session_patch : {},
        events: [
          makeEvent(ctx, 'value_moment', { kind: 'photo_upload', qc_status: qcStatus }),
          ...(autoAnalysis && autoAnalysis.event ? [autoAnalysis.event] : []),
        ],
      });
      return res.json(envelope);
    } catch (err) {
      const status = Number(err?.statusCode || err?.status || 500);
      const code = err?.code || 'PHOTO_UPLOAD_FAILED';
      logger?.error(
        {
          err: err && err.message ? err.message : String(err),
          code,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
          aurora_uid: ctx.aurora_uid,
        },
        'aurora bff: /v1/photos/upload failed',
      );
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to upload photo.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: code } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code })],
      });
      return res.status(status).json(envelope);
    } finally {
      if (tmpDir) rmrf(tmpDir);
    }
  });

  app.post('/v1/photos/confirm', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = PhotosConfirmRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: { error: 'BAD_REQUEST', details: parsed.error.format() },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      if (useAuroraBffMock) {
        const qcStatus = 'passed';
        const payload = { ...parsed.data, qc_status: qcStatus };

        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [{ card_id: `confirm_${ctx.request_id}`, type: 'photo_confirm', payload }],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_confirm', qc_status: qcStatus })],
        });
        return res.json(envelope);
      }

      if (!pivotaBackendBaseUrl) {
        const payload = { ...parsed.data, qc_status: null };
        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `confirm_${ctx.request_id}`,
              type: 'photo_confirm',
              payload,
              field_missing: [{ field: 'qc_status', reason: 'pivota_backend_not_configured' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_confirm', qc_status: null })],
        });
        return res.json(envelope);
      }

      const authHeaders = buildPivotaBackendAuthHeaders(req);
      if (!Object.keys(authHeaders).length) {
        const payload = { ...parsed.data, qc_status: null };
        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `confirm_${ctx.request_id}`,
              type: 'photo_confirm',
              payload,
              field_missing: [{ field: 'qc_status', reason: 'pivota_backend_auth_not_configured' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_confirm', qc_status: null })],
        });
        return res.json(envelope);
      }

      const uploadId = parsed.data.photo_id;
      const confirmResp = await axios.post(
        `${pivotaBackendBaseUrl}/photos/confirm`,
        { upload_id: uploadId },
        {
          timeout: 12000,
          validateStatus: () => true,
          headers: { 'Content-Type': 'application/json', ...authHeaders },
        },
      );

      if (confirmResp.status !== 200 || !confirmResp.data) {
        const detail = pickUpstreamErrorDetail(confirmResp.data);
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Failed to confirm upload.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: {
                error: 'PHOTO_CONFIRM_UPSTREAM_FAILED',
                status: confirmResp.status,
                detail: detail || null,
              },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_CONFIRM_UPSTREAM_FAILED', status: confirmResp.status })],
        });
        return res.status(confirmResp.status >= 400 ? confirmResp.status : 502).json(envelope);
      }

      let qcStatus = resolvePhotoQcStatus(confirmResp.data);
      let qc = confirmResp.data.qc && typeof confirmResp.data.qc === 'object' ? confirmResp.data.qc : null;
      let nextPollMs = typeof confirmResp.data.next_poll_ms === 'number' ? confirmResp.data.next_poll_ms : null;

      const deadlineMs = Date.now() + 6000;
      let lastQcData = null;
      while (!qcStatus && Date.now() < deadlineMs) {
        const waitMs = Math.min(1200, Math.max(400, nextPollMs || 1000));
        await sleep(waitMs);

        const qcResp = await axios.get(`${pivotaBackendBaseUrl}/photos/qc`, {
          timeout: 12000,
          validateStatus: () => true,
          headers: authHeaders,
          params: { upload_id: uploadId },
        });

        if (qcResp.status !== 200 || !qcResp.data) break;

        lastQcData = qcResp.data;
        const resolvedPollStatus = resolvePhotoQcStatus(qcResp.data);
        if (resolvedPollStatus) qcStatus = resolvedPollStatus;
        qc = qcResp.data.qc && typeof qcResp.data.qc === 'object' ? qcResp.data.qc : qc;
        nextPollMs = typeof qcResp.data.next_poll_ms === 'number' ? qcResp.data.next_poll_ms : nextPollMs;
      }

      const normalizedQcPayload = harmonizePhotoQcCardPayload({
        qcStatus,
        qc,
        nextPollMs,
        language: ctx.lang,
      });
      qcStatus = normalizedQcPayload.qcStatus;
      qc = normalizedQcPayload.qc;
      nextPollMs = normalizedQcPayload.nextPollMs;

      const payload = {
        ...parsed.data,
        qc_status: qcStatus,
        ...(qc ? { qc } : {}),
        ...(typeof nextPollMs === 'number' ? { next_poll_ms: nextPollMs } : {}),
        ...(!qcStatus && lastQcData ? { qc_pending: true } : {}),
      };

      const fieldMissing = [];
      if (!qcStatus) fieldMissing.push({ field: 'qc_status', reason: 'qc_pending' });

      const photoConfirmCard = {
        card_id: `confirm_${ctx.request_id}`,
        type: 'photo_confirm',
        payload,
        ...(fieldMissing.length ? { field_missing: fieldMissing } : {}),
      };
      const autoAnalysis = await safeBuildAutoAnalysisFromConfirmedPhoto({
        req,
        ctx,
        photoId: uploadId,
        slotId: parsed.data.slot_id || null,
        qcStatus,
        logger,
      });

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [photoConfirmCard, ...(autoAnalysis && Array.isArray(autoAnalysis.cards) ? autoAnalysis.cards : [])],
        session_patch: autoAnalysis && autoAnalysis.session_patch ? autoAnalysis.session_patch : {},
        events: [
          makeEvent(ctx, 'value_moment', { kind: 'photo_confirm', qc_status: qcStatus }),
          ...(autoAnalysis && autoAnalysis.event ? [autoAnalysis.event] : []),
        ],
      });
      return res.json(envelope);
    } catch (err) {
      const status = Number(err?.statusCode || err?.status || 500);
      const code = err?.code || 'PHOTO_CONFIRM_FAILED';
      logger?.error(
        {
          err: err && err.message ? err.message : String(err),
          code,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
          aurora_uid: ctx.aurora_uid,
        },
        'aurora bff: /v1/photos/confirm failed',
      );
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to confirm upload.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: code } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code })],
      });
      return res.status(status).json(envelope);
    }
  });
}

module.exports = {
  mountPhotoRoutes,
};
