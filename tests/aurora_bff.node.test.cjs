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
const { buildConflictHeatmapV1 } = require('../src/auroraBff/conflictHeatmapV1');
const { auroraChat } = require('../src/auroraBff/auroraDecisionClient');
const { createStageProfiler } = require('../src/auroraBff/skinAnalysisProfiling');
const { should_call_llm: shouldCallLlm } = require('../src/auroraBff/skinLlmPolicy');
const { getDiagRolloutDecision, hashToBucket0to99 } = require('../src/auroraBff/diagRollout');

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

test('Conflict heatmap V1: retinoid_x_acids maps to severity 3 at (1,2)', async () => {
  const payload = buildConflictHeatmapV1({
    routineSimulation: {
      schema_version: 'aurora.conflicts.v1',
      safe: false,
      conflicts: [{ severity: 'block', rule_id: 'retinoid_x_acids', message: 'x', step_indices: [1, 2] }],
      summary: 'x',
    },
    routineSteps: ['AM Cleanser', 'PM Treatment', 'PM Moisturizer'],
  });

  assert.equal(payload.schema_version, 'aurora.ui.conflict_heatmap.v1');
  assert.equal(payload.state, 'has_conflicts');
  assert.equal(payload.cells.encoding, 'sparse');
  assert.equal(payload.cells.default_severity, 0);
  assert.ok(Array.isArray(payload.cells.items));
  assert.equal(payload.cells.items.length, 1);
  assert.deepEqual(payload.cells.items[0], {
    cell_id: 'cell_1_2',
    row_index: 1,
    col_index: 2,
    severity: 3,
    rule_ids: ['retinoid_x_acids'],
    headline_i18n: { en: 'Retinoid × acids', zh: '维A类 × 酸类' },
    why_i18n: {
      en: 'Using retinoids with AHAs/BHAs in the same routine can significantly increase irritation and barrier stress.',
      zh: '维A类与 AHA/BHA 同晚叠加更容易刺激、爆皮，并加重屏障压力。',
    },
    recommendations: payload.cells.items[0].recommendations,
  });
  assert.ok(Array.isArray(payload.cells.items[0].recommendations));
  assert.ok(payload.cells.items[0].recommendations.length > 0);
  assert.ok(payload.cells.items[0].recommendations.every((r) => typeof r?.en === 'string' && typeof r?.zh === 'string'));
});

test('Conflict heatmap V1: multiple_exfoliants maps to severity 2 at (1,2)', async () => {
  const payload = buildConflictHeatmapV1({
    routineSimulation: {
      schema_version: 'aurora.conflicts.v1',
      safe: false,
      conflicts: [{ severity: 'warn', rule_id: 'multiple_exfoliants', message: 'x', step_indices: [2, 1] }],
      summary: 'x',
    },
    routineSteps: ['AM Cleanser', 'PM Treatment', 'PM Moisturizer'],
  });

  assert.equal(payload.state, 'has_conflicts');
  assert.equal(payload.cells.items.length, 1);
  assert.equal(payload.cells.items[0].cell_id, 'cell_1_2');
  assert.equal(payload.cells.items[0].severity, 2);
  assert.deepEqual(payload.cells.items[0].rule_ids, ['multiple_exfoliants']);
});

test('Conflict heatmap V1: safe + no conflicts -> no_conflicts', async () => {
  const payload = buildConflictHeatmapV1({
    routineSimulation: { safe: true, conflicts: [], summary: 'ok' },
    routineSteps: ['AM Cleanser', 'PM Moisturizer'],
  });

  assert.equal(payload.state, 'no_conflicts');
  assert.equal(Array.isArray(payload.cells.items), true);
  assert.equal(payload.cells.items.length, 0);
  assert.equal(Array.isArray(payload.unmapped_conflicts), true);
  assert.equal(payload.unmapped_conflicts.length, 0);
});

test('Conflict heatmap V1: missing step pair -> unmapped_conflicts + partial state', async () => {
  const payload = buildConflictHeatmapV1({
    routineSimulation: {
      schema_version: 'aurora.conflicts.v1',
      safe: false,
      conflicts: [{ severity: 'warn', rule_id: 'multiple_exfoliants', message: 'x' }],
      summary: 'x',
    },
    routineSteps: ['AM Cleanser', 'PM Treatment', 'PM Moisturizer'],
  });

  assert.equal(payload.state, 'has_conflicts_partial');
  assert.equal(payload.cells.items.length, 0);
  assert.equal(payload.unmapped_conflicts.length, 1);
  assert.equal(payload.unmapped_conflicts[0].rule_id, 'multiple_exfoliants');
  assert.equal(payload.unmapped_conflicts[0].severity, 2);
  assert.ok(payload.unmapped_conflicts[0].message_i18n);
});

test('/v1/routine/simulate: emits conflict_heatmap payload when enabled', async () => {
  await withEnv({ AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED: 'true' }, async () => {
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

    const resp = await invokeRoute(app, 'POST', '/v1/routine/simulate', {
      headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        routine: { pm: [{ key_actives: ['retinol'], step: 'Treatment' }] },
        test_product: { key_actives: ['glycolic acid'], name: 'Test Acid' },
      },
    });

    assert.equal(resp.status, 200);
    assert.ok(Array.isArray(resp.body?.cards));
    const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
    const heatmap = cards.find((c) => c && c.type === 'conflict_heatmap');
    assert.ok(heatmap);
    assert.equal(heatmap?.payload?.schema_version, 'aurora.ui.conflict_heatmap.v1');
    assert.equal(heatmap?.payload?.state, 'has_conflicts');
    assert.ok(Array.isArray(heatmap?.payload?.cells?.items));
    assert.equal(heatmap.payload.cells.items.length, 1);
    assert.equal(heatmap.payload.cells.items[0].severity, 2);

    const impression = Array.isArray(resp.body?.events)
      ? resp.body.events.find((e) => e && e.event_name === 'aurora_conflict_heatmap_impression')
      : null;
    assert.ok(impression);
    assert.equal(impression?.data?.state, heatmap.payload.state);
  });
});

test('/v1/chat: compatibility question short-circuits to routine_simulation + conflict_heatmap', async () => {
  await withEnv({ AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED: 'true', AURORA_BFF_RETENTION_DAYS: '0' }, async () => {
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
      headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        message: 'My PM treatment is retinol. Can I add a glycolic acid toner? Check conflicts.',
        client_state: 'RECO_RESULTS',
        session: { state: 'S7_PRODUCT_RECO' },
      },
    });

    assert.equal(resp.status, 200);
    const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
    const sim = cards.find((c) => c && c.type === 'routine_simulation');
    const heatmap = cards.find((c) => c && c.type === 'conflict_heatmap');
    assert.ok(sim);
    assert.ok(heatmap);
    assert.equal(heatmap?.payload?.schema_version, 'aurora.ui.conflict_heatmap.v1');
    assert.equal(heatmap?.payload?.state, 'has_conflicts');
    assert.ok(Array.isArray(heatmap?.payload?.cells?.items));
    assert.equal(heatmap.payload.cells.items.length, 1);
    assert.ok(Array.isArray(resp.body?.events));
    assert.ok(resp.body.events.some((e) => e && e.event_name === 'aurora_conflict_heatmap_impression'));
  });
});

test('/v1/chat: conflict question ignores profile.currentRoutine without actives (uses minimal pair)', async () => {
  await withEnv({ AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED: 'true', AURORA_BFF_RETENTION_DAYS: '0' }, async () => {
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

    // Seed a routine skeleton that has steps but no actives; the chat conflict check should not rely on it.
    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        currentRoutine: {
          am: [{ step: 'Cleanser' }, { step: 'Treatment' }, { step: 'Moisturizer' }, { step: 'SPF' }],
          pm: [{ step: 'Cleanser' }, { step: 'Treatment' }, { step: 'Moisturizer' }],
        },
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        message: 'My PM treatment is retinol. Can I add a glycolic acid toner? Check conflicts.',
        client_state: 'RECO_RESULTS',
        session: { state: 'S7_PRODUCT_RECO' },
      },
    });

    assert.equal(resp.status, 200);
    const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
    const heatmap = cards.find((c) => c && c.type === 'conflict_heatmap');
    assert.ok(heatmap);
    assert.equal(heatmap?.payload?.schema_version, 'aurora.ui.conflict_heatmap.v1');
    assert.equal(heatmap?.payload?.state, 'has_conflicts');
    assert.ok(Array.isArray(heatmap?.payload?.axes?.rows?.items));
    assert.equal(heatmap.payload.axes.rows.items.length, 2);
    assert.ok(Array.isArray(heatmap?.payload?.cells?.items));
    assert.equal(heatmap.payload.cells.items.length, 1);
    assert.ok(heatmap.payload.cells.items[0].rule_ids.includes('retinoid_x_acids'));
  });
});

test('/v1/chat: conflict question ignores profile.currentRoutine even when it includes actives (uses minimal pair)', async () => {
  await withEnv({ AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED: 'true', AURORA_BFF_RETENTION_DAYS: '0' }, async () => {
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

    // Seed a routine that *does* include retinoid actives; ad-hoc conflict questions should still use a minimal pair.
    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        currentRoutine: {
          am: [{ step: 'Cleanser' }, { step: 'Moisturizer' }, { step: 'SPF' }],
          pm: [{ step: 'Treatment', key_actives: ['retinol'] }],
        },
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        message: 'My PM treatment is retinol. Can I add a glycolic acid toner? Check conflicts.',
        client_state: 'RECO_RESULTS',
        session: { state: 'S7_PRODUCT_RECO' },
      },
    });

    assert.equal(resp.status, 200);
    const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
    const heatmap = cards.find((c) => c && c.type === 'conflict_heatmap');
    assert.ok(heatmap);
    assert.equal(heatmap?.payload?.schema_version, 'aurora.ui.conflict_heatmap.v1');
    assert.equal(heatmap?.payload?.state, 'has_conflicts');
    assert.ok(Array.isArray(heatmap?.payload?.axes?.rows?.items));
    assert.equal(heatmap.payload.axes.rows.items.length, 2);
    assert.ok(Array.isArray(heatmap?.payload?.cells?.items));
    assert.equal(heatmap.payload.cells.items.length, 1);
    assert.ok(heatmap.payload.cells.items[0].rule_ids.includes('retinoid_x_acids'));
  });
});

test('Skin LLM policy: quality fail skips all LLM calls', async () => {
  const profiler = createStageProfiler();
  const base = {
    hasPrimaryInput: true,
    userRequestedPhoto: true,
    detectorConfidenceLevel: 'low',
    visionAvailable: true,
    reportAvailable: true,
    degradedMode: 'report',
    quality: { grade: 'fail', reasons: ['qc_failed'] },
  };

  const visionDecision = shouldCallLlm({ ...base, kind: 'vision' });
  const reportDecision = shouldCallLlm({ ...base, kind: 'report' });

  assert.equal(visionDecision.decision, 'skip');
  assert.equal(reportDecision.decision, 'skip');

  if (visionDecision.decision === 'call') {
    await profiler.timeLlmCall({ provider: 'test', model: 'mock', kind: 'vision' }, async () => ({ ok: true }));
  }
  if (reportDecision.decision === 'call') {
    await profiler.timeLlmCall({ provider: 'test', model: 'mock', kind: 'report' }, async () => ({ ok: true }));
  }

  const report = profiler.report();
  assert.equal(report.llm_summary.calls, 0);
});

test('Skin LLM policy: degraded calls only one model (configurable)', async () => {
  const base = {
    hasPrimaryInput: true,
    userRequestedPhoto: true,
    detectorConfidenceLevel: 'low',
    visionAvailable: true,
    reportAvailable: true,
    quality: { grade: 'degraded', reasons: ['qc_degraded'] },
  };

  {
    const profiler = createStageProfiler();
    const visionDecision = shouldCallLlm({ ...base, kind: 'vision', degradedMode: 'report' });
    const reportDecision = shouldCallLlm({ ...base, kind: 'report', degradedMode: 'report' });

    assert.equal(visionDecision.decision, 'skip');
    assert.equal(reportDecision.decision, 'call');
    assert.equal(reportDecision.downgrade_confidence, true);

    if (visionDecision.decision === 'call') {
      await profiler.timeLlmCall({ provider: 'test', model: 'mock', kind: 'vision' }, async () => ({ ok: true }));
    }
    if (reportDecision.decision === 'call') {
      await profiler.timeLlmCall({ provider: 'test', model: 'mock', kind: 'report' }, async () => ({ ok: true }));
    }
    const report = profiler.report();
    assert.equal(report.llm_summary.calls, 1);
  }

  {
    const profiler = createStageProfiler();
    const visionDecision = shouldCallLlm({ ...base, kind: 'vision', degradedMode: 'vision' });
    const reportDecision = shouldCallLlm({ ...base, kind: 'report', degradedMode: 'vision' });

    assert.equal(visionDecision.decision, 'call');
    assert.equal(reportDecision.decision, 'skip');
    assert.equal(visionDecision.downgrade_confidence, true);

    if (visionDecision.decision === 'call') {
      await profiler.timeLlmCall({ provider: 'test', model: 'mock', kind: 'vision' }, async () => ({ ok: true }));
    }
    if (reportDecision.decision === 'call') {
      await profiler.timeLlmCall({ provider: 'test', model: 'mock', kind: 'report' }, async () => ({ ok: true }));
    }
    const report = profiler.report();
    assert.equal(report.llm_summary.calls, 1);
  }
});

test('Skin LLM policy: pass skips report when detector is confident', async () => {
  const base = {
    hasPrimaryInput: true,
    userRequestedPhoto: true,
    visionAvailable: true,
    reportAvailable: true,
    degradedMode: 'report',
    quality: { grade: 'pass', reasons: ['qc_passed'] },
  };

  const reportDecision = shouldCallLlm({ ...base, kind: 'report', detectorConfidenceLevel: 'high' });
  assert.equal(reportDecision.decision, 'skip');

  const reportDecisionUncertain = shouldCallLlm({ ...base, kind: 'report', detectorConfidenceLevel: 'low' });
  assert.equal(reportDecisionUncertain.decision, 'call');
});

test('Skin LLM policy: explicit uncertainty flag tightens LLM calls on pass quality', async () => {
  const base = {
    hasPrimaryInput: true,
    userRequestedPhoto: true,
    visionAvailable: true,
    reportAvailable: true,
    degradedMode: 'report',
    quality: { grade: 'pass', reasons: ['qc_passed'] },
  };

  // If deterministic policy says "not uncertain", skip even if the confidence level is not "high".
  const reportSkip = shouldCallLlm({
    ...base,
    kind: 'report',
    detectorConfidenceLevel: 'low',
    uncertainty: false,
  });
  assert.equal(reportSkip.decision, 'skip');

  // If deterministic policy says "uncertain", allow calling even when confidence level is high.
  const reportCall = shouldCallLlm({
    ...base,
    kind: 'report',
    detectorConfidenceLevel: 'high',
    uncertainty: true,
  });
  assert.equal(reportCall.decision, 'call');

  // Vision LMM should also be skippable when detector is confident and explicitly not uncertain.
  const visionSkip = shouldCallLlm({
    ...base,
    kind: 'vision',
    detectorConfidenceLevel: 'high',
    uncertainty: false,
  });
  assert.equal(visionSkip.decision, 'skip');
});

test('Diag rollout: bucket is stable and within 0..99', async () => {
  const a = hashToBucket0to99('req_abc');
  const b = hashToBucket0to99('req_abc');
  assert.equal(a, b);
  assert.equal(a >= 0 && a < 100, true);
});

test('Diag rollout: DIAG_PIPELINE_VERSION overrides canary', async () => {
  withEnv(
    {
      DIAG_PIPELINE_VERSION: 'v2',
      DIAG_SHADOW_MODE: 'false',
      DIAG_CANARY_PERCENT: '0',
      LLM_KILL_SWITCH: 'false',
    },
    () => {
      const d = getDiagRolloutDecision({ requestId: 'req_any' });
      assert.equal(d.selectedVersion, 'v2');
      assert.equal(d.reason, 'forced');
      assert.equal(d.shadowMode, false);
      assert.equal(d.llmKillSwitch, false);
    },
  );
});

test('Diag rollout: canary percent selects v2', async () => {
  withEnv({ DIAG_PIPELINE_VERSION: '', DIAG_CANARY_PERCENT: '100', DIAG_SHADOW_MODE: 'true', LLM_KILL_SWITCH: 'true' }, () => {
    const d = getDiagRolloutDecision({ requestId: 'req_any' });
    assert.equal(d.selectedVersion, 'v2');
    assert.equal(d.reason, 'canary');
    assert.equal(d.shadowMode, true);
    assert.equal(d.llmKillSwitch, true);
  });

  withEnv({ DIAG_PIPELINE_VERSION: '', DIAG_CANARY_PERCENT: '0', DIAG_SHADOW_MODE: 'false', LLM_KILL_SWITCH: 'false' }, () => {
    const d = getDiagRolloutDecision({ requestId: 'req_any' });
    assert.equal(d.selectedVersion, 'legacy');
    assert.equal(d.reason, 'default');
  });
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

test('/v1/chat: strips internal kb: citations from recommendations (non-debug)', async () => {
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

  const baseBody = {
    action: {
      action_id: 'chip.start.routine',
      kind: 'chip',
      data: {
        reply_text: 'Build an AM/PM routine',
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
  };

  const respNoDebug = await invokeRoute(app, 'POST', '/v1/chat', {
    headers: { 'X-Aurora-UID': 'test_uid_kb_strip_1', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief' },
    body: baseBody,
  });
  assert.equal(respNoDebug.status, 200);
  assert.equal(JSON.stringify(respNoDebug.body).includes('kb:'), false);

  const cardsNoDebug = Array.isArray(respNoDebug.body?.cards) ? respNoDebug.body.cards : [];
  const recoNoDebug = cardsNoDebug.find((c) => c && c.type === 'recommendations');
  assert.ok(recoNoDebug);
  const firstNoDebug = Array.isArray(recoNoDebug?.payload?.recommendations) ? recoNoDebug.payload.recommendations[0] : null;
  assert.ok(firstNoDebug);
  assert.ok(Array.isArray(firstNoDebug?.evidence_pack?.citations));
  assert.equal(firstNoDebug.evidence_pack.citations.length, 0);

  const respDebug = await invokeRoute(app, 'POST', '/v1/chat', {
    headers: { 'X-Aurora-UID': 'test_uid_kb_strip_2', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Debug': 'true' },
    body: { ...baseBody, debug: true },
  });
  assert.equal(respDebug.status, 200);
  assert.equal(JSON.stringify(respDebug.body).includes('kb:'), true);

  const cardsDebug = Array.isArray(respDebug.body?.cards) ? respDebug.body.cards : [];
  const recoDebug = cardsDebug.find((c) => c && c.type === 'recommendations');
  assert.ok(recoDebug);
  const firstDebug = Array.isArray(recoDebug?.payload?.recommendations) ? recoDebug.payload.recommendations[0] : null;
  assert.ok(firstDebug);
  assert.ok(Array.isArray(firstDebug?.evidence_pack?.citations));
  assert.ok(firstDebug.evidence_pack.citations.some((c) => String(c).startsWith('kb:')));
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

test('/v1/chat: weather question short-circuits to env_stress (trigger_source=text)', async () => {
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
    headers: { 'X-Aurora-UID': 'test_uid_env_1', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
    body: {
      message: '明天要下雪，我应该注意什么？',
      // Simulate being mid-flow: should still short-circuit instead of calling upstream/diagnosis routing.
      client_state: 'DIAG_PROFILE',
      session: { state: 'S7_PRODUCT_RECO' },
      language: 'CN',
    },
  });

  assert.equal(resp.status, 200);
  assert.ok(Array.isArray(resp.body?.cards));
  assert.ok(Array.isArray(resp.body?.suggested_chips));

  const envStress = resp.body.cards.find((c) => c && c.type === 'env_stress');
  assert.ok(envStress);
  assert.equal(envStress?.payload?.schema_version, 'aurora.ui.env_stress.v1');

  assert.equal(typeof resp.body?.assistant_message?.content, 'string');
  assert.match(resp.body.assistant_message.content, /对应产品清单/);
  assert.match(resp.body.assistant_message.content, /防晒/);
  assert.match(resp.body.assistant_message.content, /润唇/);

  assert.ok(resp.body.suggested_chips.some((c) => c && c.chip_id === 'chip.start.routine'));
  assert.ok(resp.body.suggested_chips.some((c) => c && c.chip_id === 'chip.start.reco_products'));

  const vm = (resp.body?.events || []).find((e) => e && e.event_name === 'value_moment') || null;
  assert.ok(vm);
  assert.equal(vm?.data?.kind, 'weather_advice');
  assert.equal(vm?.data?.scenario, 'snow');
});

test('/v1/chat: weather question short-circuits to env_stress (trigger_source=text_explicit)', async () => {
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
    headers: { 'X-Aurora-UID': 'test_uid_env_2', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
    body: {
      // Contains "推荐" -> trigger_source=text_explicit. Should still go to env-stress, not upstream.
      message: '下雪天推荐我怎么护肤？',
      session: { state: 'S7_PRODUCT_RECO' },
      language: 'CN',
    },
  });

  assert.equal(resp.status, 200);
  assert.ok(Array.isArray(resp.body?.cards));
  assert.ok(Array.isArray(resp.body?.suggested_chips));

  const envStress = resp.body.cards.find((c) => c && c.type === 'env_stress');
  assert.ok(envStress);
  assert.equal(envStress?.payload?.schema_version, 'aurora.ui.env_stress.v1');

  assert.equal(typeof resp.body?.assistant_message?.content, 'string');
  assert.match(resp.body.assistant_message.content, /对应产品清单/);
  assert.match(resp.body.assistant_message.content, /防晒/);
  assert.match(resp.body.assistant_message.content, /润唇/);

  assert.ok(resp.body.suggested_chips.some((c) => c && c.chip_id === 'chip.start.routine'));
  assert.ok(resp.body.suggested_chips.some((c) => c && c.chip_id === 'chip.start.reco_products'));

  const vm = (resp.body?.events || []).find((e) => e && e.event_name === 'value_moment') || null;
  assert.ok(vm);
  assert.equal(vm?.data?.kind, 'weather_advice');
  assert.equal(vm?.data?.scenario, 'snow');
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

test('/v1/dupe/compare: returns tradeoffs (prefers structured alternatives)', async () => {
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
  assert.ok(tradeoffs.some((t) => /missing actives|added benefits|texture/i.test(String(t || ''))));
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
  assert.ok(
    tradeoffs.some((t) =>
      /compared to original|dupe adds|texture|irritation risk|fragrance risk|dupe risk notes|hero ingredient shift|key ingredient emphasis|no tradeoff details were returned/i.test(
        String(t || ''),
      ),
    ),
  );
});

test('/v1/dupe/compare: dupe not in alternatives uses human tradeoffs (no raw diff)', async () => {
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
      dupe: { brand: 'OtherBrand', name: 'Some Other Product' },
    },
  });

  assert.equal(resp.status, 200);
  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const card = cards.find((c) => c && c.type === 'dupe_compare');
  assert.ok(card);

  const tradeoffs = Array.isArray(card.payload?.tradeoffs) ? card.payload.tradeoffs : [];
  assert.ok(tradeoffs.length > 0);
  assert.ok(tradeoffs.every((t) => !/missing actives vs original|added actives/i.test(String(t || ''))));
});

test('/v1/analysis/skin: qc fail returns retake analysis (no guesses)', async () => {
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
    headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
    body: {
      use_photo: true,
      currentRoutine: 'AM: gentle cleanser + SPF. PM: gentle cleanser + adapalene + moisturizer.',
      photos: [{ slot_id: 'daylight', photo_id: 'photo_1', qc_status: 'fail' }],
    },
  });

  assert.equal(resp.status, 200);
  assert.ok(resp.body);
  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const card = cards.find((c) => c && c.type === 'analysis_summary');
  assert.ok(card);

  assert.equal(card.payload.analysis_source, 'retake');
  assert.equal(card.payload?.quality_report?.photo_quality?.grade, 'fail');
  assert.equal(card.payload?.quality_report?.llm?.vision?.decision, 'skip');
  assert.equal(card.payload?.quality_report?.llm?.report?.decision, 'skip');
  assert.equal(Array.isArray(card.payload?.analysis?.features), true);
  assert.match(String(card.payload.analysis.features[0].observation || ''), /photo/i);
});
