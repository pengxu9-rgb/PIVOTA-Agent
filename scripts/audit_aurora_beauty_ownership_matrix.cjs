#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const axios = require('axios');
const sharp = require('sharp');

const ROUTES_MODULE_PATH = require.resolve('../src/auroraBff/routes');
const SKIN_DIAGNOSIS_MODULE_PATH = require.resolve('../src/auroraBff/skinDiagnosisV1');
const ROUTINE_ANALYSIS_MODULE_PATH = require.resolve('../src/auroraBff/routineAnalysisV2');

function parseArgs(argv) {
  const out = {
    jsonOut: '',
    mdOut: '',
    cases: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;
    if (token === '--json-out' && argv[i + 1]) {
      out.jsonOut = String(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--md-out' && argv[i + 1]) {
      out.mdOut = String(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--cases' && argv[i + 1]) {
      out.cases = String(argv[i + 1])
        .split(',')
        .map((item) => String(item || '').trim())
        .filter(Boolean);
      i += 1;
    }
  }
  return out;
}

function withEnv(overrides, fn) {
  const prev = {};
  for (const key of Object.keys(overrides || {})) {
    prev[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
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
  return require('../src/auroraBff/routes');
}

function invokeRoute(app, method, routePath, { headers = {}, body = {}, query = {} } = {}) {
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
  return handlers.reduce(
    (promise, fn) =>
      promise.then(async () => {
        if (res.headersSent) return;
        await fn(req, res, () => {});
      }),
    Promise.resolve(),
  ).then(() => ({ status: res.statusCode, body: res.body }));
}

function getCard(body, type) {
  const cards = Array.isArray(body && body.cards) ? body.cards : [];
  return cards.find((c) => c && c.type === type) || null;
}

function buildApp(routes) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  routes.mountAuroraBffRoutes(app, { logger: null });
  return app;
}

function makeHeaders(seed) {
  const base = String(seed || 'case').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return {
    'X-Aurora-UID': `uid_${base}`,
    'X-Trace-ID': `trace_${base}`,
    'X-Brief-ID': `brief_${base}`,
    'X-Lang': 'EN',
  };
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

function buildRecoChatBody(latestRecoContext = null) {
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
    session: {
      state: {
        latest_reco_context: latestRecoContext || undefined,
      },
    },
    language: 'EN',
  };
}

function pickAssistantText(envelope) {
  return envelope && envelope.assistant_message && typeof envelope.assistant_message.content === 'string'
    ? envelope.assistant_message.content
    : '';
}

function buildCaseEntry({ caseId, route, status, envelope, routes }) {
  const assistantText = pickAssistantText(envelope);
  const audit = routes.__internal.buildBeautyCanonicalOwnershipAudit({
    envelope,
    route,
    assistantText,
  });
  const qualityContract = routes.__internal.evaluateQualityContractForEnvelope({
    envelope,
    policyMeta: { intent_canonical: route },
    assistantText,
    profile:
      envelope && envelope.session_patch && envelope.session_patch.profile && typeof envelope.session_patch.profile === 'object'
        ? envelope.session_patch.profile
        : null,
  });
  return {
    case_id: caseId,
    route,
    status,
    surface_card_types: Array.isArray(envelope && envelope.cards)
      ? envelope.cards.map((card) => String(card && card.type ? card.type : '').trim()).filter(Boolean)
      : [],
    assistant_message: assistantText,
    audit,
    quality_contract: qualityContract,
  };
}

function summarizeDrifts(entries) {
  const counts = {};
  for (const entry of entries) {
    const drift = entry && entry.audit && entry.audit.drift && typeof entry.audit.drift === 'object'
      ? entry.audit.drift
      : {};
    for (const [key, value] of Object.entries(drift)) {
      if (value !== true) continue;
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return counts;
}

function buildMarkdown(entries) {
  const summary = summarizeDrifts(entries);
  const lines = ['# Aurora Beauty Ownership Matrix Audit', ''];
  lines.push('## Drift Summary');
  lines.push('');
  if (Object.keys(summary).length === 0) {
    lines.push('- none');
  } else {
    for (const [key, value] of Object.entries(summary).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      lines.push(`- \`${key}\`: ${value}`);
    }
  }
  lines.push('');
  for (const entry of entries) {
    const owners = entry.audit && entry.audit.owner_matrix ? entry.audit.owner_matrix : {};
    const drift = entry.audit && entry.audit.drift ? entry.audit.drift : {};
    const failingDrifts = Object.entries(drift).filter(([, value]) => value === true).map(([key]) => key);
    lines.push(`## ${entry.case_id}`);
    lines.push('');
    lines.push(`- route: \`${entry.route}\``);
    lines.push(`- status: \`${entry.status}\``);
    lines.push(`- primary focus owner: \`${owners.primary_focus_owner || 'none'}\``);
    lines.push(`- target bundle owner: \`${owners.target_bundle_owner || 'none'}\``);
    lines.push(`- outcome owner: \`${owners.outcome_owner || 'none'}\``);
    lines.push(`- copy owner: \`${owners.copy_owner || 'none'}\``);
    lines.push(`- semantic contract pass: \`${entry.quality_contract && entry.quality_contract.semantic_contract_pass === true}\``);
    lines.push(`- drifts: ${failingDrifts.length ? failingDrifts.map((item) => `\`${item}\``).join(', ') : 'none'}`);
    lines.push(`- cards: ${(Array.isArray(entry.surface_card_types) ? entry.surface_card_types : []).map((item) => `\`${item}\``).join(', ') || 'none'}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function runPurePhotoFlow() {
  return withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_DECISION_BASE_URL: '',
      AURORA_BFF_RETENTION_DAYS: '0',
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
      DATABASE_URL: undefined,
    },
    async () => {
      const originalGet = axios.get;
      const originalPost = axios.post;
      const routes = loadRoutesFresh();
      try {
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
        axios.get = async (url, config = {}) => {
          const target = String(url || '');
          if (!target.includes('/agent/v1/products/search') && !target.includes('/agent/v1/beauty/products/search')) {
            throw new Error(`Unexpected axios.get: ${target}`);
          }
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
          const target = String(url || '');
          if (target.includes('/agent/shop/v1/invoke')) {
            return {
              status: 200,
              data: { status: 'error', reason: 'no_candidates', reason_code: 'no_candidates' },
            };
          }
          if (target.includes('/agent/v1/products/resolve')) {
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
          throw new Error(`Unexpected axios.post: ${target}`);
        };

        const app = buildApp(routes);
        const headers = makeHeaders('pure_photo_matrix');
        const photoBuffer = await buildQualityPassPhotoBuffer();

        const presign = await invokeRoute(app, 'POST', '/v1/photos/presign', {
          headers,
          body: { slot_id: 'daylight', content_type: 'image/png', bytes: photoBuffer.length },
        });
        const photoId = String(getCard(presign.body, 'photo_presign')?.payload?.photo_id || '').trim();
        routes.__internal.setPhotoBytesCache({
          photoId,
          auroraUid: headers['X-Aurora-UID'],
          buffer: photoBuffer,
          contentType: 'image/png',
        });
        await invokeRoute(app, 'POST', '/v1/photos/confirm', {
          headers,
          body: { photo_id: photoId, slot_id: 'daylight' },
        });
        const analysis = await invokeRoute(app, 'POST', '/v1/analysis/skin', {
          headers,
          body: {
            use_photo: true,
            photos: [{ photo_id: photoId, slot_id: 'daylight', qc_status: 'passed' }],
          },
        });
        const latestRecoContext = analysis.body && analysis.body.session_patch && analysis.body.session_patch.state
          ? analysis.body.session_patch.state.latest_reco_context
          : null;
        const chat = await invokeRoute(app, 'POST', '/v1/chat', {
          headers,
          body: buildRecoChatBody(latestRecoContext),
        });
        const bootstrap = await invokeRoute(app, 'GET', '/v1/session/bootstrap', { headers });
        return {
          routes,
          entries: [
            buildCaseEntry({ caseId: 'pure_photo_analysis', route: 'analysis_skin', status: analysis.status, envelope: analysis.body, routes }),
            buildCaseEntry({ caseId: 'photo_contextual_chat_reco', route: 'chat_reco', status: chat.status, envelope: chat.body, routes }),
            buildCaseEntry({ caseId: 'photo_bootstrap_restore', route: 'session_bootstrap', status: bootstrap.status, envelope: bootstrap.body, routes }),
          ],
        };
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
        delete require.cache[ROUTES_MODULE_PATH];
      }
    },
  );
}

async function runMixedRoutinePhotoAnalysisCase() {
  return withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_PHOTO_FETCH_RETRIES: '0',
      AURORA_PHOTO_FETCH_TOTAL_TIMEOUT_MS: '2500',
      AURORA_PHOTO_FETCH_TIMEOUT_MS: '800',
      DATABASE_URL: undefined,
    },
    async () => {
      delete require.cache[ROUTES_MODULE_PATH];
      delete require.cache[SKIN_DIAGNOSIS_MODULE_PATH];
      delete require.cache[ROUTINE_ANALYSIS_MODULE_PATH];
      const routes = loadRoutesFresh();
      const skinDiagnosis = require('../src/auroraBff/skinDiagnosisV1');
      const routineAnalysisV2 = require('../src/auroraBff/routineAnalysisV2');
      const originalRunSkinDiagnosisV1 = skinDiagnosis.runSkinDiagnosisV1;
      const originalRunRoutineAnalysisV2 = routineAnalysisV2.runRoutineAnalysisV2;
      const originalGet = axios.get;
      const originalPost = axios.post;
      const originalRequest = axios.request;
      try {
        const pngBytes = await sharp({
          create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 192, b: 176 } },
        }).png().toBuffer();

        skinDiagnosis.runSkinDiagnosisV1 = async () => ({
          ok: true,
          diagnosis: {
            issues: [
              {
                issue_type: 'texture',
                severity: 'mild',
                severity_level: 2,
                severity_score: 0.61,
                confidence: 0.2,
                confidence_label: 'uncertain',
                summary: 'Visible texture irregularity near the right under-eye area.',
              },
            ],
            quality: { grade: 'pass', reasons: ['qc_passed'] },
            photo_findings: [
              {
                finding_id: 'mixed_photo_story_texture',
                issue_type: 'texture',
                confidence: 0.2,
                evidence: 'Visible texture irregularity near the right under-eye area.',
              },
            ],
          },
          internal: { source: 'test_mixed_photo_story' },
        });

        routineAnalysisV2.runRoutineAnalysisV2 = async () => ({
          cards: [
            {
              card_id: 'routine_audit_test',
              type: 'routine_product_audit_v1',
              payload: { summary: 'Add Sunscreen in the AM', primary_gap: 'Missing sunscreen' },
            },
            {
              card_id: 'routine_adjustment_test',
              type: 'routine_adjustment_plan_v1',
              payload: { steps: ['Add SPF50+ sunscreen every morning.'] },
            },
          ],
          assistant_text:
            'I reviewed each current product first. The best place to start is "Add Sunscreen in the AM" because it drives the biggest routine mismatch right now.',
          persist_payload: {
            schema_version: 'aurora.routine_analysis.v2',
            recommendation_groups: [],
          },
          legacy_compat: { source: 'routine_analysis_v2' },
          recommendation_groups: [],
          debug_meta: { enabled: true, stage_a: { deferred_product_count: 0 } },
        });

        axios.get = async (url) => {
          const target = String(url || '');
          if (target.endsWith('/photos/download-url')) {
            return {
              status: 200,
              data: {
                download: {
                  url: 'https://signed-download.test/mixed-photo-story',
                  expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
                },
                content_type: 'image/png',
              },
            };
          }
          if (target === 'https://signed-download.test/mixed-photo-story') {
            return {
              status: 200,
              data: pngBytes,
              headers: { 'content-type': 'image/png' },
            };
          }
          throw new Error(`Unexpected axios.get url: ${target}`);
        };

        const app = buildApp(routes);
        const headers = makeHeaders('mixed_routine_photo_matrix');
        const analysis = await invokeRoute(app, 'POST', '/v1/analysis/skin', {
          headers,
          body: {
            use_photo: true,
            currentRoutine: {
              am: [
                { step: 'cleanser', product_text: 'Gentle Cleanser' },
                { step: 'moisturizer', product_text: 'Barrier Cream' },
              ],
              pm: [
                { step: 'cleanser', product_text: 'Gentle Cleanser' },
                { step: 'treatment', product_text: 'Retinoid Serum' },
                { step: 'moisturizer', product_text: 'Barrier Cream' },
              ],
            },
            photos: [{ slot_id: 'daylight', photo_id: 'photo_mixed_story', qc_status: 'passed' }],
          },
        });
        return {
          routes,
          entries: [
            buildCaseEntry({
              caseId: 'mixed_routine_photo_analysis',
              route: 'analysis_skin',
              status: analysis.status,
              envelope: analysis.body,
              routes,
            }),
          ],
        };
      } finally {
        skinDiagnosis.runSkinDiagnosisV1 = originalRunSkinDiagnosisV1;
        routineAnalysisV2.runRoutineAnalysisV2 = originalRunRoutineAnalysisV2;
        axios.get = originalGet;
        axios.post = originalPost;
        axios.request = originalRequest;
        delete require.cache[ROUTES_MODULE_PATH];
        delete require.cache[SKIN_DIAGNOSIS_MODULE_PATH];
        delete require.cache[ROUTINE_ANALYSIS_MODULE_PATH];
      }
    },
  );
}

async function runPureRoutineAnalysisCase() {
  return withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      DATABASE_URL: undefined,
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_ANALYSIS_STORY_V2_ENABLED: 'true',
    },
    async () => {
      const routes = loadRoutesFresh();
      try {
        const app = buildApp(routes);
        const headers = makeHeaders('pure_routine_matrix');
        const analysis = await invokeRoute(app, 'POST', '/v1/analysis/skin', {
          headers,
          body: {
            use_photo: false,
            currentRoutine: {
              am: { cleanser: 'CeraVe Foaming Cleanser', spf: 'EltaMD UV Clear' },
              pm: { cleanser: 'CeraVe Foaming Cleanser', treatment: 'Retinol 0.2%', moisturizer: 'CeraVe PM' },
              notes: 'Sometimes stings after retinol.',
            },
          },
        });
        return {
          routes,
          entries: [
            buildCaseEntry({
              caseId: 'pure_routine_analysis',
              route: 'analysis_skin',
              status: analysis.status,
              envelope: analysis.body,
              routes,
            }),
          ],
        };
      } finally {
        delete require.cache[ROUTES_MODULE_PATH];
      }
    },
  );
}

async function runProductAnalyzeCase() {
  return withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      DATABASE_URL: undefined,
    },
    async () => {
      const routes = loadRoutesFresh();
      try {
        const app = buildApp(routes);
        const headers = makeHeaders('product_analyze_matrix');
        const response = await invokeRoute(app, 'POST', '/v1/product/analyze', {
          headers,
          body: {
            name: 'Mock Parsed Product',
            context: {
              skin_feel: 'oily',
              goal_primary: 'breakouts',
              sensitivity_flag: 'yes',
            },
          },
        });
        return {
          routes,
          entries: [
            buildCaseEntry({
              caseId: 'product_analyze_overlay',
              route: 'product_analyze',
              status: response.status,
              envelope: response.body,
              routes,
            }),
          ],
        };
      } finally {
        delete require.cache[ROUTES_MODULE_PATH];
      }
    },
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const requestedCases = new Set(args.cases);
  const runners = [
    { id: 'pure_photo', run: runPurePhotoFlow },
    { id: 'mixed_routine_photo', run: runMixedRoutinePhotoAnalysisCase },
    { id: 'pure_routine', run: runPureRoutineAnalysisCase },
    { id: 'product_analyze', run: runProductAnalyzeCase },
  ].filter((item) => requestedCases.size === 0 || requestedCases.has(item.id));

  const entries = [];
  const errors = [];
  for (const runner of runners) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await runner.run();
      entries.push(...(Array.isArray(out && out.entries) ? out.entries : []));
    } catch (err) {
      errors.push({
        case_id: runner.id,
        error: String(err && err.stack ? err.stack : err),
      });
    }
  }

  const bundle = {
    version: 'aurora.beauty.ownership_matrix.v1',
    generated_at: new Date().toISOString(),
    entry_count: entries.length,
    error_count: errors.length,
    drift_summary: summarizeDrifts(entries),
    entries,
    errors,
  };
  const markdown = buildMarkdown(entries);

  if (args.jsonOut) fs.writeFileSync(path.resolve(process.cwd(), args.jsonOut), `${JSON.stringify(bundle, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
  if (args.mdOut) fs.writeFileSync(path.resolve(process.cwd(), args.mdOut), markdown);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
