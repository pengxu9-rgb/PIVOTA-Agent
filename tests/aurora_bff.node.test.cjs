const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

const {
  shouldDiagnosisGate,
  buildDiagnosisChips,
  recommendationsAllowed,
  stateChangeAllowed,
  stripRecommendationCards,
} = require('../src/auroraBff/gating');
const { normalizeRecoGenerate } = require('../src/auroraBff/normalize');
const { simulateConflicts } = require('../src/auroraBff/routineRules');
const { auroraChat } = require('../src/auroraBff/auroraDecisionClient');

test('Phase0 gate: no recos when profile is missing', async () => {
  const gate = shouldDiagnosisGate({
    message: 'Please recommend a moisturizer',
    triggerSource: 'text_explicit',
    profile: null,
  });
  assert.equal(gate.gated, true);
  assert.ok(gate.missing.includes('skinType'));

  const chips = buildDiagnosisChips('EN', gate.missing);
  assert.ok(chips.some((c) => String(c.chip_id).startsWith('profile.skinType.')));
});

test('Recommendation gate: strips recommendation cards unless explicit', async () => {
  const filtered = stripRecommendationCards([
    { type: 'recommendations', payload: {} },
    { type: 'offers_resolved', payload: {} },
    { type: 'info', payload: { ok: true } },
  ]);
  assert.equal(filtered.some((c) => c.type === 'recommendations'), false);
  assert.equal(filtered.some((c) => c.type === 'offers_resolved'), false);
  assert.equal(filtered.some((c) => c.type === 'info'), true);
});

test('Routine simulate: detects retinoid x acids conflict', async () => {
  const sim = simulateConflicts({
    routine: { pm: [{ key_actives: ['retinol'] }] },
    testProduct: { key_actives: ['glycolic acid'] },
  });
  assert.equal(sim.safe, false);
  assert.equal(sim.conflicts.some((c) => c.rule_id === 'retinoid_x_acids'), true);
});

test('Aurora mock: returns recommendations card (for offline gating tests)', async () => {
  const resp = await auroraChat({ baseUrl: '', query: 'Hello' });
  assert.ok(resp);
  assert.equal(Array.isArray(resp.cards), true);
  assert.equal(resp.cards.some((c) => String(c.type).includes('recommend')), true);
});

test('normalizeRecoGenerate: moves warning-like codes into warnings', async () => {
  const norm = normalizeRecoGenerate({
    recommendations: [{ slot: 'other', step: 'serum', sku: { brand: 'X', name: 'Y', sku_id: 'id' } }],
    evidence: null,
    confidence: 0.5,
    missing_info: ['over_budget', 'budget_unknown', 'recent_logs_missing'],
  });

  assert.ok(norm);
  assert.equal(Array.isArray(norm.payload.missing_info), true);
  assert.equal(Array.isArray(norm.payload.warnings), true);
  assert.equal(norm.payload.missing_info.includes('budget_unknown'), true);
  assert.equal(norm.payload.missing_info.includes('over_budget'), false);
  assert.equal(norm.payload.warnings.includes('over_budget'), true);
  assert.equal(norm.payload.warnings.includes('recent_logs_missing'), true);
});

test('Recommendation gate: does not unlock commerce for diagnosis chip', async () => {
  assert.equal(
    recommendationsAllowed({ triggerSource: 'chip', actionId: 'chip.start.diagnosis', message: 'Start skin diagnosis' }),
    false,
  );
  assert.equal(
    recommendationsAllowed({ triggerSource: 'chip', actionId: 'chip.start.routine', message: 'Build an AM/PM routine' }),
    true,
  );
  assert.equal(
    recommendationsAllowed({ triggerSource: 'text_explicit', actionId: null, message: 'Start skin diagnosis' }),
    false,
  );
  assert.equal(
    recommendationsAllowed({ triggerSource: 'text_explicit', actionId: null, message: 'Recommend a moisturizer' }),
    true,
  );
  assert.equal(stateChangeAllowed('text_explicit'), true);
});

test('/v1/chat: Start diagnosis chip enters diagnosis flow (no upstream loop)', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
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
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/chat', {
    headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief' },
    body: {
      action: { action_id: 'chip.start.diagnosis', kind: 'chip', data: { reply_text: 'Start skin diagnosis' } },
      session: { state: 'idle' },
      language: 'EN',
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(typeof resp.body?.assistant_message?.content, 'string');
  assert.match(resp.body.assistant_message.content, /quick skin profile/i);
  assert.equal(Array.isArray(resp.body?.suggested_chips), true);
  assert.ok(resp.body.suggested_chips.some((c) => String(c.chip_id).startsWith('profile.skinType.')));
  assert.ok(resp.body.suggested_chips.every((c) => !String(c.chip_id).startsWith('chip.clarify.next.')));
});

test('/v1/chat: Routine alternatives cover AM + PM', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
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
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/chat', {
    headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief' },
    body: {
      action: {
        action_id: 'chip.start.routine',
        kind: 'chip',
        data: {
          reply_text: 'Build an AM/PM routine',
          include_alternatives: true,
          profile_patch: {
            skinType: 'oily',
            sensitivity: 'low',
            barrierStatus: 'healthy',
            goals: ['pores'],
            budgetTier: '¥500',
          },
        },
      },
      session: { state: 'S2_DIAGNOSIS' },
      language: 'EN',
    },
  });

  assert.equal(resp.status, 200);

  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const recoCard = cards.find((c) => c && c.type === 'recommendations');
  assert.ok(recoCard);

  const recos = Array.isArray(recoCard?.payload?.recommendations) ? recoCard.payload.recommendations : [];
  const am = recos.find((r) => String(r?.slot || '').toLowerCase() === 'am');
  const pm = recos.find((r) => String(r?.slot || '').toLowerCase() === 'pm');
  assert.ok(am);
  assert.ok(pm);

  assert.ok(Array.isArray(am.alternatives) && am.alternatives.length > 0);
  assert.ok(Array.isArray(pm.alternatives) && pm.alternatives.length > 0);
});

test('/v1/chat: exposes env_stress + citations + conflicts cards (contracts)', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
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
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/chat', {
    headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Debug': 'true' },
    body: {
      message: 'CONTEXT_CARDS_TEST',
      anchor_product_id: 'mock_anchor_1',
      session: { state: 'idle' },
      language: 'EN',
      debug: true,
    },
  });

  assert.equal(resp.status, 200);
  assert.ok(Array.isArray(resp.body?.cards));

  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];

  const structured = cards.find((c) => c && c.type === 'aurora_structured');
  assert.ok(structured);
  const citations = structured?.payload?.external_verification?.citations;
  assert.ok(Array.isArray(citations));
  assert.ok(citations.length > 0);

  const envStress = cards.find((c) => c && c.type === 'env_stress');
  assert.ok(envStress);
  assert.equal(envStress?.payload?.schema_version, 'aurora.ui.env_stress.v1');
  assert.equal(envStress?.payload?.ess, 88);
  const radar = envStress?.payload?.radar;
  assert.ok(Array.isArray(radar));
  assert.ok(radar.length > 0);
  assert.ok(radar.every((r) => typeof r?.value === 'number' && r.value >= 0 && r.value <= 100));

  const sim = cards.find((c) => c && c.type === 'routine_simulation');
  assert.ok(sim);
  assert.equal(sim?.payload?.schema_version, 'aurora.conflicts.v1');
  assert.equal(sim?.payload?.safe, false);
  assert.ok(Array.isArray(sim?.payload?.conflicts));
  assert.ok(sim.payload.conflicts.some((c) => c && c.rule_id === 'retinoid_x_acids'));

  const heatmap = cards.find((c) => c && c.type === 'conflict_heatmap');
  assert.ok(heatmap);
  assert.equal(heatmap?.payload?.schema_version, 'aurora.ui.conflict_heatmap.v1');
});

test('/v1/analysis/skin: allow no-photo analysis (continue without photos)', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
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
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/analysis/skin', {
    headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief' },
    body: { use_photo: false, photos: [] },
  });

  assert.equal(resp.status, 200);
  assert.ok(Array.isArray(resp.body?.cards));
  const card = resp.body.cards.find((c) => c && c.type === 'analysis_summary');
  assert.ok(card);
  assert.equal(card.payload?.analysis_source, 'baseline_low_confidence');
  const missing = Array.isArray(card.field_missing) ? card.field_missing : [];
  assert.equal(missing.some((m) => String(m?.field || '') === 'profile.currentRoutine'), false);
});

test('/v1/analysis/skin: accepts routine input and avoids low-confidence baseline', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
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
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/analysis/skin', {
    headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief' },
    body: {
      use_photo: false,
      currentRoutine: {
        am: { cleanser: 'CeraVe Foaming Cleanser', spf: 'EltaMD UV Clear' },
        pm: { cleanser: 'CeraVe Foaming Cleanser', treatment: 'Retinol 0.2%', moisturizer: 'CeraVe PM' },
        notes: 'Sometimes stings after retinol.',
      },
    },
  });

  assert.equal(resp.status, 200);
  assert.ok(Array.isArray(resp.body?.cards));
  const card = resp.body.cards.find((c) => c && c.type === 'analysis_summary');
  assert.ok(card);
  assert.notEqual(card.payload?.analysis_source, 'baseline_low_confidence');

  const missing = Array.isArray(card.field_missing) ? card.field_missing : [];
  assert.equal(missing.some((m) => String(m?.field || '') === 'profile.currentRoutine'), false);

  const analysis = card.payload?.analysis;
  assert.equal(Boolean(analysis && typeof analysis === 'object'), true);
  assert.equal(Array.isArray(analysis.features), true);
  assert.ok(analysis.features.length > 0);
});

test('/v1/product/analyze: returns verdict + enriched reasons', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
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
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/product/analyze', {
    headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 't', 'X-Brief-ID': 'b', 'X-Lang': 'EN' },
    body: { name: 'Mock Parsed Product' },
  });

  assert.equal(resp.status, 200);
  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const card = cards.find((c) => c && c.type === 'product_analysis');
  assert.ok(card);

  assert.equal(card.payload?.assessment?.verdict, 'Suitable');
  const reasons = card.payload?.assessment?.reasons;
  assert.equal(Array.isArray(reasons), true);
  assert.ok(reasons.length >= 2);
  assert.ok(reasons.some((r) => /most impactful ingredient/i.test(String(r || ''))));
});

test('/v1/dupe/compare: returns tradeoffs (compare task)', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
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
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/dupe/compare', {
    headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 't', 'X-Brief-ID': 'b', 'X-Lang': 'EN' },
    body: {
      original: { brand: 'MockBrand', name: 'Mock Parsed Product' },
      dupe: { brand: 'MockDupeBrand', name: 'mock_dupe' },
    },
  });

  assert.equal(resp.status, 200);
  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const card = cards.find((c) => c && c.type === 'dupe_compare');
  assert.ok(card);

  const payload = card.payload || {};
  assert.ok(payload.original);
  assert.ok(payload.dupe);

  const tradeoffs = Array.isArray(payload.tradeoffs) ? payload.tradeoffs : [];
  assert.ok(tradeoffs.length > 0);
  assert.ok(tradeoffs.some((t) => /mock tradeoff/i.test(String(t || ''))));
});

test('/v1/dupe/compare: falls back to deepscan diff when compare is empty', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
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
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/dupe/compare', {
    headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 't', 'X-Brief-ID': 'b', 'X-Lang': 'EN' },
    body: {
      original: { brand: 'MockBrand', name: 'Mock Parsed Product' },
      dupe: { brand: 'MockDupeBrand', name: 'mock_dupe' },
      original_url: 'https://example.com/COMPARE_EMPTY_TEST',
    },
  });

  assert.equal(resp.status, 200);
  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const card = cards.find((c) => c && c.type === 'dupe_compare');
  assert.ok(card);

  const tradeoffs = Array.isArray(card.payload?.tradeoffs) ? card.payload.tradeoffs : [];
  assert.ok(tradeoffs.length > 0);
  assert.ok(tradeoffs.some((t) => /missing actives vs original|added actives|hero ingredient shift/i.test(String(t || ''))));
});
