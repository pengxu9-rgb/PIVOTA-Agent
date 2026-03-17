const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_CHATCARDS_RESPONSE_CONTRACT = 'dual';
process.env.AURORA_RULE_RELAX_MODE = 'conservative';
process.env.AURORA_BFF_RECO_PDP_LIGHT_ENRICH = 'false';

const { mapAuroraRoutineToRecoGenerate } = require('../src/auroraBff/auroraStructuredMapper');
const {
  withEnv,
  buildTestUid,
  headersFor,
  createAppWithPatchedAuroraChat,
  parseCards,
  findCard,
} = require('./aurora_bff_test_harness.cjs');

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

test('routine advisory recommendations survive guardrails as ungrounded editorial items', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const mapped = mapAuroraRoutineToRecoGenerate({
      am: [
        {
          step: 'serum',
          product_type: 'serum',
          brand: 'Editorial',
          name: 'Barrier Support Serum',
          display_name: 'Barrier Support Serum',
          concern_match: ['barrier', 'redness'],
          notes: ['Use a low-irritation hydrating serum before moisturizer.'],
        },
      ],
      pm: [],
    }, {});

    const prepared = mapped.recommendations.map((item) => __internal.normalizeRoutineRecoItemForUiGuardrails(item, { lang: 'EN' }));
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0]?.grounding_status, 'ungrounded');
    assert.equal(prepared[0]?.metadata?.routine_editorial_fallback, true);

    const sanitized = await __internal.sanitizeRecoCandidatesForUi([
      {
        type: 'recommendations',
        payload: {
          recommendations: prepared,
        },
      },
    ], {
      strictFilter: true,
      qaMode: 'off',
      allowOpenAiFallback: false,
    });

    const recoCard = Array.isArray(sanitized.cards) ? sanitized.cards.find((card) => card?.type === 'recommendations') : null;
    const recs = Array.isArray(recoCard?.payload?.recommendations) ? recoCard.payload.recommendations : [];
    assert.equal(recs.length, 1);
    assert.equal(recs[0]?.grounding_status, 'ungrounded');
    assert.equal(String(recoCard?.payload?.products_empty_reason || ''), '');

    const invariant = __internal.applyRecoCardContractInvariant({
      envelope: { cards: sanitized.cards, events: [], session_patch: {} },
      ctx: { request_id: 'routine_editorial_hotfix', lang: 'EN' },
      language: 'EN',
    });
    assert.equal(invariant.applied, false);
  } finally {
    delete require.cache[moduleId];
  }
});

test('routine recommendations with grounded identity are not forced into editorial fallback', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const prepared = __internal.normalizeRoutineRecoItemForUiGuardrails({
      slot: 'am',
      step: 'serum',
      product_type: 'serum',
      brand: 'Real Brand',
      name: 'Cica Repair Serum',
      product_id: 'prod_123',
      merchant_id: 'shopify_us',
      pdp_url: 'https://example.com/products/cica-repair-serum',
    }, { lang: 'EN' });

    assert.notEqual(String(prepared?.grounding_status || ''), 'ungrounded');
    assert.equal(String(prepared?.metadata?.routine_editorial_fallback || ''), '');
  } finally {
    delete require.cache[moduleId];
  }
});

test('/v1/chat routine: advisory upstream routine returns recommendations instead of artifact_missing', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_CHAT_SKILL_ROUTER_V2_ENABLED: 'true',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({
        answer: '{}',
        intent: 'chat',
        context: {
          routine: {
            am: [
              {
                step: 'serum',
                product_type: 'serum',
                brand: 'Editorial',
                name: 'Barrier Support Serum',
                display_name: 'Barrier Support Serum',
                concern_match: ['barrier', 'redness'],
                notes: ['Use a low-irritation hydrating serum before moisturizer.'],
              },
            ],
            pm: [],
          },
        },
      }));

      try {
        const uid = buildTestUid('routine_editorial_survives_guardrails');
        const resp = await harness.request
          .post('/v1/chat')
          .set(headersFor(uid, 'EN'))
          .send({
            action: {
              action_id: 'chip.start.routine',
              kind: 'chip',
              data: {
                reply_text: 'Build an AM/PM routine',
                profile_patch: {
                  skinType: 'oily',
                  sensitivity: 'low',
                  barrierStatus: 'healthy',
                  goals: ['barrier'],
                },
              },
            },
            session: { state: 'idle' },
            language: 'EN',
          })
          .expect(200);

        const cards = parseCards(resp.body);
        const reco = findCard(cards, 'recommendations');
        const conf = findCard(cards, 'confidence_notice');
        const recs = Array.isArray(reco?.payload?.recommendations) ? reco.payload.recommendations : [];
        assert.ok(reco, 'recommendations card should exist');
        assert.equal(recs.length > 0, true);
        assert.equal(recs[0]?.grounding_status, 'ungrounded');
        assert.equal(conf?.payload?.reason === 'artifact_missing', false);
      } finally {
        harness.restore();
      }
    },
  );
});
