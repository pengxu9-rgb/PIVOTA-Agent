const crypto = require('crypto');

function loadAwsSdk() {
  try {
    // Lazy-load so dry-runs and tests can use the planner without storage config.
    // eslint-disable-next-line global-require
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    return { S3Client, PutObjectCommand };
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
  return {
    key,
    cached_url: `${trimTrailingSlashes(publicBase)}/${key}`,
  };
}

module.exports = {
  buildCatalogImageCacheKey,
  extFromContentType,
  hasCatalogImageCacheConfig,
  putCatalogImageCacheObject,
  sha256Buffer,
};
