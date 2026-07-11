const test = require('node:test');
const assert = require('node:assert/strict');

const photoBackendClient = require('../src/photoBackendClient');

test('photo backend client resolves base URL and emits agent key auth headers', () => {
  assert.equal(
    photoBackendClient.resolvePhotoBackendBaseUrl({
      PIVOTA_BACKEND_BASE_URL: 'https://backend.example.com/',
      PIVOTA_API_BASE: 'https://fallback.example.com',
    }),
    'https://backend.example.com',
  );
  assert.equal(
    photoBackendClient.resolvePhotoBackendBaseUrl({
      PIVOTA_BACKEND_BASE_URL: '',
      PIVOTA_API_BASE: 'https://fallback.example.com/',
    }),
    'https://fallback.example.com',
  );
  const headers = photoBackendClient.buildPhotoBackendAgentAuthHeaders('ak_live_test');
  assert.equal(headers['X-Agent-API-Key'], 'ak_live_test');
  assert.equal(headers['X-API-Key'], 'ak_live_test');
  assert.equal(headers.Authorization, 'Bearer ak_live_test');
});

test('photo backend presign maps timeout to stage-specific failure code', async () => {
  const axiosImpl = {
    async post() {
      const err = new Error('timeout of 12000ms exceeded');
      err.code = 'ECONNABORTED';
      throw err;
    },
  };
  const out = await photoBackendClient.requestPhotoPresign({
    baseUrl: 'https://backend.example.com',
    authHeaders: photoBackendClient.buildPhotoBackendAgentAuthHeaders('agent_key'),
    contentType: 'image/png',
    byteSize: 1024,
    userId: 'uid_test',
    axiosImpl,
  });
  assert.equal(out.ok, false);
  assert.equal(out.failure_code, 'PHOTO_PRESIGN_REQUEST_TIMEOUT');
  assert.equal(out.method, 'post');
  assert.equal(typeof out.base_url_fingerprint, 'string');
});

test('photo backend download-url probes POST only after GET 405', async () => {
  const calls = [];
  const axiosImpl = {
    async get(url) {
      calls.push(['get', url]);
      return { status: 405, data: { detail: 'Method Not Allowed' } };
    },
    async post(url, body) {
      calls.push(['post', url, body]);
      return {
        status: 200,
        data: { download: { url: 'https://signed.example.com/object' }, content_type: 'image/png' },
      };
    },
  };
  const out = await photoBackendClient.requestPhotoDownloadUrl({
    baseUrl: 'https://backend.example.com',
    authHeaders: photoBackendClient.buildPhotoBackendAgentAuthHeaders('agent_key'),
    uploadId: 'upl_1',
    axiosImpl,
  });
  assert.equal(out.ok, true);
  assert.equal(out.downloadUrl, 'https://signed.example.com/object');
  assert.deepEqual(out.attempted_methods, ['get', 'post']);
  assert.deepEqual(calls.map((row) => row[0]), ['get', 'post']);
  assert.equal(calls[1][2].upload_id, 'upl_1');
});

test('external image_url blocks private DNS and accepts public image response', async () => {
  const blocked = await photoBackendClient.fetchExternalImageUrlBytes({
    imageUrl: 'https://private.example.com/photo.png',
    lookup: async () => [{ address: '10.0.0.12', family: 4 }],
    axiosImpl: {
      async get() {
        throw new Error('should not fetch blocked private URL');
      },
    },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.failure_code, 'IMAGE_URL_BLOCKED');

  const accepted = await photoBackendClient.fetchExternalImageUrlBytes({
    imageUrl: 'https://cdn.example.com/photo.png',
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    axiosImpl: {
      async get() {
        return {
          status: 200,
          data: Buffer.from([1, 2, 3]),
          headers: { 'content-type': 'image/png' },
        };
      },
    },
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.source, 'image_url');
  assert.equal(accepted.contentType, 'image/png');
});

test('external image_url enforces content type, size, timeout, and safe download lookup', async () => {
  const nonImage = await photoBackendClient.fetchExternalImageUrlBytes({
    imageUrl: 'https://cdn.example.com/not-image',
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    axiosImpl: {
      async get() {
        return { status: 200, data: Buffer.from('ok'), headers: { 'content-type': 'text/html' } };
      },
    },
  });
  assert.equal(nonImage.ok, false);
  assert.equal(nonImage.failure_code, 'IMAGE_URL_NON_IMAGE');

  const oversize = await photoBackendClient.fetchExternalImageUrlBytes({
    imageUrl: 'https://cdn.example.com/large.png',
    maxBytes: 2,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    axiosImpl: {
      async get() {
        return { status: 200, data: Buffer.from([1, 2, 3]), headers: { 'content-type': 'image/png' } };
      },
    },
  });
  assert.equal(oversize.ok, false);
  assert.equal(oversize.failure_code, 'IMAGE_URL_TOO_LARGE');

  const timeout = await photoBackendClient.fetchExternalImageUrlBytes({
    imageUrl: 'https://cdn.example.com/slow.png',
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    axiosImpl: {
      async get() {
        const err = new Error('timeout of 3000ms exceeded');
        err.code = 'ECONNABORTED';
        throw err;
      },
    },
  });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.failure_code, 'IMAGE_URL_TIMEOUT');

  let sawSafeLookup = false;
  const safeLookupAccepted = await photoBackendClient.fetchExternalImageUrlBytes({
    imageUrl: 'https://cdn.example.com/photo.png',
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    axiosImpl: {
      async get(_url, opts) {
        await new Promise((resolve, reject) => {
          opts.lookup('cdn.example.com', {}, (err, address) => {
            if (err) reject(err);
            else {
              sawSafeLookup = address === '93.184.216.34';
              resolve();
            }
          });
        });
        return { status: 200, data: Buffer.from([1, 2, 3]), headers: { 'content-type': 'image/png' } };
      },
    },
  });
  assert.equal(safeLookupAccepted.ok, true);
  assert.equal(sawSafeLookup, true);
});
