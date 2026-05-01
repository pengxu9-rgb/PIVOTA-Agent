const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const photoBackendClient = require('../src/photoBackendClient');

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides || {})) {
    previous[key] = process.env[key];
    const next = overrides[key];
    if (next === undefined || next === null) delete process.env[key];
    else process.env[key] = String(next);
  }
  const restore = () => {
    for (const key of Object.keys(overrides || {})) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
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

function loadServerFresh() {
  delete require.cache[require.resolve('../src/server')];
  return require('../src/server');
}

test('/photos/presign proxy uses photo backend base URL and agent-key auth contract', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://photo-backend.example.com/',
      PIVOTA_API_BASE: 'https://wrong-service.example.com',
      PIVOTA_API_KEY: 'agent_key_for_photo_proxy',
    },
    async () => {
      const app = loadServerFresh();
      const originalProxy = photoBackendClient.proxyPhotoBackendRequest;
      let captured = null;
      photoBackendClient.proxyPhotoBackendRequest = async (args) => {
        captured = args;
        return { status: 200, data: { proxied: true } };
      };

      try {
        const resp = await request(app)
          .post('/photos/presign')
          .send({ content_type: 'image/png', bytes: 1234 })
          .expect(200);

        assert.deepEqual(resp.body, { proxied: true });
        assert.equal(captured.baseUrl, 'https://photo-backend.example.com');
        assert.equal(captured.path, '/photos/presign');
        assert.equal(captured.method, 'POST');
        assert.equal(captured.timeoutMs, 15000);
        assert.equal(captured.authHeaders['X-Agent-API-Key'], 'agent_key_for_photo_proxy');
        assert.equal(captured.authHeaders['X-API-Key'], 'agent_key_for_photo_proxy');
        assert.equal(captured.authHeaders.Authorization, 'Bearer agent_key_for_photo_proxy');
        assert.deepEqual(captured.data, { content_type: 'image/png', bytes: 1234 });
      } finally {
        photoBackendClient.proxyPhotoBackendRequest = originalProxy;
        delete require.cache[require.resolve('../src/server')];
      }
    },
  );
});

test('/photos/download-url proxy supports GET and POST through the same backend contract', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://photo-backend.example.com/',
      PIVOTA_API_BASE: 'https://wrong-service.example.com',
      PIVOTA_API_KEY: 'agent_key_for_photo_proxy',
    },
    async () => {
      const app = loadServerFresh();
      const originalProxy = photoBackendClient.proxyPhotoBackendRequest;
      const calls = [];
      photoBackendClient.proxyPhotoBackendRequest = async (args) => {
        calls.push(args);
        return { status: 200, data: { download: { url: 'https://signed.example.com/photo' } } };
      };

      try {
        await request(app).get('/photos/download-url?upload_id=upl_1').expect(200);
        await request(app).post('/photos/download-url').send({ upload_id: 'upl_1' }).expect(200);

        assert.equal(calls.length, 2);
        assert.equal(calls[0].method, 'GET');
        assert.equal(calls[0].path, '/photos/download-url');
        assert.deepEqual(calls[0].params, { upload_id: 'upl_1' });
        assert.equal(calls[1].method, 'POST');
        assert.equal(calls[1].path, '/photos/download-url');
        assert.deepEqual(calls[1].data, { upload_id: 'upl_1' });
      } finally {
        photoBackendClient.proxyPhotoBackendRequest = originalProxy;
        delete require.cache[require.resolve('../src/server')];
      }
    },
  );
});
