const crypto = require('crypto');

function loadAwsSdk() {
  try {
    // Lazy-load so dry-runs and tests can use the planner without storage config.
    // eslint-disable-next-line global-require
    const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
    return { S3Client, GetObjectCommand, PutObjectCommand };
  } catch (err) {
    const e = new Error('AWS SDK not installed (need @aws-sdk/client-s3)');
    e.code = 'CONFIG_MISSING';
    throw e;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    const err = new Error(`${name} not configured`);
    err.code = 'CONFIG_MISSING';
    throw err;
  }
  return value;
}

function trimTrailingSlashes(value) {
  return String(value || '').replace(/\/+$/, '');
}

function extFromContentType(contentType) {
  const normalized = String(contentType || '').toLowerCase();
  if (normalized.includes('image/avif')) return 'avif';
  if (normalized.includes('image/webp')) return 'webp';
  if (normalized.includes('image/png')) return 'png';
  if (normalized.includes('image/jpeg') || normalized.includes('image/jpg')) return 'jpg';
  if (normalized.includes('image/gif')) return 'gif';
  return 'bin';
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function buildCatalogImageCacheKey({ sha256, contentType }) {
  const digest = String(sha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    const err = new Error('sha256 must be a lowercase hex digest');
    err.code = 'INVALID_SHA256';
    throw err;
  }
  const ext = extFromContentType(contentType);
  return `catalog-image-cache/${digest.slice(0, 2)}/${digest}.${ext}`;
}

function parseBooleanEnv(name, fallback = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function normalizeCatalogImageCacheKey(value) {
  const normalized = String(value || '').trim().replace(/^\/+/, '');
  if (!/^catalog-image-cache\/[a-f0-9]{2}\/[a-f0-9]{64}\.(avif|webp|png|jpe?g|gif|bin)$/i.test(normalized)) {
    return '';
  }
  return normalized;
}

function extractCatalogImageCacheKeyFromUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const direct = normalizeCatalogImageCacheKey(raw);
  if (direct) return direct;
  try {
    const parsed = new URL(raw);
    return normalizeCatalogImageCacheKey(parsed.pathname);
  } catch {
    return '';
  }
}

function getCatalogImageCacheRuntimePublicBaseUrl() {
  return trimTrailingSlashes(
    process.env.CATALOG_IMAGE_CACHE_PROXY_PUBLIC_BASE_URL ||
      process.env.CATALOG_IMAGE_CACHE_RUNTIME_PUBLIC_BASE_URL ||
      process.env.PIVOTA_AGENT_PUBLIC_BASE_URL ||
      'https://pivota-agent-production.up.railway.app',
  );
}

function shouldUseCatalogImageCacheRuntimeProxy(cachedUrl = '') {
  if (parseBooleanEnv('CATALOG_IMAGE_CACHE_DISABLE_RUNTIME_PROXY', false)) return false;
  if (parseBooleanEnv('CATALOG_IMAGE_CACHE_USE_RUNTIME_PROXY', false)) return true;
  const publicBase = trimTrailingSlashes(process.env.CATALOG_IMAGE_CACHE_PUBLIC_BASE_URL || '');
  if (!publicBase) return false;
  try {
    const host = new URL(publicBase).hostname.toLowerCase();
    if (host.endsWith('.r2.dev')) return true;
  } catch {
    // Ignore malformed optional public bases.
  }
  try {
    const host = new URL(cachedUrl).hostname.toLowerCase();
    return host.endsWith('.r2.dev');
  } catch {
    return false;
  }
}

function buildCatalogImageCacheVisibleUrl({ key, cachedUrl } = {}) {
  const normalizedKey = normalizeCatalogImageCacheKey(key) || extractCatalogImageCacheKeyFromUrl(cachedUrl);
  if (!normalizedKey) return cachedUrl || '';
  const proxyBase = getCatalogImageCacheRuntimePublicBaseUrl();
  if (proxyBase && shouldUseCatalogImageCacheRuntimeProxy(cachedUrl)) {
    return `${proxyBase}/${normalizedKey}`;
  }
  if (cachedUrl) return cachedUrl;
  const publicBase = trimTrailingSlashes(process.env.CATALOG_IMAGE_CACHE_PUBLIC_BASE_URL || '');
  return publicBase ? `${publicBase}/${normalizedKey}` : '';
}

let cachedClient = null;

function getClient() {
  if (cachedClient) return cachedClient;
  const { S3Client } = loadAwsSdk();
  cachedClient = new S3Client({
    endpoint: requiredEnv('CATALOG_IMAGE_CACHE_S3_ENDPOINT'),
    region: process.env.CATALOG_IMAGE_CACHE_S3_REGION || 'auto',
    credentials: {
      accessKeyId: requiredEnv('CATALOG_IMAGE_CACHE_S3_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnv('CATALOG_IMAGE_CACHE_S3_SECRET_ACCESS_KEY'),
    },
  });
  return cachedClient;
}

function hasCatalogImageCacheConfig() {
  return Boolean(
    process.env.CATALOG_IMAGE_CACHE_S3_ENDPOINT &&
      process.env.CATALOG_IMAGE_CACHE_S3_BUCKET &&
      process.env.CATALOG_IMAGE_CACHE_S3_ACCESS_KEY_ID &&
      process.env.CATALOG_IMAGE_CACHE_S3_SECRET_ACCESS_KEY &&
      process.env.CATALOG_IMAGE_CACHE_PUBLIC_BASE_URL,
  );
}

async function putCatalogImageCacheObject({ body, contentType, sha256, cacheControl }) {
  const { PutObjectCommand } = loadAwsSdk();
  const bucket = requiredEnv('CATALOG_IMAGE_CACHE_S3_BUCKET');
  const publicBase = requiredEnv('CATALOG_IMAGE_CACHE_PUBLIC_BASE_URL');
  const key = buildCatalogImageCacheKey({ sha256, contentType });
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
    CacheControl: cacheControl || 'public, max-age=31536000, immutable',
  });
  await getClient().send(cmd);
  const publicCachedUrl = `${trimTrailingSlashes(publicBase)}/${key}`;
  return {
    key,
    cached_url: buildCatalogImageCacheVisibleUrl({ key, cachedUrl: publicCachedUrl }),
    storage_url: publicCachedUrl,
  };
}

async function getCatalogImageCacheObject(key) {
  const normalizedKey = normalizeCatalogImageCacheKey(key);
  if (!normalizedKey) {
    const err = new Error('Invalid catalog image cache key');
    err.code = 'INVALID_CACHE_KEY';
    throw err;
  }
  const { GetObjectCommand } = loadAwsSdk();
  const bucket = requiredEnv('CATALOG_IMAGE_CACHE_S3_BUCKET');
  return getClient().send(new GetObjectCommand({ Bucket: bucket, Key: normalizedKey }));
}

module.exports = {
  buildCatalogImageCacheKey,
  buildCatalogImageCacheVisibleUrl,
  extFromContentType,
  extractCatalogImageCacheKeyFromUrl,
  getCatalogImageCacheObject,
  hasCatalogImageCacheConfig,
  normalizeCatalogImageCacheKey,
  putCatalogImageCacheObject,
  sha256Buffer,
};
