const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');

const {
  sleep,
  withEnv,
  buildTestUid,
  headersFor,
  createAppWithPatchedAuroraChat,
  seedCompleteProfile,
  parseCards,
  findCard,
  createDiagnosisArtifactFixture,
  seedDiagnosisArtifactForUid,
} = require('./aurora_bff_test_harness.cjs');

const schemaPath = path.join(__dirname, 'contracts', 'aurora_chat_envelope.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateEnvelope = ajv.compile(schema);

function assertEnvelopeValid(body) {
  const ok = validateEnvelope(body);
  if (ok) return;
  const errs = (validateEnvelope.errors || []).map((err) => `${err.instancePath} ${err.message}`).join('; ');
  assert.fail(`schema validation failed: ${errs}`);
}

function assertNoticeReason(cards, expectedReason) {
  const notice = findCard(cards, 'confidence_notice');
  assert.ok(
    notice,
    `confidence_notice card must exist; card_types=${(Array.isArray(cards) ? cards : []).map((c) => c && c.type).join(',')}`,
  );
  assert.equal(notice.payload && notice.payload.reason, expectedReason);
  assert.ok(Array.isArray(notice.payload && notice.payload.actions), 'notice.actions must exist');
}

function looksTreatmentOrHighIrritation(rec) {
  const row = rec && typeof rec === 'object' ? rec : {};
  const bucket = [
    row.step,
    row.slot,
    row.category,
    row.name,
    row.title,
    row.sku && row.sku.name,
    ...(Array.isArray(row.notes) ? row.notes : []),
    ...(Array.isArray(row.reasons) ? row.reasons : []),
  ]
    .filter((x) => x != null)
    .map((x) => String(x).toLowerCase())
    .join(' | ');
  return /\b(treatment|retinoid|retinol|retinal|tretinoin|adapalene|aha|bha|salicylic|glycolic|lactic|mandelic|peel|resurfacing)\b/.test(bucket);
}

async function setupRecoHarnessWithArtifact({
  auroraChatImpl,
  uidSeed,
  seedArtifact = true,
  artifactScore = 0.86,
  artifactLevel,
  artifactSource = 'rule_based',
  artifactUsePhoto = true,
}) {
  const harness = createAppWithPatchedAuroraChat(auroraChatImpl);
  const uid = buildTestUid(uidSeed);
  await seedCompleteProfile(harness.request, uid, 'EN');
  if (seedArtifact) {
    await seedDiagnosisArtifactForUid(
      uid,
      createDiagnosisArtifactFixture({
        confidenceScore: artifactScore,
        confidenceLevel: artifactLevel,
        analysisSource: artifactSource,
        usePhoto: artifactUsePhoto,
        qualityGrade: artifactUsePhoto ? 'pass' : 'degraded',
      }),
    );
  }
  return { harness, uid };
}

test('P2-1 contract: reco envelope validates in recommendations mode', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
      AURORA_PRODUCT_MATCHER_ENABLED: 'false',
    },
    async () => {
      const { harness, uid } = await setupRecoHarnessWithArtifact({
        auroraChatImpl: null,
        uidSeed: 'contract_reco',
      });

      try {
        const resp = await harness.request
          .post('/v1/chat')
          .set(headersFor(uid, 'EN'))
          .send({
            message: 'recommend products',
            action: { action_id: 'chip.start.reco_products', kind: 'chip', data: {} },
            language: 'EN',
            session: { state: 'idle' },
          })
          .expect(200);

        assertEnvelopeValid(resp.body);
        const cards = parseCards(resp.body);
        const reco = findCard(cards, 'recommendations');
        assert.ok(reco, 'recommendations card must exist');
      } finally {
        harness.restore();
      }
    },
  );
});

test('P2-1 contract: reco timeout degrades to confidence_notice(timeout_degraded)', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_PRODUCT_MATCHER_ENABLED: 'false',
      AURORA_BFF_CHAT_RECO_BUDGET_MS: '1000',
    },
    async () => {
      const { harness, uid } = await setupRecoHarnessWithArtifact({
        auroraChatImpl: async () => {
          await sleep(1400);
          return { answer: '{}', intent: 'chat', recommendations: [{ slot: 'pm', sku: { sku_id: 'sku_slow' } }] };
        },
        uidSeed: 'contract_timeout',
      });

      try {
        const resp = await harness.request
          .post('/v1/chat')
          .set(headersFor(uid, 'EN'))
          .send({
            message: 'recommend products',
            action: { action_id: 'chip.start.reco_products', kind: 'chip', data: {} },
            language: 'EN',
            session: { state: 'idle' },
          })
          .expect(200);

        assertEnvelopeValid(resp.body);
        const cards = parseCards(resp.body);
        assertNoticeReason(cards, 'timeout_degraded');
        assert.equal(Boolean(findCard(cards, 'recommendations')), false);
      } finally {
        harness.restore();
      }
    },
  );
});

test('P2-1 contract: empty upstream output degrades to confidence_notice(artifact_missing)', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_PRODUCT_MATCHER_ENABLED: 'false',
    },
    async () => {
      const { harness, uid } = await setupRecoHarnessWithArtifact({
        auroraChatImpl: async () => ({ answer: '{}', intent: 'chat', cards: [] }),
        uidSeed: 'contract_artifact_missing',
        seedArtifact: false,
      });

      try {
        const resp = await harness.request
          .post('/v1/chat')
          .set(headersFor(uid, 'EN'))
          .send({
            message: 'recommend products',
            action: { action_id: 'chip.start.reco_products', kind: 'chip', data: {} },
            language: 'EN',
            session: { state: 'idle' },
          })
          .expect(200);

        assertEnvelopeValid(resp.body);
        const cards = parseCards(resp.body);
        assertNoticeReason(cards, 'artifact_missing');
      } finally {
        harness.restore();
      }
    },
  );
});

test('P2-1 contract: low confidence artifact yields confidence_notice(low_confidence)', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_PRODUCT_MATCHER_ENABLED: 'false',
    },
    async () => {
      const { harness, uid } = await setupRecoHarnessWithArtifact({
        auroraChatImpl: async () => ({
          answer: '{}',
          intent: 'chat',
          recommendations: [{ step: 'Treatment', slot: 'pm', sku: { sku_id: 'sku_treatment' } }],
        }),
        uidSeed: 'contract_low_conf',
        artifactScore: 0.4,
        artifactLevel: 'low',
        artifactSource: 'baseline_low_confidence',
        artifactUsePhoto: false,
      });

      try {
        const resp = await harness.request
          .post('/v1/chat')
          .set(headersFor(uid, 'EN'))
          .send({
            message: 'recommend products',
            action: { action_id: 'chip.start.reco_products', kind: 'chip', data: {} },
            language: 'EN',
            session: { state: 'idle' },
          })
          .expect(200);

        assertEnvelopeValid(resp.body);
        const cards = parseCards(resp.body);
        assertNoticeReason(cards, 'low_confidence');
      } finally {
        harness.restore();
      }
    },
  );
});

test('P2-1 contract: medium confidence recommendations must exclude treatment/high-irritation items', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_PRODUCT_MATCHER_ENABLED: 'false',
    },
    async () => {
      const { harness, uid } = await setupRecoHarnessWithArtifact({
        auroraChatImpl: async () => ({
          answer: '{}',
          intent: 'chat',
          structured: {
            recommendations: [
              { step: 'Treatment', slot: 'pm', category: 'treatment', notes: ['retinoid'], sku: { sku_id: 'sku_treat' } },
              { step: 'Moisturizer', slot: 'pm', category: 'moisturizer', notes: ['ceramide'], sku: { sku_id: 'sku_safe' } },
            ],
          },
        }),
        uidSeed: 'contract_medium_no_treatment',
        artifactScore: 0.66,
        artifactLevel: 'medium',
        artifactSource: 'rule_based',
        artifactUsePhoto: false,
      });

      try {
        const resp = await harness.request
          .post('/v1/chat')
          .set(headersFor(uid, 'EN'))
          .send({
            message: 'recommend products',
            action: { action_id: 'chip.start.reco_products', kind: 'chip', data: {} },
            language: 'EN',
            session: { state: 'idle' },
          })
          .expect(200);

        assertEnvelopeValid(resp.body);
        const cards = parseCards(resp.body);
        const reco = findCard(cards, 'recommendations');
        const recs = Array.isArray(reco && reco.payload && reco.payload.recommendations)
          ? reco.payload.recommendations
          : [];
        if (recs.length > 0) {
          assert.equal(recs.some((row) => looksTreatmentOrHighIrritation(row)), false);
        }
      } finally {
        harness.restore();
      }
    },
  );
});

test('P2-1 contract: safety_block mode must not include recommendations', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_PRODUCT_MATCHER_ENABLED: 'false',
    },
    async () => {
      const { harness, uid } = await setupRecoHarnessWithArtifact({
        auroraChatImpl: async () => ({
          answer: '{}',
          intent: 'chat',
          recommendations: [{ step: 'Moisturizer', slot: 'pm', sku: { sku_id: 'sku_should_be_blocked' } }],
        }),
        uidSeed: 'contract_safety_block',
      });

      try {
        const resp = await harness.request
          .post('/v1/chat')
          .set(headersFor(uid, 'EN'))
          .send({
            message: 'I have severe pain, bleeding and pus on my face',
            action: { action_id: 'chip.start.reco_products', kind: 'chip', data: {} },
            language: 'EN',
            session: { state: 'idle' },
          })
          .expect(200);

        assertEnvelopeValid(resp.body);
        const cards = parseCards(resp.body);
        assertNoticeReason(cards, 'safety_block');
        assert.equal(Boolean(findCard(cards, 'recommendations')), false);
      } finally {
        harness.restore();
      }
    },
  );
});

test('P2-1 contract schema accepts reason enum coverage fixtures', () => {
  const reasons = ['artifact_missing', 'low_confidence', 'safety_block', 'timeout_degraded'];
  for (const reason of reasons) {
    const fixture = {
      request_id: `req_${reason}`,
      trace_id: `trace_${reason}`,
      assistant_message: null,
      suggested_chips: [],
      cards: [
        {
          card_id: `card_${reason}`,
          type: 'confidence_notice',
          payload: {
            reason,
            actions: reason === 'safety_block' ? [] : ['retry'],
          },
        },
      ],
      session_patch: {},
      events: [],
    };
    assertEnvelopeValid(fixture);
  }
});
