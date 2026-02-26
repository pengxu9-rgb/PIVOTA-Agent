const test = require('node:test');
const assert = require('node:assert/strict');

const axios = require('axios');
const sharp = require('sharp');
const ROUTES_MODULE_PATH = require.resolve('../src/auroraBff/routes');

function withEnv(overrides, fn) {
  const prev = {};
  for (const key of Object.keys(overrides || {})) {
    prev[key] = process.env[key];
    const next = overrides[key];
    if (next === undefined || next === null) delete process.env[key];
    else process.env[key] = String(next);
  }
  const restore = () => {
    for (const key of Object.keys(overrides || {})) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
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

function loadRoutesFresh() {
  delete require.cache[ROUTES_MODULE_PATH];
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require('../src/auroraBff/routes');
}

function isProductsSearchUrl(url) {
  const target = String(url || '');
  return target.includes('/agent/v1/products/search') || target.includes('/agent/v1/beauty/products/search');
}

async function invokeRoute(app, method, routePath, { headers = {}, body = {}, query = {} } = {}) {
  const m = String(method || '').toLowerCase();
  const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
  const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
  if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

  const req = {
    method: String(method || '').toUpperCase(),
    path: routePath,
    body,
    query,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
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

  const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
  for (const fn of handlers) {
    // eslint-disable-next-line no-await-in-loop
    await fn(req, res, () => {});
    if (res.headersSent) break;
  }
  return { status: res.statusCode, body: res.body };
}

function getCard(body, type) {
  const cards = Array.isArray(body && body.cards) ? body.cards : [];
  return cards.find((c) => c && c.type === type) || null;
}

function makeHeatmapValues(w, h) {
  const out = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const base = (x + y) / Math.max(1, (w - 1) + (h - 1));
      out.push(Math.max(0, Math.min(1, base)));
    }
  }
  return out;
}

async function buildQualityPassPhotoBuffer() {
  const width = 128;
  const height = 128;
  const raw = Buffer.alloc(width * height * 3, 0);
  const skinA = [190, 140, 120];
  const skinB = [170, 120, 100];
  const bg = [35, 35, 35];
  const x0 = 20;
  const x1 = 107;
  const y0 = 16;
  const y1 = 111;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 3;
      const inFace = x >= x0 && x <= x1 && y >= y0 && y <= y1;
      const color = inFace ? (((x + y) % 8) < 4 ? skinA : skinB) : bg;
      raw[idx] = color[0];
      raw[idx + 1] = color[1];
      raw[idx + 2] = color[2];
    }
  }

  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

function makeVisionAnalysisFixture() {
  return {
    features: [
      { feature: 'redness', severity: 2, observation: 'Mild cheek redness.' },
      { feature: 'barrier', severity: 2, observation: 'Barrier looks slightly stressed.' },
    ],
    strategy: 'Keep routine simple and barrier-first.',
    ask_3_questions: ['Do you feel stinging after cleansing?', 'Any new active in last 7 days?', 'How is daytime UV exposure?'],
    confidence: { score: 0.78, level: 'medium' },
    photo_findings: [
      {
        finding_id: 'pf_redness_1',
        issue_type: 'redness',
        severity: 3,
        confidence: 0.86,
        geometry: {
          bbox: { x: 0.2, y: 0.24, w: 0.28, h: 0.22 },
          polygon: {
            points: [
              { x: 0.2, y: 0.24 },
              { x: 0.48, y: 0.24 },
              { x: 0.48, y: 0.46 },
              { x: 0.2, y: 0.46 },
            ],
          },
          heatmap: {
            grid: { w: 8, h: 8 },
            values: makeHeatmapValues(8, 8),
          },
        },
      },
    ],
  };
}

function buildRecoChatBody() {
  return {
    action: {
      action_id: 'chip.start.reco_products',
      kind: 'chip',
      data: {
        reply_text: 'Get product recommendations',
        profile_patch: {
          skinType: 'oily',
          sensitivity: 'low',
          barrierStatus: 'healthy',
          goals: ['acne'],
        },
      },
    },
    client_state: 'IDLE_CHAT',
    session: { state: 'idle' },
    language: 'EN',
  };
}

test('photo full chain e2e: presign -> confirm -> analysis -> chat recommendation contract', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_DECISION_BASE_URL: '',
      AURORA_SKIN_VISION_ENABLED: 'true',
      AURORA_SKIN_FORCE_VISION_CALL: 'true',
      AURORA_ANALYSIS_STORY_V2_ENABLED: 'true',
      DIAG_PHOTO_MODULES_CARD: 'true',
      DIAG_PRODUCT_REC: 'true',
      AURORA_PRODUCT_MATCHER_ENABLED: 'false',
      AURORA_BFF_RECO_CATALOG_GROUNDED: 'true',
      AURORA_BFF_RECO_CATALOG_QUERIES: 'winona soothing repair serum',
      AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_ENRICH_MAX_NETWORK_ITEMS: '4',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalGet = axios.get;
      const originalPost = axios.post;
      const auroraUid = 'photo_chain_uid';
      let routes = null;

      axios.get = async (url, config = {}) => {
        if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
        const q = String(config && config.params && config.params.query ? config.params.query : '').trim() || 'fallback';
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: `prod_${q.replace(/[^a-z0-9]+/gi, '_').toLowerCase().slice(0, 24) || 'fallback'}`,
                merchant_id: 'mid_test',
                brand: 'TestBrand',
                name: q,
                display_name: `TestBrand ${q}`,
                category: 'serum',
              },
            ],
          },
        };
      };
      axios.post = async (url) => {
        if (String(url).includes('/agent/shop/v1/invoke')) {
          return {
            status: 200,
            data: {
              status: 'error',
              reason: 'no_candidates',
              reason_code: 'no_candidates',
            },
          };
        }
        if (String(url).includes('/agent/v1/products/resolve')) {
          return {
            status: 200,
            data: {
              resolved: true,
              product_ref: {
                product_id: 'prod_resolved',
                merchant_id: 'mid_test',
              },
              reason_code: null,
            },
          };
        }
        throw new Error(`Unexpected axios.post: ${url}`);
      };

      try {
        const express = require('express');
        routes = loadRoutesFresh();
        routes.__internal.__setVisionRunnersForTest({
          gemini: async () => ({
            ok: true,
            provider: 'gemini',
            analysis: makeVisionAnalysisFixture(),
            upstream_status_code: null,
            latency_ms: 12,
            retry: { attempted: 0, final: 'success', last_reason: null },
          }),
        });

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        routes.mountAuroraBffRoutes(app, { logger: null });

        const commonHeaders = {
          'X-Aurora-UID': auroraUid,
          'X-Trace-ID': 'photo_chain_trace',
          'X-Brief-ID': 'photo_chain_brief',
        };
        const photoBuffer = await buildQualityPassPhotoBuffer();

        const presign = await invokeRoute(app, 'POST', '/v1/photos/presign', {
          headers: commonHeaders,
          body: {
            slot_id: 'daylight',
            content_type: 'image/png',
            bytes: photoBuffer.length,
          },
        });
        assert.equal(presign.status, 200);
        const presignCard = getCard(presign.body, 'photo_presign');
        assert.ok(presignCard);
        const photoId = presignCard && presignCard.payload ? String(presignCard.payload.photo_id || '') : '';
        assert.ok(photoId);

        routes.__internal.setPhotoBytesCache({
          photoId,
          auroraUid,
          buffer: photoBuffer,
          contentType: 'image/png',
        });

        const confirm = await invokeRoute(app, 'POST', '/v1/photos/confirm', {
          headers: commonHeaders,
          body: {
            photo_id: photoId,
            slot_id: 'daylight',
          },
        });
        assert.equal(confirm.status, 200);
        assert.ok(getCard(confirm.body, 'photo_confirm'));

        const analysis = await invokeRoute(app, 'POST', '/v1/analysis/skin', {
          headers: commonHeaders,
          body: {
            use_photo: true,
            photos: [{ photo_id: photoId, slot_id: 'daylight', qc_status: 'passed' }],
          },
        });
        assert.equal(analysis.status, 200);
        const analysisSummary = getCard(analysis.body, 'analysis_summary');
        const photoModules = getCard(analysis.body, 'photo_modules_v1');
        const story = getCard(analysis.body, 'analysis_story_v2');
        assert.ok(analysisSummary);
        assert.ok(photoModules);
        assert.ok(story);

        assert.equal(Boolean(analysisSummary.payload && analysisSummary.payload.used_photos), true);
        const qualityGrade = String(
          analysisSummary.payload &&
            analysisSummary.payload.quality_report &&
            analysisSummary.payload.quality_report.photo_quality &&
            analysisSummary.payload.quality_report.photo_quality.grade
            ? analysisSummary.payload.quality_report.photo_quality.grade
            : '',
        )
          .trim()
          .toLowerCase();
        assert.equal(qualityGrade === 'pass' || qualityGrade === 'degraded', true);

        const regions = Array.isArray(photoModules.payload && photoModules.payload.regions) ? photoModules.payload.regions : [];
        const availableCount = Number(photoModules.payload && photoModules.payload.regions_available_count || 0);
        const unavailableCount = Number(photoModules.payload && photoModules.payload.regions_unavailable_count || 0);
        assert.equal(availableCount + unavailableCount, regions.length);
        assert.equal(availableCount + unavailableCount > 0, true);

        const modules = Array.isArray(photoModules.payload && photoModules.payload.modules) ? photoModules.payload.modules : [];
        for (const module of modules) {
          const actions = Array.isArray(module && module.actions) ? module.actions : [];
          for (const action of actions) {
            const products = Array.isArray(action && action.products) ? action.products : [];
            const ctas = Array.isArray(action && action.external_search_ctas) ? action.external_search_ctas : [];
            const emptyReason = String(action && action.products_empty_reason || '').trim();
            assert.equal(products.length > 0 || (emptyReason.length > 0 && ctas.length > 0), true);

            for (const row of products) {
              assert.equal(typeof row.retrieval_source, 'string');
              assert.equal(row.retrieval_source.length > 0, true);
              assert.equal(typeof row.retrieval_reason, 'string');
              assert.equal(row.retrieval_reason.length > 0, true);
            }
          }
        }

        const uiCard = story.payload && story.payload.ui_card_v1 ? story.payload.ui_card_v1 : {};
        for (const key of ['headline', 'key_points', 'actions_now', 'avoid_now', 'confidence_label', 'next_checkin']) {
          assert.equal(Object.prototype.hasOwnProperty.call(uiCard, key), true);
        }
        assert.equal(Array.isArray(uiCard.key_points), true);
        assert.equal(Array.isArray(uiCard.actions_now), true);
        assert.equal(Array.isArray(uiCard.avoid_now), true);

        const chat = await invokeRoute(app, 'POST', '/v1/chat', {
          headers: commonHeaders,
          body: buildRecoChatBody(),
        });
        assert.equal(chat.status, 200);
        const recoCard = getCard(chat.body, 'recommendations');
        assert.ok(recoCard);

        const recommendations = Array.isArray(recoCard.payload && recoCard.payload.recommendations)
          ? recoCard.payload.recommendations
          : [];
        if (recommendations.length > 0) {
          for (const row of recommendations) {
            const url = String(
              (row && (row.pdp_url || row.url || row.product_url || row.purchase_path)) || '',
            )
              .trim()
              .toLowerCase();
            assert.equal(/^https:\/\//.test(url), true);
            assert.equal(url.includes('google.com/search'), false);
          }
        } else {
          const emptyReason = String(recoCard.payload && recoCard.payload.products_empty_reason || '').trim();
          assert.equal(emptyReason.length > 0, true);
          const fieldMissing = Array.isArray(recoCard.field_missing) ? recoCard.field_missing : [];
          assert.equal(fieldMissing.length > 0, true);
        }
      } finally {
        if (routes && routes.__internal) {
          routes.__internal.__resetVisionRunnersForTest();
        }
        axios.get = originalGet;
        axios.post = originalPost;
      }
    },
  );
});
