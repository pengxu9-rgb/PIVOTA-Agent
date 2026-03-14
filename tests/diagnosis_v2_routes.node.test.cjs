'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

function loadMountDiagnosisV2Routes() {
  const moduleIds = [
    require.resolve('../src/auroraBff/gating'),
    require.resolve('../src/auroraBff/diagnosisV2Orchestrator'),
    require.resolve('../src/auroraBff/diagnosisV2Routes'),
  ];
  moduleIds.forEach((id) => {
    delete require.cache[id];
  });
  return require('../src/auroraBff/diagnosisV2Routes').mountDiagnosisV2Routes;
}

function makeProvider() {
  let callCount = 0;
  const responses = [
    JSON.stringify({
      goal_profile: { constraints: [] },
      followup_questions: [
        {
          id: 'q1',
          question: 'Skin state?',
          options: [{ id: 'a', label: 'Good' }, { id: 'b', label: 'Bad' }],
        },
      ],
    }),
    JSON.stringify({
      inferred_state: {
        axes: [
          { axis: 'barrier_irritation_risk', level: 'moderate', confidence: 0.4, evidence: ['user reports redness'], trend: 'new' },
        ],
      },
      data_quality: { overall: 'medium', limits_banner: 'Enough data.' },
    }),
    JSON.stringify({
      strategies: [
        {
          title: 'Gentle repair',
          why: 'Repair barrier',
          timeline: '2-4 weeks',
          do_list: ['Barrier cream'],
          avoid_list: ['Strong acids'],
        },
      ],
      routine_blueprint: {
        am_steps: ['Gentle cleanser', 'Moisturizer', 'SPF'],
        pm_steps: ['Gentle cleanser', 'Barrier serum', 'Moisturizer'],
        conflict_rules: [],
      },
      next_actions: [{ type: 'direct_reco', label: 'See recommendations' }],
      improvement_path: [{ tip: 'Add a photo', action_type: 'take_photo', action_label: 'Add photo' }],
    }),
  ];
  return {
    isAvailable: () => true,
    generate: async () => ({ provider: 'mock', text: responses[Math.min(callCount++, responses.length - 1)] }),
  };
}

function extractSseEventPayload(text, eventName) {
  const pattern = new RegExp(`event: ${eventName}\\ndata: (.+)\\n\\n`);
  const match = String(text || '').match(pattern);
  return match ? JSON.parse(match[1]) : null;
}

test('diagnosis_v2 answer SSE returns latest_artifact_id and artifact_persistence in session patch', async () => {
  const previousDiag = process.env.DIAGNOSIS_V2_ENABLED;
  const previousRetention = process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS;
  process.env.DIAGNOSIS_V2_ENABLED = 'true';
  process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS = '0';

  try {
    const mountDiagnosisV2Routes = loadMountDiagnosisV2Routes();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountDiagnosisV2Routes(app, { logger: null, llmProvider: makeProvider() });

    const response = await supertest(app)
      .post('/v1/diagnosis/answer')
      .set('X-Aurora-UID', `uid_diag_route_${Date.now()}`)
      .send({
        goals: ['barrier_repair'],
        followup_answers: {},
        skip_photo: true,
        language: 'EN',
      })
      .expect(200);

    const resultPayload = extractSseEventPayload(response.text, 'result');
    assert.ok(resultPayload);
    assert.ok(resultPayload.session_patch);
    assert.ok(String(resultPayload.session_patch.state && resultPayload.session_patch.state.latest_artifact_id || '').trim());
    assert.equal(resultPayload.session_patch.meta && resultPayload.session_patch.meta.artifact_persistence && resultPayload.session_patch.meta.artifact_persistence.persisted, true);
    assert.equal(resultPayload.session_patch.meta && resultPayload.session_patch.meta.artifact_persistence && resultPayload.session_patch.meta.artifact_persistence.storage_mode, 'ephemeral');
    assert.ok(resultPayload.session_patch.meta && resultPayload.session_patch.meta.analysis_context_snapshot);
  } finally {
    if (previousDiag === undefined) delete process.env.DIAGNOSIS_V2_ENABLED;
    else process.env.DIAGNOSIS_V2_ENABLED = previousDiag;
    if (previousRetention === undefined) delete process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS;
    else process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS = previousRetention;
  }
});
