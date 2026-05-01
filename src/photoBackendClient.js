const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const axios = require('axios');

function trimString(value) {
  return String(value == null ? '' : value).trim();
}

function resolvePhotoBackendBaseUrl(env = process.env) {
  return trimString(env.PIVOTA_BACKEND_BASE_URL || env.PIVOTA_API_BASE).replace(/\/+$/, '');
}

function fingerprintBaseUrl(baseUrl) {
  const value = trimString(baseUrl).replace(/\/+$/, '');
  if (!value) return null;
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function buildPhotoBackendAgentAuthHeaders(apiKey) {
  const token = trimString(apiKey);
  if (!token) return {};
  return {
    'X-Agent-API-Key': token,
    'X-API-Key': token,
    Authorization: `Bearer ${token}`,
  };
}

function augmentPhotoBackendAuthHeaders(headers = {}) {
  const out = { ...(headers && typeof headers === 'object' ? headers : {}) };
  const agentToken =
    trimString(out['X-Agent-API-Key'] || out['x-agent-api-key']) ||
    trimString(out['X-API-Key'] || out['x-api-key']) ||
    trimString(String(out.Authorization || out.authorization || '').replace(/^Bearer\s+/i, ''));
  if (agentToken) {
    out['X-Agent-API-Key'] = agentToken;
    out['X-API-Key'] = agentToken;
    if (!out.Authorization && !out.authorization) out.Authorization = `Bearer ${agentToken}`;
  }
  return out;
}

function pickUpstreamErrorDetail(data) {
  if (!data) return null;
  if (typeof data === 'string') return data.slice(0, 500);
  if (data.detail) return String(data.detail).slice(0, 500);
  if (data.error) return String(data.error).slice(0, 500);
  if (data.message) return String(data.message).slice(0, 500);
  return null;
}

function secondsUntilIso(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((ms - Date.now()) / 1000));
}

function isTimeoutError(err) {
  const code = trimString(err && err.code).toUpperCase();
  const message = trimString(err && err.message);
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(message);
}

function classifyPhotoBackendStatus({ stage, status, detail, code } = {}) {
  const stageToken = trimString(stage || 'photo_backend').toUpperCase();
  const statusNum = Number(status || 0);
  const errorCode = trimString(code).toUpperCase();
  const text = `${detail || ''} ${code || ''}`.toLowerCase();
  if (isTimeoutError({ code: errorCode, message: text }) || statusNum === 408) {
    if (stageToken === 'PHOTO_PRESIGN') return { failure_code: 'PHOTO_PRESIGN_REQUEST_TIMEOUT', retryable: true };
    if (stageToken === 'PHOTO_CONFIRM') return { failure_code: 'PHOTO_CONFIRM_REQUEST_TIMEOUT', retryable: true };
    if (stageToken === 'PHOTO_QC') return { failure_code: 'PHOTO_QC_REQUEST_TIMEOUT', retryable: true };
    return { failure_code: `${stageToken}_TIMEOUT`, retryable: true };
  }
  if (errorCode === 'ENOTFOUND' || errorCode === 'EAI_AGAIN' || errorCode === 'EAI_FAIL') {
    return { failure_code: `${stageToken}_DNS`, retryable: true };
  }
  if (statusNum === 401 || statusNum === 403) return { failure_code: `${stageToken}_UNAUTHORIZED`, retryable: false };
  if (statusNum === 404) return { failure_code: `${stageToken}_NOT_FOUND`, retryable: false };
  if (statusNum === 405 || /method\s+not\s+allowed/i.test(text)) {
    return { failure_code: `${stageToken}_METHOD_NOT_ALLOWED`, retryable: false };
  }
  if (statusNum === 429 || (statusNum >= 500 && statusNum < 600)) {
    return { failure_code: `${stageToken}_UPSTREAM_FAILED`, retryable: true };
  }
  if (statusNum >= 400 && statusNum < 500) return { failure_code: `${stageToken}_UPSTREAM_FAILED`, retryable: false };
  return { failure_code: `${stageToken}_FAILED`, retryable: true };
}

function buildFailure({ stage, baseUrl, status = null, detail = null, code = null, method = null, attemptedMethods = null } = {}) {
  const classified = classifyPhotoBackendStatus({ stage, status, detail, code });
  return {
    ok: false,
    reason: String(classified.failure_code || `${stage || 'photo_backend'}_failed`).toLowerCase(),
    failure_code: classified.failure_code,
    status,
    detail: detail || null,
    retryable: classified.retryable,
    method: method || null,
    attempted_methods: Array.isArray(attemptedMethods) ? attemptedMethods : method ? [method] : null,
    base_url_fingerprint: fingerprintBaseUrl(baseUrl),
  };
}

async function proxyPhotoBackendRequest({
  baseUrl,
  path,
  method = 'GET',
  authHeaders,
  headers,
  params,
  data,
  timeoutMs = 12000,
  axiosImpl = axios,
} = {}) {
  const normalizedBaseUrl = trimString(baseUrl).replace(/\/+$/, '');
  const normalizedPath = trimString(path).startsWith('/') ? trimString(path) : `/${trimString(path)}`;
  const normalizedMethod = trimString(method || 'GET').toUpperCase();
  if (!normalizedBaseUrl) {
    return buildFailure({ stage: 'PHOTO_BACKEND_BASE_URL', baseUrl: normalizedBaseUrl, detail: 'photo_backend_base_url_missing' });
  }
  try {
    const resp = await axiosImpl({
      method: normalizedMethod,
      url: `${normalizedBaseUrl}${normalizedPath}`,
      headers: {
        ...(normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD' && normalizedMethod !== 'DELETE'
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(headers || {}),
        ...augmentPhotoBackendAuthHeaders(authHeaders || {}),
      },
      timeout: timeoutMs,
      ...(normalizedMethod === 'GET' || normalizedMethod === 'DELETE' ? { params } : { data }),
      validateStatus: () => true,
    });
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      data: resp.data,
      detail: resp.status >= 200 && resp.status < 300 ? null : pickUpstreamErrorDetail(resp.data),
      base_url_fingerprint: fingerprintBaseUrl(normalizedBaseUrl),
    };
  } catch (err) {
    return buildFailure({
      stage: 'PHOTO_BACKEND_PROXY',
      baseUrl: normalizedBaseUrl,
      detail: err && (err.code || err.message) ? String(err.code || err.message) : null,
      code: err && err.code,
    });
  }
}

async function requestPhotoPresign({
  baseUrl,
  authHeaders,
  contentType = 'image/jpeg',
  byteSize = null,
  userId,
  timeoutMs = 12000,
  axiosImpl = axios,
} = {}) {
  const normalizedBaseUrl = trimString(baseUrl).replace(/\/+$/, '');
  let resp = null;
  try {
    resp = await axiosImpl.post(
      `${normalizedBaseUrl}/photos/presign`,
      {
        content_type: contentType || 'image/jpeg',
        ...(Number.isFinite(Number(byteSize)) && Number(byteSize) > 0 ? { byte_size: Number(byteSize) } : {}),
        consent: true,
        ...(trimString(userId) ? { user_id: trimString(userId) } : {}),
      },
      {
        timeout: timeoutMs,
        validateStatus: () => true,
        headers: { 'Content-Type': 'application/json', ...augmentPhotoBackendAuthHeaders(authHeaders || {}) },
      },
    );
  } catch (err) {
    return buildFailure({
      stage: 'PHOTO_PRESIGN',
      baseUrl: normalizedBaseUrl,
      detail: err && (err.code || err.message) ? String(err.code || err.message) : null,
      code: err && err.code,
      method: 'post',
    });
  }
  if (!resp || resp.status !== 200) {
    return buildFailure({
      stage: 'PHOTO_PRESIGN',
      baseUrl: normalizedBaseUrl,
      status: resp && resp.status,
      detail: pickUpstreamErrorDetail(resp && resp.data),
      method: 'post',
    });
  }
  const uploadId = trimString(resp.data && resp.data.upload_id);
  const upload = resp.data && resp.data.upload && typeof resp.data.upload === 'object' ? resp.data.upload : null;
  if (!uploadId || !upload) {
    return buildFailure({
      stage: 'PHOTO_PRESIGN',
      baseUrl: normalizedBaseUrl,
      status: resp.status,
      detail: 'upstream_missing_upload_id_or_upload',
      method: 'post',
    });
  }
  return {
    ok: true,
    status: resp.status,
    upload_id: uploadId,
    upload,
    expires_in_seconds: secondsUntilIso(resp.data && resp.data.expires_at) ?? 900,
    data: resp.data,
    base_url_fingerprint: fingerprintBaseUrl(normalizedBaseUrl),
  };
}

async function requestPhotoConfirm({ baseUrl, authHeaders, uploadId, byteSize = null, timeoutMs = 12000, axiosImpl = axios } = {}) {
  const normalizedBaseUrl = trimString(baseUrl).replace(/\/+$/, '');
  let resp = null;
  try {
    resp = await axiosImpl.post(
      `${normalizedBaseUrl}/photos/confirm`,
      {
        upload_id: uploadId,
        ...(Number.isFinite(Number(byteSize)) && Number(byteSize) > 0 ? { byte_size: Number(byteSize) } : {}),
      },
      {
        timeout: timeoutMs,
        validateStatus: () => true,
        headers: { 'Content-Type': 'application/json', ...augmentPhotoBackendAuthHeaders(authHeaders || {}) },
      },
    );
  } catch (err) {
    return buildFailure({
      stage: 'PHOTO_CONFIRM',
      baseUrl: normalizedBaseUrl,
      detail: err && (err.code || err.message) ? String(err.code || err.message) : null,
      code: err && err.code,
      method: 'post',
    });
  }
  if (!resp || resp.status !== 200) {
    return buildFailure({
      stage: 'PHOTO_CONFIRM',
      baseUrl: normalizedBaseUrl,
      status: resp && resp.status,
      detail: pickUpstreamErrorDetail(resp && resp.data),
      method: 'post',
    });
  }
  return {
    ok: true,
    status: resp.status,
    data: resp.data,
    base_url_fingerprint: fingerprintBaseUrl(normalizedBaseUrl),
  };
}

async function requestPhotoQc({ baseUrl, authHeaders, uploadId, timeoutMs = 12000, axiosImpl = axios } = {}) {
  const normalizedBaseUrl = trimString(baseUrl).replace(/\/+$/, '');
  let resp = null;
  try {
    resp = await axiosImpl.get(`${normalizedBaseUrl}/photos/qc`, {
      timeout: timeoutMs,
      validateStatus: () => true,
      headers: augmentPhotoBackendAuthHeaders(authHeaders || {}),
      params: { upload_id: uploadId },
    });
  } catch (err) {
    return buildFailure({
      stage: 'PHOTO_QC',
      baseUrl: normalizedBaseUrl,
      detail: err && (err.code || err.message) ? String(err.code || err.message) : null,
      code: err && err.code,
      method: 'get',
    });
  }
  if (!resp || resp.status !== 200) {
    return buildFailure({
      stage: 'PHOTO_QC',
      baseUrl: normalizedBaseUrl,
      status: resp && resp.status,
      detail: pickUpstreamErrorDetail(resp && resp.data),
      method: 'get',
    });
  }
  return {
    ok: true,
    status: resp.status,
    data: resp.data,
    base_url_fingerprint: fingerprintBaseUrl(normalizedBaseUrl),
  };
}

function parseDownloadUrlResponse(resp, { baseUrl, method, attemptedMethods } = {}) {
  const download = resp && resp.data && resp.data.download ? resp.data.download : null;
  const downloadUrl = download && typeof download.url === 'string' ? download.url.trim() : '';
  if (!resp || resp.status !== 200 || !downloadUrl) {
    return buildFailure({
      stage: 'PHOTO_DOWNLOAD_URL',
      baseUrl,
      status: resp && resp.status,
      detail: pickUpstreamErrorDetail(resp && resp.data),
      method,
      attemptedMethods,
    });
  }
  return {
    ok: true,
    status: resp.status,
    data: resp.data,
    download,
    downloadUrl,
    method,
    attempted_methods: attemptedMethods || [method],
    base_url_fingerprint: fingerprintBaseUrl(baseUrl),
  };
}

async function requestPhotoDownloadUrlWithMethod({ baseUrl, authHeaders, uploadId, method, timeoutMs = 5000, axiosImpl = axios } = {}) {
  const normalizedBaseUrl = trimString(baseUrl).replace(/\/+$/, '');
  const url = `${normalizedBaseUrl}/photos/download-url`;
  try {
    const resp =
      method === 'post'
        ? await axiosImpl.post(
            url,
            { upload_id: uploadId },
            {
              timeout: timeoutMs,
              validateStatus: () => true,
              headers: augmentPhotoBackendAuthHeaders(authHeaders || {}),
              params: { upload_id: uploadId },
            },
          )
        : await axiosImpl.get(url, {
            timeout: timeoutMs,
            validateStatus: () => true,
            headers: augmentPhotoBackendAuthHeaders(authHeaders || {}),
            params: { upload_id: uploadId },
          });
    return parseDownloadUrlResponse(resp, { baseUrl: normalizedBaseUrl, method });
  } catch (err) {
    return buildFailure({
      stage: 'PHOTO_DOWNLOAD_URL',
      baseUrl: normalizedBaseUrl,
      detail: err && (err.code || err.message) ? String(err.code || err.message) : null,
      code: err && err.code,
      method,
    });
  }
}

async function requestPhotoDownloadUrl({ baseUrl, authHeaders, uploadId, timeoutMs = 5000, axiosImpl = axios } = {}) {
  const getAttempt = await requestPhotoDownloadUrlWithMethod({
    baseUrl,
    authHeaders,
    uploadId,
    method: 'get',
    timeoutMs,
    axiosImpl,
  });
  if (getAttempt && (getAttempt.ok || Number(getAttempt.status || 0) !== 405)) return getAttempt;
  const postAttempt = await requestPhotoDownloadUrlWithMethod({
    baseUrl,
    authHeaders,
    uploadId,
    method: 'post',
    timeoutMs,
    axiosImpl,
  });
  const attemptedMethods = ['get', 'post'];
  if (postAttempt && postAttempt.ok) return { ...postAttempt, attempted_methods: attemptedMethods };
  return {
    ...(postAttempt || getAttempt),
    attempted_methods: attemptedMethods,
    method: postAttempt && postAttempt.method ? postAttempt.method : 'post',
  };
}

function isPrivateIpAddress(address) {
  const ip = trimString(address).toLowerCase();
  const version = net.isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  if (version === 6) {
    if (ip === '::1' || ip === '::') return true;
    if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;
    const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIpAddress(mapped[1]);
    return false;
  }
  return true;
}

async function validatePublicHttpsImageUrl(imageUrl, { lookup = dns.promises.lookup } = {}) {
  let parsed = null;
  try {
    parsed = new URL(trimString(imageUrl));
  } catch (_err) {
    return { ok: false, failure_code: 'IMAGE_URL_INVALID', detail: 'invalid_url' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, failure_code: 'IMAGE_URL_INVALID_SCHEME', detail: 'https_required' };
  if (parsed.username || parsed.password) return { ok: false, failure_code: 'IMAGE_URL_INVALID', detail: 'credentials_not_allowed' };
  if (parsed.port && parsed.port !== '443') return { ok: false, failure_code: 'IMAGE_URL_BLOCKED', detail: 'non_default_port_blocked' };
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { ok: false, failure_code: 'IMAGE_URL_BLOCKED', detail: 'localhost_blocked' };
  }
  if (net.isIP(hostname) && isPrivateIpAddress(hostname)) {
    return { ok: false, failure_code: 'IMAGE_URL_BLOCKED', detail: 'private_ip_blocked' };
  }
  try {
    const rows = await lookup(hostname, { all: true, verbatim: true });
    const list = Array.isArray(rows) ? rows : [rows];
    if (!list.length) return { ok: false, failure_code: 'IMAGE_URL_DNS', detail: 'dns_empty' };
    if (list.some((row) => isPrivateIpAddress(row && row.address))) {
      return { ok: false, failure_code: 'IMAGE_URL_BLOCKED', detail: 'private_dns_blocked' };
    }
  } catch (err) {
    return { ok: false, failure_code: 'IMAGE_URL_DNS', detail: err && (err.code || err.message) ? String(err.code || err.message) : null };
  }
  return { ok: true, url: parsed.toString() };
}

function makePublicImageLookup(lookup = dns.promises.lookup) {
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options ? options : {};
    Promise.resolve(lookup(hostname, { ...opts, all: true, verbatim: true }))
      .then((rows) => {
        const list = Array.isArray(rows) ? rows : [rows];
        if (!list.length) {
          const err = new Error('IMAGE_URL_DNS_EMPTY');
          err.code = 'IMAGE_URL_DNS';
          cb(err);
          return;
        }
        if (list.some((row) => isPrivateIpAddress(row && row.address))) {
          const err = new Error('IMAGE_URL_PRIVATE_DNS_BLOCKED');
          err.code = 'IMAGE_URL_BLOCKED';
          cb(err);
          return;
        }
        if (opts.all) {
          cb(null, list);
          return;
        }
        const first = list[0];
        cb(null, first.address, first.family || net.isIP(first.address));
      })
      .catch((err) => cb(err));
  };
}

async function fetchExternalImageUrlBytes({
  imageUrl,
  timeoutMs = 3000,
  totalTimeoutMs = 5000,
  maxBytes = 15 * 1024 * 1024,
  maxRedirects = 3,
  axiosImpl = axios,
  lookup = dns.promises.lookup,
} = {}) {
  const startedAt = Date.now();
  let currentUrl = trimString(imageUrl);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const validation = await validatePublicHttpsImageUrl(currentUrl, { lookup });
    if (!validation.ok) {
      return { ok: false, reason: String(validation.failure_code || 'image_url_blocked').toLowerCase(), ...validation };
    }
    const elapsed = Date.now() - startedAt;
    const remaining = totalTimeoutMs - elapsed;
    if (remaining <= 0) {
      return { ok: false, reason: 'image_url_timeout', failure_code: 'IMAGE_URL_TIMEOUT', detail: 'image_url_total_timeout' };
    }
    try {
      const resp = await axiosImpl.get(validation.url, {
        timeout: Math.min(timeoutMs, remaining),
        responseType: 'arraybuffer',
        validateStatus: () => true,
        maxRedirects: 0,
        maxBodyLength: maxBytes,
        maxContentLength: maxBytes,
        lookup: makePublicImageLookup(lookup),
      });
      if (resp.status >= 300 && resp.status < 400 && resp.headers && resp.headers.location) {
        currentUrl = new URL(String(resp.headers.location), validation.url).toString();
        continue;
      }
      if (resp.status < 200 || resp.status >= 300) {
        return {
          ok: false,
          reason: resp.status >= 500 ? 'image_url_fetch_5xx' : 'image_url_fetch_4xx',
          failure_code: resp.status >= 500 ? 'IMAGE_URL_FETCH_5XX' : 'IMAGE_URL_FETCH_4XX',
          status: resp.status,
          detail: pickUpstreamErrorDetail(resp.data),
        };
      }
      const contentType = trimString(resp.headers && (resp.headers['content-type'] || resp.headers['Content-Type'])).toLowerCase();
      if (!contentType.startsWith('image/')) {
        return { ok: false, reason: 'image_url_non_image', failure_code: 'IMAGE_URL_NON_IMAGE', status: resp.status, detail: contentType || null };
      }
      const buffer = Buffer.from(resp.data || []);
      if (!buffer.length) return { ok: false, reason: 'image_url_empty', failure_code: 'IMAGE_URL_EMPTY', status: resp.status };
      if (buffer.length > maxBytes) {
        return { ok: false, reason: 'image_url_too_large', failure_code: 'IMAGE_URL_TOO_LARGE', status: resp.status };
      }
      return {
        ok: true,
        buffer,
        contentType,
        source: 'image_url',
        image_url: validation.url,
      };
    } catch (err) {
      const errText = `${err && err.code ? err.code : ''} ${err && err.message ? err.message : ''}`;
      if (/maxContentLength|maxBodyLength|max content length|max body length/i.test(errText)) {
        return {
          ok: false,
          reason: 'image_url_too_large',
          failure_code: 'IMAGE_URL_TOO_LARGE',
          status: null,
          detail: trimString(errText).slice(0, 160) || null,
        };
      }
      return {
        ok: false,
        reason: isTimeoutError(err) ? 'image_url_timeout' : 'image_url_fetch_failed',
        failure_code: isTimeoutError(err) ? 'IMAGE_URL_TIMEOUT' : 'IMAGE_URL_FETCH_FAILED',
        status: null,
        detail: err && (err.code || err.message) ? String(err.code || err.message) : null,
      };
    }
  }
  return { ok: false, reason: 'image_url_redirect_loop', failure_code: 'IMAGE_URL_REDIRECT_LOOP' };
}

module.exports = {
  resolvePhotoBackendBaseUrl,
  fingerprintBaseUrl,
  buildPhotoBackendAgentAuthHeaders,
  augmentPhotoBackendAuthHeaders,
  pickUpstreamErrorDetail,
  classifyPhotoBackendStatus,
  proxyPhotoBackendRequest,
  requestPhotoPresign,
  requestPhotoConfirm,
  requestPhotoQc,
  requestPhotoDownloadUrl,
  fetchExternalImageUrlBytes,
  validatePublicHttpsImageUrl,
  isPrivateIpAddress,
};
