const VisionUnavailabilityReason = Object.freeze({
  VISION_MISSING_KEY: 'VISION_MISSING_KEY',
  VISION_DISABLED_BY_FLAG: 'VISION_DISABLED_BY_FLAG',
  VISION_RATE_LIMITED: 'VISION_RATE_LIMITED',
  VISION_QUOTA_EXCEEDED: 'VISION_QUOTA_EXCEEDED',
  VISION_TIMEOUT: 'VISION_TIMEOUT',
  VISION_UPSTREAM_4XX: 'VISION_UPSTREAM_4XX',
  VISION_UPSTREAM_5XX: 'VISION_UPSTREAM_5XX',
  VISION_SCHEMA_INVALID: 'VISION_SCHEMA_INVALID',
  VISION_SEMANTIC_INVALID: 'VISION_SEMANTIC_INVALID',
  VISION_IMAGE_INVALID: 'VISION_IMAGE_INVALID',
  VISION_IMAGE_FETCH_FAILED: 'VISION_IMAGE_FETCH_FAILED',
  VISION_UNKNOWN: 'VISION_UNKNOWN',
  VISION_CV_FALLBACK_USED: 'VISION_CV_FALLBACK_USED',
});

const VISION_FAILURE_REASONS = Object.freeze(
  new Set([
    VisionUnavailabilityReason.VISION_MISSING_KEY,
    VisionUnavailabilityReason.VISION_DISABLED_BY_FLAG,
    VisionUnavailabilityReason.VISION_RATE_LIMITED,
    VisionUnavailabilityReason.VISION_QUOTA_EXCEEDED,
    VisionUnavailabilityReason.VISION_TIMEOUT,
    VisionUnavailabilityReason.VISION_UPSTREAM_4XX,
    VisionUnavailabilityReason.VISION_UPSTREAM_5XX,
    VisionUnavailabilityReason.VISION_SCHEMA_INVALID,
    VisionUnavailabilityReason.VISION_SEMANTIC_INVALID,
    VisionUnavailabilityReason.VISION_IMAGE_INVALID,
    VisionUnavailabilityReason.VISION_IMAGE_FETCH_FAILED,
    VisionUnavailabilityReason.VISION_UNKNOWN,
  ]),
);

const RETRYABLE_REASONS = Object.freeze(
  new Set([
    VisionUnavailabilityReason.VISION_TIMEOUT,
    VisionUnavailabilityReason.VISION_UPSTREAM_5XX,
    VisionUnavailabilityReason.VISION_RATE_LIMITED,
  ]),
);

const LEGACY_REASON_MAP = Object.freeze({
  vision_disabled: VisionUnavailabilityReason.VISION_DISABLED_BY_FLAG,
  openai_not_configured: VisionUnavailabilityReason.VISION_MISSING_KEY,
  vision_timeout: VisionUnavailabilityReason.VISION_TIMEOUT,
  vision_output_invalid: VisionUnavailabilityReason.VISION_SCHEMA_INVALID,
  vision_failed: VisionUnavailabilityReason.VISION_UNKNOWN,
  image_missing: VisionUnavailabilityReason.VISION_IMAGE_FETCH_FAILED,
  download_url_fetch_4xx: VisionUnavailabilityReason.VISION_IMAGE_FETCH_FAILED,
  download_url_fetch_5xx: VisionUnavailabilityReason.VISION_IMAGE_FETCH_FAILED,
  download_url_timeout: VisionUnavailabilityReason.VISION_IMAGE_FETCH_FAILED,
  download_url_dns: VisionUnavailabilityReason.VISION_IMAGE_FETCH_FAILED,
  download_url_expired: VisionUnavailabilityReason.VISION_IMAGE_FETCH_FAILED,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeReasonToken(value) {
  return String(value == null ? '' : value)
    .trim()
    .toUpperCase();
}

function normalizeVisionReason(reason) {
  const token = normalizeReasonToken(reason);
  if (!token) return VisionUnavailabilityReason.VISION_UNKNOWN;
  if (VISION_FAILURE_REASONS.has(token)) return token;
  if (token === VisionUnavailabilityReason.VISION_CV_FALLBACK_USED) return token;

  const legacy = LEGACY_REASON_MAP[String(reason || '').trim().toLowerCase()];
  if (legacy) return legacy;

  if (token.includes('MISSING') && token.includes('KEY')) return VisionUnavailabilityReason.VISION_MISSING_KEY;
  if (token.includes('DISABLED')) return VisionUnavailabilityReason.VISION_DISABLED_BY_FLAG;
  if (token.includes('RATE') && token.includes('LIMIT')) return VisionUnavailabilityReason.VISION_RATE_LIMITED;
  if (token.includes('QUOTA')) return VisionUnavailabilityReason.VISION_QUOTA_EXCEEDED;
  if (token.includes('TIMEOUT')) return VisionUnavailabilityReason.VISION_TIMEOUT;
  if (token.includes('SCHEMA')) return VisionUnavailabilityReason.VISION_SCHEMA_INVALID;
  if (token.includes('SEMANTIC')) return VisionUnavailabilityReason.VISION_SEMANTIC_INVALID;
  if (token.includes('IMAGE_INVALID')) return VisionUnavailabilityReason.VISION_IMAGE_INVALID;
  if (token.includes('FETCH') || token.includes('IMAGE')) return VisionUnavailabilityReason.VISION_IMAGE_FETCH_FAILED;
  if (token.includes('4XX')) return VisionUnavailabilityReason.VISION_UPSTREAM_4XX;
  if (token.includes('5XX')) return VisionUnavailabilityReason.VISION_UPSTREAM_5XX;
  return VisionUnavailabilityReason.VISION_UNKNOWN;
}

function normalizeVisionFailureReason(reason) {
  const raw = String(reason == null ? '' : reason).trim();
  if (!raw) return null;
  const token = raw.toUpperCase();
  if (VISION_FAILURE_REASONS.has(token)) return token;

  const legacy = LEGACY_REASON_MAP[raw.toLowerCase()];
  if (legacy) return legacy;

  if (raw.toLowerCase() === 'vision_unavailable') return VisionUnavailabilityReason.VISION_UNKNOWN;
  if (token.startsWith('VISION_')) return normalizeVisionReason(token);
  return null;
}

function isVisionFailureReason(reason) {
  return VISION_FAILURE_REASONS.has(normalizeVisionReason(reason));
}

function shouldRetryVision(reason) {
  return RETRYABLE_REASONS.has(normalizeVisionReason(reason));
}

function containsImageInvalidHint(text) {
  const token = String(text || '').toLowerCase();
  return (
    token.includes('unable to process input image') ||
    token.includes('unsupported mime') ||
    token.includes('mime') ||
    token.includes('invalid image') ||
    token.includes('invalid argument') ||
    token.includes('too large') ||
    token.includes('payload too large') ||
    token.includes('decode') ||
    token.includes('corrupt') ||
    token.includes('resolution') ||
    token.includes('image')
  );
}

function classifyVisionAvailability({ enabled, apiKeyConfigured } = {}) {
  if (!enabled) {
    return {
      available: false,
      reason: VisionUnavailabilityReason.VISION_DISABLED_BY_FLAG,
    };
  }
  if (!apiKeyConfigured) {
    return {
      available: false,
      reason: VisionUnavailabilityReason.VISION_MISSING_KEY,
    };
  }
  return { available: true, reason: null };
}

function toStatusCode(error) {
  const candidates = [
    error && error.status,
    error && error.statusCode,
    error && error.code === 'ETIMEDOUT' ? 408 : null,
    error && error.response && error.response.status,
  ];
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return Math.trunc(num);
  }
  return null;
}

function toErrorCode(error) {
  const code =
    (error && (error.code || error.errorCode || (error.error && error.error.code) || (error.response && error.response.data && error.response.data.code))) ||
    null;
  if (!code) return null;
  return String(code).trim().toUpperCase() || null;
}

function collectErrorText(error) {
  const values = [
    error && error.message,
    error && error.type,
    error && error.name,
    error && error.code,
    error && error.error && error.error.message,
    error && error.error && error.error.type,
    error && error.error && error.error.code,
    error && error.response && error.response.data && error.response.data.error,
    error && error.response && error.response.data && error.response.data.message,
    error && error.response && error.response.data && error.response.data.detail,
  ];
  return values.filter(Boolean).map((item) => String(item)).join(' ').toLowerCase();
}

function trimOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function clampMessage(value, maxLen = 500) {
  const text = trimOrNull(value);
  if (!text) return null;
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(1, maxLen - 3))}...`;
}

function getNested(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function getHeaderValue(headers, keyCandidates = []) {
  if (!headers || typeof headers !== 'object') return null;
  for (const key of keyCandidates) {
    if (!key) continue;
    const direct = trimOrNull(headers[key]);
    if (direct) return direct;
    const lower = trimOrNull(headers[String(key).toLowerCase()]);
    if (lower) return lower;
    const upper = trimOrNull(headers[String(key).toUpperCase()]);
    if (upper) return upper;
  }
  const normalized = Object.create(null);
  for (const [k, v] of Object.entries(headers)) {
    normalized[String(k || '').toLowerCase()] = v;
  }
  for (const key of keyCandidates) {
    const value = trimOrNull(normalized[String(key || '').toLowerCase()]);
    if (value) return value;
  }
  return null;
}

function toGrpcStatus(error) {
  const raw =
    trimOrNull(error && error.grpc_status) ||
    trimOrNull(error && error.grpcStatus) ||
    trimOrNull(error && error.statusDetails && error.statusDetails.code) ||
    null;
  if (raw && /^[A-Z_]+$/.test(raw.toUpperCase())) return raw.toUpperCase();
  const code = trimOrNull(error && error.code);
  if (code && /^[A-Z_]+$/.test(code.toUpperCase())) return code.toUpperCase();
  return null;
}

function toProviderErrorCode(error) {
  const raw =
    trimOrNull(error && error.code) ||
    trimOrNull(error && error.errorCode) ||
    trimOrNull(getNested(error, ['error', 'code'])) ||
    trimOrNull(getNested(error, ['response', 'data', 'error', 'code'])) ||
    trimOrNull(getNested(error, ['response', 'data', 'code'])) ||
    null;
  return raw;
}

function toProviderErrorMessage(error) {
  const detail = getNested(error, ['response', 'data', 'error']);
  const detailText =
    typeof detail === 'string'
      ? detail
      : detail && typeof detail === 'object'
        ? JSON.stringify(detail)
        : null;
  const raw =
    trimOrNull(error && error.message) ||
    trimOrNull(getNested(error, ['error', 'message'])) ||
    trimOrNull(getNested(error, ['response', 'data', 'message'])) ||
    trimOrNull(getNested(error, ['response', 'data', 'detail'])) ||
    trimOrNull(detailText) ||
    null;
  return clampMessage(raw, 500);
}

function buildVisionErrorEvidence(error, { reason, statusCode, timeoutMs, region, model } = {}) {
  const responseHeaders = getNested(error, ['response', 'headers']);
  const rootHeaders = error && error.headers;
  const requestHeaders = getNested(error, ['request', 'headers']);
  const providerRequestId =
    getHeaderValue(responseHeaders, ['x-request-id', 'x-goog-request-id', 'request-id']) ||
    getHeaderValue(rootHeaders, ['x-request-id', 'x-goog-request-id', 'request-id']) ||
    trimOrNull(error && error.requestId) ||
    trimOrNull(error && error.request_id) ||
    null;
  const providerTrace =
    getHeaderValue(responseHeaders, ['traceparent', 'x-cloud-trace-context', 'x-b3-traceid', 'x-trace-id']) ||
    getHeaderValue(rootHeaders, ['traceparent', 'x-cloud-trace-context', 'x-b3-traceid', 'x-trace-id']) ||
    getHeaderValue(requestHeaders, ['traceparent', 'x-cloud-trace-context', 'x-b3-traceid', 'x-trace-id']) ||
    trimOrNull(error && error.trace) ||
    trimOrNull(error && error.trace_id) ||
    null;
  const timeoutValue =
    Number.isFinite(Number(timeoutMs))
      ? Math.max(0, Math.trunc(Number(timeoutMs)))
      : Number.isFinite(Number(error && error.timeout_ms))
        ? Math.max(0, Math.trunc(Number(error.timeout_ms)))
        : Number.isFinite(Number(error && error.timeoutMs))
          ? Math.max(0, Math.trunc(Number(error.timeoutMs)))
          : Number.isFinite(Number(getNested(error, ['config', 'timeout'])))
            ? Math.max(0, Math.trunc(Number(getNested(error, ['config', 'timeout']))))
            : null;
  const regionValue =
    trimOrNull(region) ||
    trimOrNull(error && error.region) ||
    getHeaderValue(responseHeaders, ['x-goog-region']) ||
    null;
  const modelValue =
    trimOrNull(model) ||
    trimOrNull(error && error.model) ||
    trimOrNull(getNested(error, ['request', 'model'])) ||
    null;
  const evidence = {
    reason_normalized: normalizeVisionReason(reason),
    http_status: Number.isFinite(Number(statusCode)) ? Math.trunc(Number(statusCode)) : null,
    grpc_status: toGrpcStatus(error),
    provider_error_code: toProviderErrorCode(error),
    provider_error_message: toProviderErrorMessage(error),
    provider_request_id: providerRequestId,
    provider_trace: providerTrace,
    timeout_ms: timeoutValue,
    region: regionValue,
    model: modelValue,
  };
  return evidence;
}

function classifyVisionProviderFailure(error, { timeoutMs, region, model } = {}) {
  const mappedFromExplicitReason = normalizeReasonToken(error && (error.__vision_reason || error.reason));
  if (mappedFromExplicitReason && mappedFromExplicitReason !== 'VISION_FAILED') {
    const reason = normalizeVisionReason(mappedFromExplicitReason);
    return {
      reason,
      status_code: toStatusCode(error),
      error_code: toErrorCode(error),
      error_evidence: buildVisionErrorEvidence(error, {
        reason,
        statusCode: toStatusCode(error),
        timeoutMs,
        region,
        model,
      }),
    };
  }

  const statusCode = toStatusCode(error);
  const errorCode = toErrorCode(error);
  const text = collectErrorText(error);
  const normalizedErrorCode = String(errorCode || '').trim().toUpperCase();
  const grpc4xxCodes = new Set([
    'INVALID_ARGUMENT',
    'FAILED_PRECONDITION',
    'OUT_OF_RANGE',
    'UNAUTHENTICATED',
    'PERMISSION_DENIED',
    'NOT_FOUND',
    'ALREADY_EXISTS',
  ]);
  const grpc5xxCodes = new Set(['UNAVAILABLE', 'INTERNAL', 'ABORTED', 'DATA_LOSS']);

  if (normalizedErrorCode) {
    if (normalizedErrorCode === 'DEADLINE_EXCEEDED') {
      const reason = VisionUnavailabilityReason.VISION_TIMEOUT;
      return {
        reason,
        status_code: statusCode,
        error_code: errorCode,
        error_evidence: buildVisionErrorEvidence(error, {
          reason,
          statusCode,
          timeoutMs,
          region,
          model,
        }),
      };
    }
    if (normalizedErrorCode === 'RESOURCE_EXHAUSTED') {
      const quotaLike = /quota|insufficient[_\s-]?quota|billing|credit/.test(text);
      const reason = quotaLike ? VisionUnavailabilityReason.VISION_QUOTA_EXCEEDED : VisionUnavailabilityReason.VISION_RATE_LIMITED;
      return {
        reason,
        status_code: statusCode || 429,
        error_code: errorCode,
        error_evidence: buildVisionErrorEvidence(error, {
          reason,
          statusCode: statusCode || 429,
          timeoutMs,
          region,
          model,
        }),
      };
    }
    if (grpc4xxCodes.has(normalizedErrorCode)) {
      const reason = containsImageInvalidHint(text)
        ? VisionUnavailabilityReason.VISION_IMAGE_INVALID
        : VisionUnavailabilityReason.VISION_UPSTREAM_4XX;
      return {
        reason,
        status_code: statusCode,
        error_code: errorCode,
        error_evidence: buildVisionErrorEvidence(error, {
          reason,
          statusCode,
          timeoutMs,
          region,
          model,
        }),
      };
    }
    if (grpc5xxCodes.has(normalizedErrorCode)) {
      const reason = VisionUnavailabilityReason.VISION_UPSTREAM_5XX;
      return {
        reason,
        status_code: statusCode,
        error_code: errorCode,
        error_evidence: buildVisionErrorEvidence(error, {
          reason,
          statusCode,
          timeoutMs,
          region,
          model,
        }),
      };
    }
  }

  if ((error && error.name === 'AbortError') || /timeout|timed out|econnaborted|etimedout/.test(text)) {
    const reason = VisionUnavailabilityReason.VISION_TIMEOUT;
    return {
      reason,
      status_code: statusCode,
      error_code: errorCode,
      error_evidence: buildVisionErrorEvidence(error, {
        reason,
        statusCode,
        timeoutMs,
        region,
        model,
      }),
    };
  }

  if (statusCode === 429) {
    const quotaLike = /quota|insufficient[_\s-]?quota|billing|credit/.test(text);
    const reason = quotaLike ? VisionUnavailabilityReason.VISION_QUOTA_EXCEEDED : VisionUnavailabilityReason.VISION_RATE_LIMITED;
    return {
      reason,
      status_code: statusCode,
      error_code: errorCode,
      error_evidence: buildVisionErrorEvidence(error, {
        reason,
        statusCode,
        timeoutMs,
        region,
        model,
      }),
    };
  }

  if (statusCode != null && statusCode >= 500) {
    const reason = VisionUnavailabilityReason.VISION_UPSTREAM_5XX;
    return {
      reason,
      status_code: statusCode,
      error_code: errorCode,
      error_evidence: buildVisionErrorEvidence(error, {
        reason,
        statusCode,
        timeoutMs,
        region,
        model,
      }),
    };
  }

  if (statusCode != null && statusCode >= 400) {
    const reason = containsImageInvalidHint(text)
      ? VisionUnavailabilityReason.VISION_IMAGE_INVALID
      : VisionUnavailabilityReason.VISION_UPSTREAM_4XX;
    return {
      reason,
      status_code: statusCode,
      error_code: errorCode,
      error_evidence: buildVisionErrorEvidence(error, {
        reason,
        statusCode,
        timeoutMs,
        region,
        model,
      }),
    };
  }

  if (/clienterror|invalid argument|permission denied|unauthenticated|forbidden/.test(text)) {
    const reason = containsImageInvalidHint(text)
      ? VisionUnavailabilityReason.VISION_IMAGE_INVALID
      : VisionUnavailabilityReason.VISION_UPSTREAM_4XX;
    return {
      reason,
      status_code: statusCode,
      error_code: errorCode,
      error_evidence: buildVisionErrorEvidence(error, {
        reason,
        statusCode,
        timeoutMs,
        region,
        model,
      }),
    };
  }

  if (containsImageInvalidHint(text)) {
    const reason = VisionUnavailabilityReason.VISION_IMAGE_INVALID;
    return {
      reason,
      status_code: statusCode,
      error_code: errorCode,
      error_evidence: buildVisionErrorEvidence(error, {
        reason,
        statusCode,
        timeoutMs,
        region,
        model,
      }),
    };
  }
  if (/servererror|backend error|service unavailable|upstream unavailable/.test(text)) {
    const reason = VisionUnavailabilityReason.VISION_UPSTREAM_5XX;
    return {
      reason,
      status_code: statusCode,
      error_code: errorCode,
      error_evidence: buildVisionErrorEvidence(error, {
        reason,
        statusCode,
        timeoutMs,
        region,
        model,
      }),
    };
  }

  const reason = VisionUnavailabilityReason.VISION_UNKNOWN;
  return {
    reason,
    status_code: statusCode,
    error_code: errorCode,
    error_evidence: buildVisionErrorEvidence(error, {
      reason,
      statusCode,
      timeoutMs,
      region,
      model,
    }),
  };
}

async function executeVisionWithRetry({
  operation,
  maxRetries = 2,
  baseDelayMs = 250,
  classifyError = classifyVisionProviderFailure,
  errorContext,
} = {}) {
  if (typeof operation !== 'function') {
    throw new Error('executeVisionWithRetry requires an operation function');
  }

  const retriesLimit = Math.max(0, Math.min(5, Number.isFinite(Number(maxRetries)) ? Math.trunc(Number(maxRetries)) : 2));
  const delayBase = Math.max(20, Math.min(3000, Number.isFinite(Number(baseDelayMs)) ? Math.trunc(Number(baseDelayMs)) : 250));

  let retriesAttempted = 0;
  let lastReason = VisionUnavailabilityReason.VISION_UNKNOWN;
  let lastStatusCode = null;
  let lastErrorCode = null;
  let lastErrorEvidence = null;

  for (let attempt = 0; attempt <= retriesLimit; attempt += 1) {
    try {
      const result = await operation({ attempt: attempt + 1, retries_attempted: retriesAttempted });
      return {
        ok: true,
        result,
        retry: {
          attempted: retriesAttempted,
          final: 'success',
          last_reason: null,
        },
      };
    } catch (error) {
      const mapped = classifyError(error, errorContext && typeof errorContext === 'object' ? errorContext : {});
      lastReason = normalizeVisionReason(mapped && mapped.reason);
      lastStatusCode = mapped && Number.isFinite(Number(mapped.status_code)) ? Math.trunc(Number(mapped.status_code)) : null;
      lastErrorCode = mapped && mapped.error_code ? String(mapped.error_code) : null;
      lastErrorEvidence = mapped && mapped.error_evidence && typeof mapped.error_evidence === 'object' ? mapped.error_evidence : null;

      if (!shouldRetryVision(lastReason) || attempt >= retriesLimit) {
        break;
      }

      const backoffMs = Math.min(5000, delayBase * (2 ** retriesAttempted));
      retriesAttempted += 1;
      await sleep(backoffMs);
    }
  }

  return {
    ok: false,
    reason: lastReason,
    upstream_status_code: lastStatusCode,
    error_code: lastErrorCode,
    error_evidence: lastErrorEvidence,
    retry: {
      attempted: retriesAttempted,
      final: 'fail',
      last_reason: lastReason,
    },
  };
}

function pickPrimaryVisionReason(reasons) {
  const list = Array.isArray(reasons) ? reasons : [];
  for (const raw of list) {
    const normalized = normalizeVisionFailureReason(raw);
    if (!normalized) continue;
    if (VISION_FAILURE_REASONS.has(normalized)) return normalized;
  }
  return null;
}

function buildVisionPhotoNotice({ reason, language } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const normalized = normalizeVisionFailureReason(reason);
  if (!normalized) return null;

  if (
    normalized === VisionUnavailabilityReason.VISION_MISSING_KEY ||
    normalized === VisionUnavailabilityReason.VISION_DISABLED_BY_FLAG ||
    normalized === VisionUnavailabilityReason.VISION_SCHEMA_INVALID
  ) {
    return lang === 'CN'
      ? '照片分析暂时不可用，我会先用简化的照片检查结果。'
      : 'Photo analysis is temporarily unavailable. We will use a simpler photo check for now.';
  }

  if (
    normalized === VisionUnavailabilityReason.VISION_TIMEOUT ||
    normalized === VisionUnavailabilityReason.VISION_UPSTREAM_5XX
  ) {
    return lang === 'CN'
      ? '照片分析当前响应较慢，请稍后再试。'
      : 'Photo analysis is taking too long right now. Please try again in a moment.';
  }

  if (
    normalized === VisionUnavailabilityReason.VISION_RATE_LIMITED ||
    normalized === VisionUnavailabilityReason.VISION_QUOTA_EXCEEDED
  ) {
    return lang === 'CN'
      ? '照片分析当前较繁忙，请稍后重试。'
      : 'Photo analysis is busy right now. Please try later.';
  }

  if (
    normalized === VisionUnavailabilityReason.VISION_IMAGE_INVALID ||
    normalized === VisionUnavailabilityReason.VISION_UPSTREAM_4XX ||
    normalized === VisionUnavailabilityReason.VISION_IMAGE_FETCH_FAILED
  ) {
    return lang === 'CN'
      ? '这张照片暂时无法处理，请重新上传清晰、无滤镜的照片。'
      : 'We could not process this photo. Please re-upload a clear, unfiltered photo.';
  }

  if (normalized === VisionUnavailabilityReason.VISION_UNKNOWN) {
    return lang === 'CN'
      ? '照片分析暂时不可用，请稍后重试。'
      : 'Photo analysis is temporarily unavailable. Please try again shortly.';
  }

  return null;
}

module.exports = {
  VisionUnavailabilityReason,
  VISION_FAILURE_REASONS,
  normalizeVisionReason,
  normalizeVisionFailureReason,
  isVisionFailureReason,
  shouldRetryVision,
  classifyVisionAvailability,
  classifyVisionProviderFailure,
  executeVisionWithRetry,
  pickPrimaryVisionReason,
  buildVisionPhotoNotice,
  containsImageInvalidHint,
};
