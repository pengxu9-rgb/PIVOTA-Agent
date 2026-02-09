const VisionUnavailabilityReason = Object.freeze({
  VISION_MISSING_KEY: 'VISION_MISSING_KEY',
  VISION_DISABLED_BY_FLAG: 'VISION_DISABLED_BY_FLAG',
  VISION_RATE_LIMITED: 'VISION_RATE_LIMITED',
  VISION_QUOTA_EXCEEDED: 'VISION_QUOTA_EXCEEDED',
  VISION_TIMEOUT: 'VISION_TIMEOUT',
  VISION_UPSTREAM_4XX: 'VISION_UPSTREAM_4XX',
  VISION_UPSTREAM_5XX: 'VISION_UPSTREAM_5XX',
  VISION_SCHEMA_INVALID: 'VISION_SCHEMA_INVALID',
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

function classifyVisionProviderFailure(error) {
  const mappedFromExplicitReason = normalizeReasonToken(error && (error.__vision_reason || error.reason));
  if (mappedFromExplicitReason && mappedFromExplicitReason !== 'VISION_FAILED') {
    const reason = normalizeVisionReason(mappedFromExplicitReason);
    return {
      reason,
      status_code: toStatusCode(error),
      error_code: toErrorCode(error),
    };
  }

  const statusCode = toStatusCode(error);
  const errorCode = toErrorCode(error);
  const text = collectErrorText(error);

  if ((error && error.name === 'AbortError') || /timeout|timed out|econnaborted|etimedout/.test(text)) {
    return {
      reason: VisionUnavailabilityReason.VISION_TIMEOUT,
      status_code: statusCode,
      error_code: errorCode,
    };
  }

  if (statusCode === 429) {
    const quotaLike = /quota|insufficient[_\s-]?quota|billing|credit/.test(text);
    return {
      reason: quotaLike ? VisionUnavailabilityReason.VISION_QUOTA_EXCEEDED : VisionUnavailabilityReason.VISION_RATE_LIMITED,
      status_code: statusCode,
      error_code: errorCode,
    };
  }

  if (statusCode != null && statusCode >= 500) {
    return {
      reason: VisionUnavailabilityReason.VISION_UPSTREAM_5XX,
      status_code: statusCode,
      error_code: errorCode,
    };
  }

  if (statusCode != null && statusCode >= 400) {
    return {
      reason: VisionUnavailabilityReason.VISION_UPSTREAM_4XX,
      status_code: statusCode,
      error_code: errorCode,
    };
  }

  return {
    reason: VisionUnavailabilityReason.VISION_UNKNOWN,
    status_code: statusCode,
    error_code: errorCode,
  };
}

async function executeVisionWithRetry({
  operation,
  maxRetries = 2,
  baseDelayMs = 250,
  classifyError = classifyVisionProviderFailure,
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
      const mapped = classifyError(error);
      lastReason = normalizeVisionReason(mapped && mapped.reason);
      lastStatusCode = mapped && Number.isFinite(Number(mapped.status_code)) ? Math.trunc(Number(mapped.status_code)) : null;
      lastErrorCode = mapped && mapped.error_code ? String(mapped.error_code) : null;

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
};
