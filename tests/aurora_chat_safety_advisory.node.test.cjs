const test = require('node:test');
const assert = require('node:assert/strict');

function withEnv(patch, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(patch || {})) {
    prev[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }

  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.finally(restore);
    }
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
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

test('/v1/chat conflict: missing pregnancy defaults to not_pregnant without blocking cards', async () => {
  await withEnv(
    {
      AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED: 'true',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_SAFETY_ENGINE_V1_ENABLED: 'true',
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_CHAT_NONBLOCKING_GATE_V1: 'true',
      AURORA_PROFILE_V2_ENABLED: 'true',
    },
    async () => {
      const express = require('express');
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      try {
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await invokeRoute(app, 'POST', '/v1/chat', {
          headers: {
            'X-Aurora-UID': 'optional_safety_uid',
            'X-Trace-ID': 'test_trace',
            'X-Brief-ID': 'test_brief',
            'X-Lang': 'EN',
          },
          body: {
            message: 'Can I use retinol and glycolic acid in the same night?',
            client_state: 'RECO_RESULTS',
            session: { state: 'S7_PRODUCT_RECO' },
          },
        });

        assert.equal(resp.status, 200);
        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        assert.ok(cards.some((c) => c && c.type === 'routine_simulation'));
        assert.ok(cards.some((c) => c && c.type === 'conflict_heatmap'));
        const events = Array.isArray(resp.body?.events) ? resp.body.events : [];
        assert.equal(events.some((evt) => evt && evt.event_name === 'pregnancy_status_defaulted'), true);
        assert.equal(resp.body?.session_patch?.meta?.pregnancy_status_defaulted, true);

        const safetyNotice = cards.find(
          (c) => c && c.type === 'confidence_notice' && c.payload && c.payload.reason === 'safety_optional_profile_missing',
        );
        assert.equal(Boolean(safetyNotice), false);
        assert.equal(resp.body?.session_patch?.meta?.safety_gate_mode, 'advisory_only_v1');
        assert.equal(resp.body?.session_patch?.meta?.passive_gate_suppressed, true);
        assert.equal(Array.isArray(resp.body?.session_patch?.meta?.suppressed_gate_ids), true);
        assert.equal(resp.body?.session_patch?.meta?.suppressed_gate_ids?.includes('safety_optional_profile_missing'), true);
      } finally {
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/chat reco chip is not blocked by stale DIAG_PROFILE state', async () => {
  await withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_SAFETY_ENGINE_V1_ENABLED: 'true',
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_CHAT_NONBLOCKING_GATE_V1: 'true',
      AURORA_PROFILE_V2_ENABLED: 'true',
    },
    async () => {
      const express = require('express');
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      try {
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await invokeRoute(app, 'POST', '/v1/chat', {
          headers: {
            'X-Aurora-UID': 'stale_diag_state_uid',
            'X-Trace-ID': 'test_trace',
            'X-Brief-ID': 'test_brief',
            'X-Lang': 'EN',
          },
          body: {
            action: {
              action_id: 'chip.start.reco_products',
              kind: 'chip',
              data: { reply_text: 'Recommend a few products', include_alternatives: false },
            },
            client_state: 'DIAG_PROFILE',
            session: { state: 'S2_DIAGNOSIS' },
          },
        });

        assert.equal(resp.status, 200);
        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        assert.equal(cards.some((card) => card && card.type === 'diagnosis_gate'), false);
        assert.equal(
          cards.some((card) => card && (card.type === 'recommendations' || card.type === 'confidence_notice')),
          true,
        );
      } finally {
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/chat conflict: pregnancy default event is emitted once per aurora_uid', async () => {
  await withEnv(
    {
      AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED: 'true',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_SAFETY_ENGINE_V1_ENABLED: 'true',
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_CHAT_NONBLOCKING_GATE_V1: 'true',
      AURORA_PROFILE_V2_ENABLED: 'true',
    },
    async () => {
      const express = require('express');
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      try {
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const headers = {
          'X-Aurora-UID': 'asked_once_uid',
          'X-Trace-ID': 'test_trace',
          'X-Brief-ID': 'test_brief',
          'X-Lang': 'EN',
        };
        const body = {
          message: 'Can I combine retinol with glycolic acid tonight?',
          client_state: 'RECO_RESULTS',
          session: { state: 'S7_PRODUCT_RECO' },
        };

        const first = await invokeRoute(app, 'POST', '/v1/chat', { headers, body });
        assert.equal(first.status, 200);
        const firstEvents = Array.isArray(first.body?.events) ? first.body.events : [];
        assert.equal(firstEvents.some((evt) => evt && evt.event_name === 'pregnancy_status_defaulted'), true);

        const second = await invokeRoute(app, 'POST', '/v1/chat', { headers, body });
        assert.equal(second.status, 200);
        const secondEvents = Array.isArray(second.body?.events) ? second.body.events : [];
        assert.equal(secondEvents.some((evt) => evt && evt.event_name === 'pregnancy_status_defaulted'), false);
      } finally {
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/chat free text "trying to conceive" overrides default pregnancy status', async () => {
  await withEnv(
    {
      AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED: 'true',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_SAFETY_ENGINE_V1_ENABLED: 'true',
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_CHAT_NONBLOCKING_GATE_V1: 'true',
      AURORA_PROFILE_V2_ENABLED: 'true',
      AURORA_ROUTER_DST_PATCH_V1: 'true',
    },
    async () => {
      const express = require('express');
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      try {
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const headers = {
          'X-Aurora-UID': 'pregnancy_trying_uid',
          'X-Trace-ID': 'test_trace',
          'X-Brief-ID': 'test_brief',
          'X-Lang': 'EN',
        };
        const chatResp = await invokeRoute(app, 'POST', '/v1/chat', {
          headers,
          body: {
            message: 'I am trying to conceive. Can I use retinol and glycolic acid together?',
            session: { state: 'S7_PRODUCT_RECO' },
          },
        });
        assert.equal(chatResp.status, 200);
        assert.equal((Array.isArray(chatResp.body?.cards) ? chatResp.body.cards : []).some((c) => c && c.type === 'routine_simulation'), true);

        const bootstrapResp = await invokeRoute(app, 'GET', '/v1/session/bootstrap', {
          headers,
        });
        assert.equal(bootstrapResp.status, 200);
        const bootstrapCard = (Array.isArray(bootstrapResp.body?.cards) ? bootstrapResp.body.cards : []).find(
          (card) => card && card.type === 'session_bootstrap',
        );
        assert.equal(bootstrapCard?.payload?.profile?.pregnancy_status, 'trying');
      } finally {
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/chat auto-resets pregnant profile when pregnancy_due_date is in the past', async () => {
  await withEnv(
    {
      AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED: 'true',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_SAFETY_ENGINE_V1_ENABLED: 'true',
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_CHAT_NONBLOCKING_GATE_V1: 'true',
      AURORA_PROFILE_V2_ENABLED: 'true',
    },
    async () => {
      const express = require('express');
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      try {
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const headers = {
          'X-Aurora-UID': 'pregnancy_auto_reset_uid',
          'X-Trace-ID': 'test_trace',
          'X-Brief-ID': 'test_brief',
          'X-Lang': 'EN',
        };

        const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
          headers,
          body: { pregnancy_status: 'pregnant', pregnancy_due_date: '2020-01-01' },
        });
        assert.equal(seed.status, 200);

        const chatResp = await invokeRoute(app, 'POST', '/v1/chat', {
          headers,
          body: {
            message: 'Can I use retinol and glycolic acid in the same night?',
            session: { state: 'S7_PRODUCT_RECO' },
          },
        });
        assert.equal(chatResp.status, 200);
        const events = Array.isArray(chatResp.body?.events) ? chatResp.body.events : [];
        assert.equal(events.some((evt) => evt && evt.event_name === 'pregnancy_status_auto_reset'), true);
        assert.equal(chatResp.body?.session_patch?.meta?.pregnancy_status_auto_reset, true);

        const bootstrapResp = await invokeRoute(app, 'GET', '/v1/session/bootstrap', {
          headers,
        });
        assert.equal(bootstrapResp.status, 200);
        const bootstrapCard = (Array.isArray(bootstrapResp.body?.cards) ? bootstrapResp.body.cards : []).find(
          (card) => card && card.type === 'session_bootstrap',
        );
        assert.equal(bootstrapCard?.payload?.profile?.pregnancy_status, 'not_pregnant');
        assert.equal(bootstrapCard?.payload?.profile?.pregnancy_due_date, null);
      } finally {
        delete require.cache[moduleId];
      }
    },
  );
});
