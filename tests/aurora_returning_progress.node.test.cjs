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
  const sections = Array.isArray(card && card.sections)
    ? card.sections
    : Array.isArray(card && card.payload && card.payload.sections)
      ? card.payload.sections
      : [];
  return sections.find((section) => section && section.kind === kind) || null;
}

function cardSections(card) {
  if (Array.isArray(card && card.sections)) return card.sections;
  if (Array.isArray(card && card.payload && card.payload.sections)) return card.payload.sections;
  return [];
}

function cardActions(card) {
  if (Array.isArray(card && card.actions)) return card.actions;
  if (Array.isArray(card && card.payload && card.payload.actions)) return card.payload.actions;
  return [];
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
  for (const section of cardSections(card)) {
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

function okJson(json) {
  return {
    ok: true,
    json,
    parse_status: 'parsed',
    timeout_stage: null,
  };
}

function failJson(reason = 'forced_failure', detail = null) {
  return {
    ok: false,
    reason,
    detail,
  };
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
      const { request, restore } = createAppWithPatchedAuroraChat({
        geminiJsonImpl: async ({ userPrompt }) => {
          if (String(userPrompt || '').includes('Template: diagnosis_v2_returning_summary')) {
            return okJson({
              summary_en: 'Your skin baseline points to oily, acne-prone skin with hydration as a secondary goal.',
              summary_zh: '你的历史基线显示偏油、易长痘，同时补水也是次优先目标。',
            });
          }
          return failJson('unexpected_prompt');
        },
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
        assert.equal(Array.isArray(cardActions(card)), true);
        assert.equal(cardActions(card).length, 4);
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
      const { request, restore } = createAppWithPatchedAuroraChat({
        geminiJsonImpl: async ({ userPrompt }) => {
          if (String(userPrompt || '').includes('Template: diagnosis_v2_returning_summary')) {
            return failJson('forced_llm_failure', 'forced llm failure');
          }
          return failJson('unexpected_prompt');
        },
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

test('/v1/chat returning_triage recovers summary_text from truncated LLM json when possible', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
      AURORA_CHATCARDS_RESPONSE_CONTRACT: 'dual',
    },
    async () => {
      const { request, restore } = createAppWithPatchedAuroraChat({
        geminiJsonImpl: async ({ userPrompt }) => {
          if (String(userPrompt || '').includes('Template: diagnosis_v2_returning_summary')) {
            return {
              ok: false,
              reason: 'PARSE_TRUNCATED_JSON',
              detail: 'finish_reason=MAX_TOKENS',
              parse_status: 'parse_truncated',
              raw_text: '{"summary_text":"Oily, acne-prone baseline with hydration still worth tracking',
            };
          }
          return failJson('unexpected_prompt');
        },
      });

      try {
        const uid = buildTestUid('returning_triage_recovered');
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
        assert.equal(typeof summary.summary_text, 'string');
        assert.match(summary.summary_text, /Oily, acne-prone baseline/i);
      } finally {
        restore();
      }
    },
  );
});

test('/v1/chat returning_triage falls back to deterministic summary text for truncated LLM output without recoverable json', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
      AURORA_CHATCARDS_RESPONSE_CONTRACT: 'dual',
    },
    async () => {
      const { request, restore } = createAppWithPatchedAuroraChat({
        geminiJsonImpl: async ({ userPrompt }) => {
          if (String(userPrompt || '').includes('Template: diagnosis_v2_returning_summary')) {
            return {
              ok: false,
              reason: 'PARSE_TRUNCATED_JSON',
              detail: 'finish_reason=MAX_TOKENS',
              parse_status: 'parse_truncated',
              raw_text: 'Here is the JSON requested: {"partial": true',
            };
          }
          return failJson('unexpected_prompt');
        },
      });

      try {
        const uid = buildTestUid('returning_triage_deterministic');
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
        assert.equal(typeof summary.summary_text, 'string');
        assert.match(summary.summary_text, /baseline|goals|check-ins/i);
      } finally {
        restore();
      }
    },
  );
});

test('/v1/chat chip_start_diagnosis also emits returning_triage for returning users', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
      AURORA_CHATCARDS_RESPONSE_CONTRACT: 'dual',
    },
    async () => {
      const { request, restore } = createAppWithPatchedAuroraChat({
        geminiJsonImpl: async ({ userPrompt }) => {
          if (String(userPrompt || '').includes('Template: diagnosis_v2_returning_summary')) {
            return okJson({
              summary_en: 'Baseline is ready for a returning triage check.',
              summary_zh: '已准备好老用户分流摘要。',
            });
          }
          return failJson('unexpected_prompt');
        },
      });

      try {
        const uid = buildTestUid('returning_triage_alias');
        await seedCompleteProfile(request, uid);
        await seedDiagnosisArtifactForUid(uid, createDiagnosisArtifactFixture({ usePhoto: true }));

        const res = await request
          .post('/v1/chat')
          .set(headersFor(uid))
          .send({
            action: {
              action_id: 'chip_start_diagnosis',
              kind: 'chip',
              data: { reply_text: 'Start diagnosis' },
            },
          })
          .expect(200);

        assert.ok(findCard(res.body, 'returning_triage'));
      } finally {
        restore();
      }
    },
  );
});

test('/v1/chat explicit diagnosis text emits returning_triage for returning users', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
      AURORA_CHATCARDS_RESPONSE_CONTRACT: 'dual',
    },
    async () => {
      const { request, restore } = createAppWithPatchedAuroraChat({
        geminiJsonImpl: async ({ userPrompt }) => {
          if (String(userPrompt || '').includes('Template: diagnosis_v2_returning_summary')) {
            return okJson({
              summary_en: 'This is the returning-user summary for a text-triggered diagnosis.',
              summary_zh: '这是文本触发诊断时的老用户摘要。',
            });
          }
          return failJson('unexpected_prompt');
        },
      });

      try {
        const uid = buildTestUid('returning_triage_text');
        await seedCompleteProfile(request, uid);
        await seedDiagnosisArtifactForUid(uid, createDiagnosisArtifactFixture({ usePhoto: false }));

        const res = await request
          .post('/v1/chat')
          .set(headersFor(uid))
          .send({ message: 'I want to start a skin diagnosis again.' })
          .expect(200);

        const card = findCard(res.body, 'returning_triage');
        assert.ok(card);
        const summary = findSection(card, 'previous_diagnosis_summary');
        assert.equal(typeof summary.summary_text, 'string');
        assert.ok(summary.summary_text.length > 0);
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
      const { request, restore } = createAppWithPatchedAuroraChat({
        geminiJsonImpl: async ({ userPrompt }) => {
          if (String(userPrompt || '').includes('Template: diagnosis_v2_progress_delta')) {
            return okJson({
              overall_trend: 'improving',
              concern_deltas: [
                {
                  concern_id: 'acne',
                  direction: 'improved',
                  magnitude: 'moderate',
                  note_en: 'Acne has been calmer across recent check-ins.',
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
            });
          }
          return failJson('unexpected_prompt');
        },
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
        const sectionKinds = cardSections(card).map((section) => section && section.kind);
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
      const { request, restore } = createAppWithPatchedAuroraChat({
        geminiJsonImpl: async ({ userPrompt }) => {
          if (String(userPrompt || '').includes('Template: diagnosis_v2_progress_delta')) {
            return okJson({
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
            });
          }
          return failJson('unexpected_prompt');
        },
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
        assert.doesNotMatch(texts, /photo|image|picture|visual|visible|looks?|appears?|show(?:s|ing)?|从照片|照片|图片|看起来|显示出/i);
      } finally {
        restore();
      }
    },
  );
});

test('/v1/chat skin_progress stays photo-agnostic when LLM is unavailable', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
      AURORA_CHATCARDS_RESPONSE_CONTRACT: 'dual',
    },
    async () => {
      const { request, restore } = createAppWithPatchedAuroraChat({
        geminiJsonImpl: async ({ userPrompt }) => {
          if (String(userPrompt || '').includes('Template: diagnosis_v2_progress_delta')) {
            return failJson('forced_llm_failure', 'progress llm unavailable');
          }
          return failJson('unexpected_prompt');
        },
      });

      try {
        const uid = buildTestUid('skin_progress_llm_failure');
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
        assert.doesNotMatch(texts, /photo|image|picture|visual|visible|looks?|appears?|show(?:s|ing)?|从照片|照片|图片|看起来|显示出/i);
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
