const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

function withEnv(patch, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(patch || {})) {
    prev[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }

  const restore = () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
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

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

async function makeTinyPngBuffer() {
  return sharp({
    create: {
      width: 96,
      height: 96,
      channels: 3,
      background: { r: 214, g: 178, b: 160 },
    },
  })
    .png()
    .toBuffer();
}

test('photo_modules render fallback: keeps existing URL and marks existing source', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: undefined,
      PIVOTA_BACKEND_AGENT_API_KEY: undefined,
    },
    async () => {
      const { moduleId, __internal } = loadRouteInternals();
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async () => {
        throw new Error('axios.get should not be called when face_crop already has URL');
      };

      try {
        const card = {
          payload: {
            face_crop: {
              original_image_url: 'https://existing.test/crop.jpg',
            },
          },
        };
        await __internal.ensurePhotoModulesRenderableFaceCrop({
          req: { get: () => '' },
          photoModulesCard: card,
          diagnosisPhotoBytes: Buffer.from('abc'),
          photoId: 'photo_existing',
          slotId: 'daylight',
          logger: null,
          requestId: 'req_existing',
        });

        assert.equal(card.payload.face_crop.original_image_url, 'https://existing.test/crop.jpg');
        assert.equal(card.payload.render_fallback?.attempted, true);
        assert.equal(card.payload.render_fallback?.source, 'existing');
        assert.equal(card.payload.render_fallback?.reason_code, 'ok_existing');
      } finally {
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('photo_modules render fallback: injects signed URL when available', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
    },
    async () => {
      const { moduleId, __internal } = loadRouteInternals();
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        const u = String(url || '');
        if (!u.endsWith('/photos/download-url')) throw new Error(`Unexpected axios.get url: ${u}`);
        return {
          status: 200,
          data: {
            download: {
              url: 'https://signed-download.test/renderable.jpg',
              expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
            },
          },
        };
      };

      try {
        const card = { payload: { face_crop: {} } };
        await __internal.ensurePhotoModulesRenderableFaceCrop({
          req: { get: () => '' },
          photoModulesCard: card,
          diagnosisPhotoBytes: null,
          photoId: 'photo_signed',
          slotId: 'daylight',
          logger: null,
          requestId: 'req_signed',
        });

        assert.equal(card.payload.face_crop.original_image_url, 'https://signed-download.test/renderable.jpg');
        assert.equal(card.payload.face_crop.source_image_url, 'https://signed-download.test/renderable.jpg');
        assert.equal(card.payload.face_crop.image_url, 'https://signed-download.test/renderable.jpg');
        assert.equal(card.payload.render_fallback?.attempted, true);
        assert.equal(card.payload.render_fallback?.source, 'signed_url');
        assert.equal(card.payload.render_fallback?.reason_code, 'ok_signed_url');
      } finally {
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('photo_modules render fallback: signed URL fails but inline preview succeeds', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
    },
    async () => {
      const { moduleId, __internal } = loadRouteInternals();
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        const u = String(url || '');
        if (!u.endsWith('/photos/download-url')) throw new Error(`Unexpected axios.get url: ${u}`);
        return { status: 500, data: { error: 'upstream failed' } };
      };

      try {
        const card = { payload: { face_crop: {} } };
        const pngBytes = await makeTinyPngBuffer();
        await __internal.ensurePhotoModulesRenderableFaceCrop({
          req: { get: () => '' },
          photoModulesCard: card,
          diagnosisPhotoBytes: pngBytes,
          photoId: 'photo_inline',
          slotId: 'daylight',
          logger: null,
          requestId: 'req_inline',
        });

        const url = String(card.payload.face_crop.original_image_url || '');
        assert.equal(url.startsWith('data:image/jpeg;base64,'), true);
        assert.equal(card.payload.render_fallback?.attempted, true);
        assert.equal(card.payload.render_fallback?.source, 'inline_preview');
        assert.equal(card.payload.render_fallback?.reason_code, 'ok_inline_preview');
      } finally {
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('photo_modules render fallback: keeps none when signed URL fails and no bytes', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
    },
    async () => {
      const { moduleId, __internal } = loadRouteInternals();
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        const u = String(url || '');
        if (!u.endsWith('/photos/download-url')) throw new Error(`Unexpected axios.get url: ${u}`);
        return { status: 500, data: { error: 'upstream failed' } };
      };

      try {
        const card = { payload: { face_crop: {} } };
        await __internal.ensurePhotoModulesRenderableFaceCrop({
          req: { get: () => '' },
          photoModulesCard: card,
          diagnosisPhotoBytes: null,
          photoId: 'photo_none',
          slotId: 'daylight',
          logger: null,
          requestId: 'req_none',
        });

        const renderable = __internal.getRenderableFaceCropUrl(card.payload.face_crop);
        assert.equal(renderable, '');
        assert.equal(card.payload.render_fallback?.attempted, true);
        assert.equal(card.payload.render_fallback?.source, 'none');
        assert.equal(card.payload.render_fallback?.reason_code, 'signed_url_failed');
      } finally {
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});
