function loadAwsSdk() {
  try {
    // Lazy-load so the gateway can start even if optional deps aren't installed yet.
    // Railway/CI should install these via package.json.
    // eslint-disable-next-line global-require
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    // eslint-disable-next-line global-require
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    return { S3Client, PutObjectCommand, getSignedUrl };
  } catch (err) {
    const e = new Error('AWS SDK not installed (need @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner)');
    e.code = 'CONFIG_MISSING';
    throw e;
  }
}

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) {
    const err = new Error(`${name} not configured`);
    err.code = 'CONFIG_MISSING';
    throw err;
  }
  return v;
}

function trimSlashes(v) {
  return String(v || '').replace(/\/+$/, '');
}

function extFromContentType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('image/jpeg') || ct.includes('image/jpg')) return 'jpg';
  if (ct.includes('image/png')) return 'png';
  if (ct.includes('image/webp')) return 'webp';
  return 'bin';
}

let cachedClient = null;

function getClient() {
  if (cachedClient) return cachedClient;

  const { S3Client } = loadAwsSdk();
  const endpoint = requiredEnv('LOOK_REPLICATOR_S3_ENDPOINT');
  const region = process.env.LOOK_REPLICATOR_S3_REGION || 'auto';
  const accessKeyId = requiredEnv('LOOK_REPLICATOR_S3_ACCESS_KEY_ID');
  const secretAccessKey = requiredEnv('LOOK_REPLICATOR_S3_SECRET_ACCESS_KEY');

  cachedClient = new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
  return cachedClient;
}

function makeObjectKey({ kind, contentType }) {
  const date = new Date().toISOString().slice(0, 10);
  const ext = extFromContentType(contentType);
  const id = require('crypto').randomUUID();
  const safeKind = kind === 'selfie' ? 'selfie' : 'reference';
  return `look-replicator/${safeKind}/${date}/${id}.${ext}`;
}

async function createSignedUpload({ kind, contentType }) {
  const { PutObjectCommand, getSignedUrl } = loadAwsSdk();
  const bucket = requiredEnv('LOOK_REPLICATOR_S3_BUCKET');
  const publicBase = requiredEnv('LOOK_REPLICATOR_PUBLIC_ASSET_BASE_URL');
  const ttlSeconds = Number(process.env.LOOK_REPLICATOR_SIGNED_URL_TTL_SECONDS || '300');

  const key = makeObjectKey({ kind, contentType });
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(getClient(), cmd, { expiresIn: ttlSeconds });
  const publicUrl = `${trimSlashes(publicBase)}/${key}`;

  return {
    uploadUrl,
    publicUrl,
    method: 'PUT',
    headers: { 'Content-Type': contentType },
  };
}

module.exports = {
  createSignedUpload,
};
