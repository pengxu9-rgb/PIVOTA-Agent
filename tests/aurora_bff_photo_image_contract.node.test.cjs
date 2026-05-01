const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

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

function loadRoutes() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  return { moduleId, ...require('../src/auroraBff/routes') };
}

async function invokeRoute(app, method, routePath, { headers = {}, body = {}, query = {} } = {}) {
  const normalizedMethod = String(method || '').toLowerCase();
  const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
  const layer = stack.find(
    (entry) => entry && entry.route && entry.route.path === routePath && entry.route.methods && entry.route.methods[normalizedMethod],
  );
  if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);
  const req = {
    method: String(method || '').toUpperCase(),
    path: routePath,
    body,
    query,
    headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
    get(name) {
      return this.headers[String(name || '').toLowerCase()] || '';
    },
  };
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name || '').toLowerCase()] = value;
    },
    header(name, value) {
      this.setHeader(name, value);
      return this;
    },
    set(name, value) {
      this.setHeader(name, value);
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
    send(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
  };
  const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((entry) => entry && entry.handle).filter(Boolean) : [];
  for (const handler of handlers) {
    // eslint-disable-next-line no-await-in-loop
    await handler(req, res, () => {});
    if (res.headersSent) break;
  }
  return { status: res.statusCode, body: res.body, headers: res.headers };
}

function makeApp(mountAuroraBffRoutes) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, {
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
  });
  return app;
}

test('/v1/chat: image attachments return explicit unsupported image contract, not generic 400', async () => {
  await withEnv(
    {
      PIVOT_BEAUTY_CONTRACT_V1_ENABLED: 'true',
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
    },
    async () => {
      const { moduleId, mountAuroraBffRoutes } = loadRoutes();
      try {
        const app = makeApp(mountAuroraBffRoutes);
        const resp = await invokeRoute(app, 'POST', '/v1/chat', {
          headers: { 'X-Aurora-UID': 'uid_chat_image_contract', 'X-Lang': 'CN' },
          body: {
            message: '我上传了一张护肤品瓶身图片，帮我识别并推荐替代品',
            photos: [{ photo_id: 'product_photo_1', type: 'image/jpeg' }],
          },
        });
        assert.equal(resp.status, 200);
        assert.equal(resp.body?.status, 'failed');
        assert.match(resp.body?.assistant_message?.content || '', /不能.*产品图片|不能.*图片/);
        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        assert.equal(cards.some((card) => card && card.type === 'confidence_notice'), true);
        assert.equal(resp.body?.session_patch?.meta?.fallback_adopted, false);
      } finally {
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/product/analyze: image-only product input is degraded unsupported, not success unknown', async () => {
  await withEnv(
    {
      PIVOT_BEAUTY_CONTRACT_V1_ENABLED: 'true',
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
    },
    async () => {
      const { moduleId, mountAuroraBffRoutes } = loadRoutes();
      try {
        const app = makeApp(mountAuroraBffRoutes);
        const resp = await invokeRoute(app, 'POST', '/v1/product/analyze', {
          headers: { 'X-Aurora-UID': 'uid_product_image_contract', 'X-Lang': 'CN' },
          body: {
            name: '我上传了一张护肤品瓶身图片，可以识别吗？',
            product: { image_url: 'https://example.com/bottle.jpg' },
            profile_context: { skin_type: 'dry sensitive' },
          },
        });
        assert.equal(resp.status, 200);
        assert.equal(resp.body?.status, 'degraded');
        assert.match(resp.body?.assistant_message?.content || '', /不能.*产品图片|图片/);
        const productCard = (Array.isArray(resp.body?.cards) ? resp.body.cards : []).find((card) => card && card.type === 'product_analysis');
        assert.ok(productCard);
        assert.ok((productCard.payload?.missing_info || []).includes('product_image_ocr_not_supported'));
      } finally {
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/photos/presign: backend timeout exposes stage-specific timeout code', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
    },
    async () => {
      const axios = require('axios');
      const originalPost = axios.post;
      const { moduleId, mountAuroraBffRoutes } = loadRoutes();
      axios.post = async (...args) => {
        const [url] = args;
        if (String(url).endsWith('/photos/presign')) {
          const err = new Error('timeout of 12000ms exceeded');
          err.code = 'ECONNABORTED';
          throw err;
        }
        return originalPost.apply(axios, args);
      };
      try {
        const app = makeApp(mountAuroraBffRoutes);
        const resp = await invokeRoute(app, 'POST', '/v1/photos/presign', {
          headers: { 'X-Aurora-UID': 'uid_photo_presign_timeout', 'X-Lang': 'EN' },
          body: { slot_id: 'daylight', content_type: 'image/jpeg', bytes: 1024 },
        });
        assert.equal(resp.status, 504);
        const errorCard = (Array.isArray(resp.body?.cards) ? resp.body.cards : []).find((card) => card && card.type === 'error');
        assert.equal(errorCard?.payload?.error, 'PHOTO_PRESIGN_REQUEST_TIMEOUT');
        assert.equal(errorCard?.payload?.stage, 'presign_request');
      } finally {
        axios.post = originalPost;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/photos/upload: presign timeout exposes stage-specific timeout code', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
    },
    async () => {
      const axios = require('axios');
      const originalPost = axios.post;
      const { moduleId, mountAuroraBffRoutes } = loadRoutes();
      axios.post = async (...args) => {
        const [url] = args;
        if (String(url).endsWith('/photos/presign')) {
          const err = new Error('timeout of 12000ms exceeded');
          err.code = 'ECONNABORTED';
          throw err;
        }
        return originalPost.apply(axios, args);
      };
      try {
        const app = makeApp(mountAuroraBffRoutes);
        const resp = await supertest(app)
          .post('/v1/photos/upload')
          .set({ 'X-Aurora-UID': 'uid_photo_upload_timeout', 'X-Lang': 'EN' })
          .field('slot_id', 'daylight')
          .field('consent', 'true')
          .attach('photo', Buffer.from('not-real-image-but-valid-upload-body'), {
            filename: 'face.jpg',
            contentType: 'image/jpeg',
          })
          .expect(504);
        const errorCard = (Array.isArray(resp.body?.cards) ? resp.body.cards : []).find((card) => card && card.type === 'error');
        assert.equal(errorCard?.payload?.error, 'PHOTO_PRESIGN_REQUEST_TIMEOUT');
        assert.equal(errorCard?.payload?.stage, 'presign_request');
      } finally {
        axios.post = originalPost;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/analysis/skin: photo download timeout fails fast before report model', async () => {
  await withEnv(
    {
      PIVOT_BEAUTY_CONTRACT_V1_ENABLED: 'true',
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_SKIN_FORCE_VISION_CALL: 'true',
      AURORA_PHOTO_DOWNLOAD_URL_RETRIES: '0',
      AURORA_PHOTO_DOWNLOAD_URL_TIMEOUT_MS: '80',
      AURORA_PHOTO_FETCH_RETRIES: '0',
      AURORA_PHOTO_FETCH_TOTAL_TIMEOUT_MS: '200',
      AURORA_PHOTO_FETCH_TIMEOUT_MS: '80',
      AURORA_PHOTO_ANALYSIS_READ_FAIL_FAST_MS: '80',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      const originalPost = axios.post;
      const { moduleId, mountAuroraBffRoutes } = loadRoutes();
      axios.get = async (...args) => {
        const [url] = args;
        if (String(url).endsWith('/photos/download-url')) {
          return new Promise(() => {});
        }
        return originalGet.apply(axios, args);
      };
      axios.post = async (url) => {
        throw new Error(`Unexpected axios.post in fail-fast test: ${String(url)}`);
      };
      try {
        const app = makeApp(mountAuroraBffRoutes);
        const started = Date.now();
        const resp = await invokeRoute(app, 'POST', '/v1/analysis/skin', {
          headers: { 'X-Aurora-UID': 'uid_photo_analysis_fast_fail', 'X-Lang': 'CN' },
          body: {
            use_photo: true,
            photos: [{ slot_id: 'daylight', photo_id: 'photo_timeout_fast_fail', qc_status: 'passed' }],
            currentRoutine: {
              am: { cleanser: '温和洁面', spf: 'SPF50' },
              pm: { cleanser: '温和洁面', moisturizer: '修护霜' },
            },
          },
        });
        const elapsedMs = Date.now() - started;
        assert.equal(resp.status, 200);
        assert.equal(resp.body?.status, 'failed');
        assert.equal(resp.body?.analysis_meta?.degrade_reason, 'photo_read_failed_fast_fail');
        assert.equal(resp.body?.analysis_meta?.llm_report_called, false);
        assert.ok(elapsedMs < 1500, `expected fail-fast under 1500ms, got ${elapsedMs}ms`);
        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        assert.equal(cards.some((card) => card && card.type === 'analysis_summary'), true);
        assert.equal(cards.some((card) => card && card.type === 'confidence_notice'), true);
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/analysis/skin: degraded photo QC is not counted as successful photo analysis', async () => {
  await withEnv(
    {
      PIVOT_BEAUTY_CONTRACT_V1_ENABLED: 'true',
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_SKIN_FORCE_VISION_CALL: 'true',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      const originalPost = axios.post;
      const { moduleId, mountAuroraBffRoutes } = loadRoutes();
      axios.get = async (url) => {
        throw new Error(`Unexpected axios.get for degraded QC contract test: ${String(url)}`);
      };
      axios.post = async (url) => {
        throw new Error(`Unexpected axios.post for degraded QC contract test: ${String(url)}`);
      };
      try {
        const app = makeApp(mountAuroraBffRoutes);
        const resp = await invokeRoute(app, 'POST', '/v1/analysis/skin', {
          headers: { 'X-Aurora-UID': 'uid_photo_analysis_qc_degraded', 'X-Lang': 'CN' },
          body: {
            use_photo: true,
            photos: [{ slot_id: 'daylight', photo_id: 'photo_qc_degraded_contract', qc_status: 'degraded' }],
            currentRoutine: {
              am: { cleanser: '温和洁面', spf: 'SPF50' },
              pm: { cleanser: '温和洁面', moisturizer: '修护霜' },
            },
          },
        });
        assert.equal(resp.status, 200);
        assert.equal(resp.body?.status, 'failed');
        assert.equal(resp.body?.analysis_meta?.failure_class, 'PHOTO_QC_DEGRADED');
        assert.equal(resp.body?.session_patch?.meta?.fallback_attempted, true);
        assert.equal(resp.body?.session_patch?.meta?.fallback_adopted, false);
        const summaryCard = (Array.isArray(resp.body?.cards) ? resp.body.cards : []).find((card) => card && card.type === 'analysis_summary');
        assert.equal(summaryCard?.payload?.used_photos, false);
        assert.match(resp.body?.assistant_message?.content || '', /PHOTO_QC_DEGRADED|不会把这次照片分析包装成成功/);
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
        delete require.cache[moduleId];
      }
    },
  );
});
