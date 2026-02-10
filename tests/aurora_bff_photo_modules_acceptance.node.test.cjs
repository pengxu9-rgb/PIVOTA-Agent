const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
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

async function makeSyntheticFaceLikePng() {
  return sharp({
    create: {
      width: 320,
      height: 320,
      channels: 3,
      background: { r: 214, g: 178, b: 160 },
    },
  })
    .composite([
      {
        input: {
          create: {
            width: 180,
            height: 80,
            channels: 3,
            background: { r: 205, g: 168, b: 151 },
          },
        },
        left: 70,
        top: 50,
        blend: 'over',
      },
      {
        input: {
          create: {
            width: 220,
            height: 120,
            channels: 3,
            background: { r: 198, g: 159, b: 142 },
          },
        },
        left: 50,
        top: 150,
        blend: 'over',
      },
    ])
    .png()
    .toBuffer();
}

function findRouteHandler(app, method, routePath) {
  const stack = Array.isArray(app?._router?.stack) ? app._router.stack : [];
  for (const layer of stack) {
    const route = layer && layer.route;
    if (!route || route.path !== routePath) continue;
    if (!route.methods || route.methods[method] !== true) continue;
    const routeStack = Array.isArray(route.stack) ? route.stack : [];
    if (!routeStack.length) continue;
    const leaf = routeStack[routeStack.length - 1];
    if (leaf && typeof leaf.handle === 'function') return leaf.handle;
  }
  return null;
}

async function invokeJsonRoute(app, { method, routePath, headers, body }) {
  const httpMethod = String(method || 'post').toLowerCase();
  const handler = findRouteHandler(app, httpMethod, routePath);
  assert.ok(handler, `Route handler not found: ${httpMethod.toUpperCase()} ${routePath}`);

  const normalizedHeaders = Object.entries(headers || {}).reduce((acc, [key, value]) => {
    acc[String(key).toLowerCase()] = String(value);
    return acc;
  }, {});

  return new Promise((resolve, reject) => {
    const req = {
      method: httpMethod.toUpperCase(),
      path: routePath,
      url: routePath,
      originalUrl: routePath,
      headers: normalizedHeaders,
      body: body || {},
      query: {},
      params: {},
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      get(name) {
        return normalizedHeaders[String(name || '').toLowerCase()];
      },
      header(name) {
        return this.get(name);
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      locals: {},
      setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = value;
      },
      getHeader(name) {
        return this.headers[String(name).toLowerCase()];
      },
      set(name, value) {
        this.setHeader(name, value);
        return this;
      },
      status(code) {
        this.statusCode = Number(code) || 200;
        return this;
      },
      json(payload) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      send(payload) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };

    Promise.resolve(handler(req, res, (err) => (err ? reject(err) : undefined))).catch(reject);
  });
}

test('/v1/analysis/skin acceptance: emits valid photo_modules_v1 payload without server overlay fields', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_SKIN_VISION_ENABLED: 'false',
      DIAG_PHOTO_MODULES_CARD: 'true',
      DIAG_OVERLAY_MODE: 'client',
      DIAG_INGREDIENT_REC: 'true',
      DIAG_PRODUCT_REC: 'false',
    },
    async () => {
      const skinLlmPolicyModuleId = require.resolve('../src/auroraBff/skinLlmPolicy');
      delete require.cache[skinLlmPolicyModuleId];
      const skinLlmPolicy = require('../src/auroraBff/skinLlmPolicy');
      const originalClassifyPhotoQuality = skinLlmPolicy.classifyPhotoQuality;
      skinLlmPolicy.classifyPhotoQuality = (...args) => {
        const out = originalClassifyPhotoQuality(...args);
        const base = out && typeof out === 'object' ? out : {};
        const reasons = Array.isArray(base.reasons) ? base.reasons : [];
        return {
          ...base,
          grade: 'degraded',
          reasons: Array.from(new Set([...reasons, 'acceptance_forced_degraded'])),
        };
      };

      const skinDiagnosisModuleId = require.resolve('../src/auroraBff/skinDiagnosisV1');
      delete require.cache[skinDiagnosisModuleId];
      const skinDiagnosis = require('../src/auroraBff/skinDiagnosisV1');
      const originalRunSkinDiagnosisV1 = skinDiagnosis.runSkinDiagnosisV1;
      const originalBuildSkinAnalysisFromDiagnosisV1 = skinDiagnosis.buildSkinAnalysisFromDiagnosisV1;
      const syntheticFinding = {
        finding_id: 'acceptance_finding_1',
        issue_type: 'redness',
        severity: 3,
        confidence: 0.9,
        evidence: 'synthetic acceptance finding',
        geometry: {
          bbox_norm: { x0: 0.2, y0: 0.3, x1: 0.62, y1: 0.58 },
          type: 'grid',
          rows: 64,
          cols: 64,
          values: Array.from({ length: 64 * 64 }, () => 0.45),
        },
      };

      skinDiagnosis.buildSkinAnalysisFromDiagnosisV1 = (...args) => {
        const out = originalBuildSkinAnalysisFromDiagnosisV1(...args);
        const base = out && typeof out === 'object' ? out : {};
        const existingPhotoFindings = Array.isArray(base.photo_findings) ? base.photo_findings : [];
        const hasHeatmapFinding = existingPhotoFindings.some(
          (finding) => finding && finding.geometry && finding.geometry.heatmap,
        );
        if (hasHeatmapFinding && existingPhotoFindings.length) return out;
        return {
          ...base,
          photo_findings: [...existingPhotoFindings, syntheticFinding],
        };
      };

      skinDiagnosis.runSkinDiagnosisV1 = async (...args) => {
        const out = await originalRunSkinDiagnosisV1(...args);
        if (!out || !out.ok || !out.diagnosis || typeof out.diagnosis !== 'object') return out;
        const currentQuality = out.diagnosis.quality && typeof out.diagnosis.quality === 'object' ? out.diagnosis.quality : null;
        const currentGrade = String(currentQuality?.grade || '').toLowerCase();
        if (currentGrade === 'fail') {
          out.diagnosis = {
            ...out.diagnosis,
            quality: {
              ...currentQuality,
              grade: 'degraded',
              reasons: Array.from(new Set([...(Array.isArray(currentQuality?.reasons) ? currentQuality.reasons : []), 'forced_degraded'])),
            },
          };
        }
        return out;
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
      const axios = require('axios');

      const originalGet = axios.get;
      const originalPost = axios.post;
      const originalRequest = axios.request;
      const pngBytes = await makeSyntheticFaceLikePng();

      axios.post = async (url) => {
        throw new Error(`Unexpected axios.post url: ${url}`);
      };

      axios.request = async (config) => {
        throw new Error(`Unexpected axios.request url: ${config?.url || ''}`);
      };

      axios.get = async (url) => {
        const u = String(url || '');
        if (u.endsWith('/photos/download-url')) {
          return {
            status: 200,
            data: {
              download: {
                url: 'https://signed-download.test/object',
                expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
              },
              content_type: 'image/png',
            },
          };
        }
        if (u === 'https://signed-download.test/object') {
          return {
            status: 200,
            data: pngBytes,
            headers: { 'content-type': 'image/png' },
          };
        }
        if (u.endsWith('/photos/qc')) {
          return {
            status: 200,
            data: { qc_status: 'passed', qc: { state: 'done', qc_status: 'passed' } },
          };
        }
        throw new Error(`Unexpected axios.get url: ${u}`);
      };

      try {
        const app = express();
        mountAuroraBffRoutes(app, { logger: null });

        const headers = {
          'X-Aurora-UID': 'uid_photo_modules_acceptance',
          'X-Trace-ID': 'trace_photo_modules_acceptance',
          'X-Brief-ID': 'brief_photo_modules_acceptance',
          'X-Lang': 'EN',
        };

        const analysisResp = await invokeJsonRoute(app, {
          method: 'post',
          routePath: '/v1/analysis/skin',
          headers,
          body: {
            use_photo: true,
            currentRoutine: 'AM gentle cleanser + moisturizer + SPF; PM gentle cleanser + moisturizer',
            photos: [{ slot_id: 'daylight', photo_id: 'upl_photo_modules_acceptance', qc_status: 'passed' }],
          },
        });

        assert.equal(analysisResp.status, 200);
        const analysisCard = Array.isArray(analysisResp.body?.cards)
          ? analysisResp.body.cards.find((card) => card && card.type === 'analysis_summary')
          : null;
        assert.ok(analysisCard);
        assert.equal(analysisCard?.payload?.used_photos, true);

        const modulesCard = Array.isArray(analysisResp.body?.cards)
          ? analysisResp.body.cards.find((card) => card && card.type === 'photo_modules_v1')
          : null;
        assert.ok(modulesCard, 'Expected photo_modules_v1 card for used_photos=true with quality pass/degraded');

        const payload = modulesCard.payload || {};
        assert.equal(payload.used_photos, true);

        const regions = Array.isArray(payload.regions) ? payload.regions : [];
        assert.ok(regions.length > 0, 'photo_modules_v1.regions should not be empty');
        const regionIds = new Set();
        for (const region of regions) {
          const regionId = String(region.region_id || '');
          assert.ok(regionId.length > 0, 'region_id is required');
          assert.equal(regionIds.has(regionId), false, `region_id must be unique: ${regionId}`);
          regionIds.add(regionId);
          assert.equal(region.coord_space, 'face_crop_norm_v1');
          if (region.heatmap) {
            assert.equal(Number(region.heatmap?.grid?.w), 64);
            assert.equal(Number(region.heatmap?.grid?.h), 64);
            assert.equal(Array.isArray(region.heatmap?.values), true);
            assert.equal(region.heatmap.values.length, 64 * 64);
            const range = region.heatmap?.value_range || {};
            assert.equal(Number(range.min), 0);
            assert.equal(Number(range.max), 1);
            assert.equal(
              region.heatmap.values.every((value) => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1),
              true,
              'heatmap.values must stay in [0,1]',
            );
          }
        }

        const modules = Array.isArray(payload.modules) ? payload.modules : [];
        for (const moduleEntry of modules) {
          const issues = Array.isArray(moduleEntry?.issues) ? moduleEntry.issues : [];
          for (const issue of issues) {
            const evidenceIds = Array.isArray(issue?.evidence_region_ids) ? issue.evidence_region_ids : [];
            for (const evidenceId of evidenceIds) {
              assert.equal(regionIds.has(String(evidenceId || '')), true, `evidence_region_id must map to region: ${evidenceId}`);
            }
          }
        }

        const serialized = JSON.stringify(payload).toLowerCase();
        assert.equal(serialized.includes('overlay_url'), false);
        assert.equal(serialized.includes('server_overlay'), false);
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
        axios.request = originalRequest;
        skinDiagnosis.runSkinDiagnosisV1 = originalRunSkinDiagnosisV1;
        skinDiagnosis.buildSkinAnalysisFromDiagnosisV1 = originalBuildSkinAnalysisFromDiagnosisV1;
        skinLlmPolicy.classifyPhotoQuality = originalClassifyPhotoQuality;
        delete require.cache[skinLlmPolicyModuleId];
        delete require.cache[skinDiagnosisModuleId];
        delete require.cache[moduleId];
      }
    },
  );
});
