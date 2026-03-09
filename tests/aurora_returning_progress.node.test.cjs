const test = require('node:test');
const assert = require('node:assert/strict');

const {
  withEnv,
  buildTestUid,
  headersFor,
  createAppWithPatchedAuroraChat,
  seedCompleteProfile,
  createDiagnosisArtifactFixture,
  seedDiagnosisArtifactForUid,
} = require('./aurora_bff_test_harness.cjs');

function findCard(body, type) {
  const cards = Array.isArray(body && body.cards) ? body.cards : [];
  return cards.find((card) => card && card.type === type) || null;
}

function findSection(card, kind) {
  const sections = Array.isArray(card && card.sections) ? card.sections : [];
  return sections.find((section) => section && section.kind === kind) || null;
}

function quickReplyIds(body) {
  return (Array.isArray(body && body.suggested_quick_replies) ? body.suggested_quick_replies : [])
    .map((item) => String(item && item.id ? item.id : '').trim())
    .filter(Boolean);
}

function experimentEventTypes(body) {
  return (Array.isArray(body && body.ops && body.ops.experiment_events) ? body.ops.experiment_events : [])
    .map((evt) => String(evt && evt.event_type ? evt.event_type : '').trim())
    .filter(Boolean);
}

function collectProgressTexts(card) {
  const out = [];
  for (const section of Array.isArray(card && card.sections) ? card.sections : []) {
    if (!section || typeof section !== 'object') continue;
    if (Array.isArray(section.concern_deltas)) {
      for (const row of section.concern_deltas) {
        if (!row || typeof row !== 'object') continue;
        out.push(String(row.note_en || '').trim(), String(row.note_zh || '').trim());
      }
    }
    if (Array.isArray(section.improvements)) out.push(...section.improvements.map((row) => String(row || '').trim()));
    if (Array.isArray(section.regressions)) out.push(...section.regressions.map((row) => String(row || '').trim()));
    if (Array.isArray(section.stable)) out.push(...section.stable.map((row) => String(row || '').trim()));
    if (typeof section.text_en === 'string') out.push(section.text_en.trim());
    if (typeof section.text_zh === 'string') out.push(section.text_zh.trim());
  }
  return out.filter(Boolean);
}

async function seedProgressLogs(request, uid) {
  await request
    .post('/v1/tracker/log')
    .set(headersFor(uid))
    .send({ date: '2026-03-01', acne: 4, redness: 3, hydration: 2, notes: 'baseline' })
    .expect(200);
  await request
    .post('/v1/tracker/log')
    .set(headersFor(uid))
    .send({ date: '2026-03-08', acne: 2, redness: 2, hydration: 4, notes: 'improved' })
    .expect(200);
}

test('/v1/chat returning diagnosis entry emits returning_triage with LLM summary and actions', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
      AURORA_CHATCARDS_RESPONSE_CONTRACT: 'dual',
    },
    async () => {
      const { request, restore } = createAppWithPatchedAuroraChat(async ({ query }) => {
        if (String(query || '').includes('Template: diagnosis_v2_returning_summary')) {
          return {
            answer: JSON.stringify({
              summary_en: 'Your skin baseline points to oily, acne-prone skin with hydration as a secondary goal.',
              summary_zh: '你的历史基线显示偏油、易长痘，同时补水也是次优先目标。',
            }),
          };
        }
        return { answer: 'Mock Aurora reply.', cards: [{ type: 'recommendations', payload: { recommendations: [{ sku_id: 'mock_sku_generic' }] } }] };
      });

      try {
        const uid = buildTestUid('returning_triage');
        await seedCompleteProfile(request, uid);
        await seedDiagnosisArtifactForUid(uid, createDiagnosisArtifactFixture({ usePhoto: true }));

        const res = await request
          .post('/v1/chat')
          .set(headersFor(uid))
          .send({
            action: {
              action_id: 'chip.start.diagnosis',
              kind: 'chip',
              data: { reply_text: 'Start diagnosis' },
            },
          })
          .expect(200);

        assert.equal(res.body.version, '1.0');
        const card = findCard(res.body, 'returning_triage');
        assert.ok(card);
        const summary = findSection(card, 'previous_diagnosis_summary');
        assert.ok(summary);
        assert.equal(typeof summary.summary_text, 'string');
        assert.ok(summary.summary_text.length > 0);
        assert.deepEqual(
          quickReplyIds(res.body).filter((id) => id.startsWith('chip.action.')).sort(),
          ['chip.action.check_progress', 'chip.action.new_photo', 'chip.action.reassess', 'chip.action.update_goals'],
        );
        assert.equal(Array.isArray(card.actions), true);
        assert.equal(card.actions.length, 4);
      } finally {
        restore();
      }
    },
  );
});

test('/v1/chat returning_triage falls back to summary_text=null when LLM output is unavailable', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
      AURORA_CHATCARDS_RESPONSE_CONTRACT: 'dual',
    },
    async () => {
      const { request, restore } = createAppWithPatchedAuroraChat(async ({ query }) => {
        if (String(query || '').includes('Template: diagnosis_v2_returning_summary')) {
          throw new Error('forced llm failure');
        }
        return { answer: 'Mock Aurora reply.', cards: [{ type: 'recommendations', payload: { recommendations: [{ sku_id: 'mock_sku_generic' }] } }] };
      });

      try {
        const uid = buildTestUid('returning_triage_fallback');
        await seedCompleteProfile(request, uid);
        await seedDiagnosisArtifactForUid(uid, createDiagnosisArtifactFixture({ usePhoto: false }));

        const res = await request
          .post('/v1/chat')
          .set(headersFor(uid))
          .send({
            action: {
              action_id: 'chip.start.diagnosis',
              kind: 'chip',
              data: { reply_text: 'Start diagnosis' },
            },
          })
          .expect(200);

        const card = findCard(res.body, 'returning_triage');
        const summary = findSection(card, 'previous_diagnosis_summary');
        assert.ok(summary);
        assert.equal(summary.summary_text, null);
      } finally {
        restore();
      }
    },
  );
});

test('/v1/chat chip.action.update_goals forces a goals-only diagnosis gate for returning users', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
      AURORA_CHATCARDS_RESPONSE_CONTRACT: 'dual',
    },
    async () => {
      const { request, restore } = createAppWithPatchedAuroraChat();
      try {
        const uid = buildTestUid('update_goals');
        await seedCompleteProfile(request, uid);
        await seedDiagnosisArtifactForUid(uid, createDiagnosisArtifactFixture({ usePhoto: false }));

        const res = await request
          .post('/v1/chat')
          .set(headersFor(uid))
          .send({
            action: {
              action_id: 'chip.action.update_goals',
              kind: 'chip',
              data: { reply_text: 'Update my goals' },
            },
          })
          .expect(200);

        const card = findCard(res.body, 'diagnosis_gate');
        assert.ok(card);
        const ids = quickReplyIds(res.body);
        assert.ok(ids.some((id) => id.startsWith('profile.goals.')));
        assert.match(String(res.body.assistant_text || ''), /goal/i);
      } finally {
        restore();
      }
    },
  );
});

test('/v1/chat chip.action.check_progress emits skin_progress with experiment event and four sections', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
      AURORA_CHATCARDS_RESPONSE_CONTRACT: 'dual',
    },
    async () => {
      const { request, restore } = createAppWithPatchedAuroraChat(async ({ query }) => {
        if (String(query || '').includes('Template: diagnosis_v2_progress_delta')) {
          return {
            answer: JSON.stringify({
              overall_trend: 'improving',
              concern_deltas: [
                {
                  concern_id: 'acne',
                  direction: 'improved',
                  magnitude: 'moderate',
                  note_en: 'Acne looks calmer across recent check-ins.',
                  note_zh: '最近几次打卡里，痘痘整体更稳定了。',
                },
              ],
              confidence: 0.78,
              checkins_analyzed: 2,
              improvements: ['Acne flare frequency is down.'],
              regressions: [],
              stable: ['Redness is broadly stable.'],
              recommendation_en: 'Keep your routine stable for one more week and log one more check-in.',
              recommendation_zh: '再稳定一周当前 routine，并补一次打卡。',
            }),
          };
        }
        return { answer: 'Mock Aurora reply.' };
      });

      try {
        const uid = buildTestUid('skin_progress');
        await seedCompleteProfile(request, uid);
        await seedDiagnosisArtifactForUid(uid, createDiagnosisArtifactFixture({ usePhoto: true }));
        await seedProgressLogs(request, uid);

        const res = await request
          .post('/v1/chat')
          .set(headersFor(uid))
          .send({
            action: {
              action_id: 'chip.action.check_progress',
              kind: 'chip',
              data: { reply_text: 'Check my progress' },
            },
          })
          .expect(200);

        const card = findCard(res.body, 'skin_progress');
        assert.ok(card);
        const sectionKinds = (Array.isArray(card.sections) ? card.sections : []).map((section) => section && section.kind);
        assert.deepEqual(sectionKinds, ['progress_baseline', 'progress_delta', 'progress_highlights', 'progress_recommendation']);
        assert.equal((res.body.ops && res.body.ops.thread_ops && res.body.ops.thread_ops[0] && res.body.ops.thread_ops[0].summary) || 'progress_viewed', 'progress_viewed');
        assert.ok(experimentEventTypes(res.body).includes('progress_viewed'));
      } finally {
        restore();
      }
    },
  );
});

test('/v1/chat skin_progress rejects no-photo hallucinations and falls back to deterministic text', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
      AURORA_CHATCARDS_RESPONSE_CONTRACT: 'dual',
    },
    async () => {
      const { request, restore } = createAppWithPatchedAuroraChat(async ({ query }) => {
        if (String(query || '').includes('Template: diagnosis_v2_progress_delta')) {
          return {
            answer: JSON.stringify({
              overall_trend: 'improving',
              concern_deltas: [
                {
                  concern_id: 'acne',
                  direction: 'improved',
                  magnitude: 'moderate',
                  note_en: 'Your photo shows fewer breakouts than before.',
                  note_zh: '从照片看，痘痘比之前少了。',
                },
              ],
              confidence: 0.72,
              checkins_analyzed: 2,
              improvements: ['The photo suggests clearer skin.'],
              regressions: [],
              stable: [],
              recommendation_en: 'Your photo shows clear progress.',
              recommendation_zh: '你的照片显示进展不错。',
            }),
          };
        }
        return { answer: 'Mock Aurora reply.' };
      });

      try {
        const uid = buildTestUid('skin_progress_guard');
        await seedCompleteProfile(request, uid);
        await seedDiagnosisArtifactForUid(uid, createDiagnosisArtifactFixture({ usePhoto: false }));
        await seedProgressLogs(request, uid);

        const res = await request
          .post('/v1/chat')
          .set(headersFor(uid))
          .send({
            action: {
              action_id: 'chip.action.check_progress',
              kind: 'chip',
              data: { reply_text: 'Check my progress' },
            },
          })
          .expect(200);

        const card = findCard(res.body, 'skin_progress');
        assert.ok(card);
        const texts = collectProgressTexts(card).join('\n');
        assert.doesNotMatch(texts, /photo|image|visible|looks?|appears?|从照片|照片|图片/i);
      } finally {
        restore();
      }
    },
  );
});

test('/v1/chat check_progress without baseline routes back to diagnosis gate behavior', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHATCARDS_RESPONSE_CONTRACT: 'dual',
    },
    async () => {
      const { request, restore } = createAppWithPatchedAuroraChat();
      try {
        const uid = buildTestUid('progress_needs_baseline');
        const res = await request
          .post('/v1/chat')
          .set(headersFor(uid))
          .send({
            action: {
              action_id: 'chip.action.check_progress',
              kind: 'chip',
              data: { reply_text: 'Check my progress' },
            },
          })
          .expect(200);

        assert.equal(findCard(res.body, 'skin_progress'), null);
        assert.ok(findCard(res.body, 'diagnosis_gate') || findCard(res.body, 'confidence_notice'));
      } finally {
        restore();
      }
    },
  );
});
