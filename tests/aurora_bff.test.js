const request = require('supertest');

describe('Aurora BFF (/v1)', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.AURORA_BFF_USE_MOCK = 'true';
  });

  afterEach(() => {
    delete process.env.AURORA_BFF_USE_MOCK;
  });

  test('Phase0 gate: no recos when profile is missing', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/chat')
      .set('X-Aurora-UID', 'uid_test_1')
      .send({ message: 'Please recommend a moisturizer' })
      .expect(200);

    expect(res.body).toHaveProperty('assistant_message');
    expect(res.body.assistant_message.content).toMatch(/skin profile|肤/);
    expect(Array.isArray(res.body.suggested_chips)).toBe(true);
    expect(res.body.suggested_chips.some((c) => String(c.chip_id).startsWith('profile.skinType.'))).toBe(true);
    expect(res.body.cards.some((c) => c.type === 'diagnosis_gate')).toBe(true);
    expect(res.body.cards.some((c) => String(c.type).includes('reco'))).toBe(false);
    expect(res.body.cards.some((c) => String(c.type).includes('offer'))).toBe(false);
  });

  test('Diagnosis start: explicit diagnosis triggers gate + state update', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/chat')
      .set('X-Aurora-UID', 'uid_test_diag_start_1')
      .set('X-Lang', 'CN')
      .send({
        message: '开始皮肤诊断',
        // Simulate an already-partial profile (3/4 dimensions) — diagnosis start should still gate
        // to collect the remaining field(s) (e.g. goals).
        action: {
          action_id: 'chip.profile.prefill',
          kind: 'chip',
          data: { profile_patch: { skinType: 'oily', sensitivity: 'medium', barrierStatus: 'impaired' } },
        },
      })
      .expect(200);

    expect(res.body.session_patch.next_state).toBe('S2_DIAGNOSIS');
    expect(res.body.cards.some((c) => c.type === 'diagnosis_gate')).toBe(true);
    expect(res.body.suggested_chips.some((c) => String(c.chip_id).startsWith('profile.'))).toBe(true);
  });

  test('Recommendation gate: strips recommendation cards unless explicit', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/chat')
      .set('X-Aurora-UID', 'uid_test_2')
      .send({ message: 'Tell me about niacinamide' })
      .expect(200);

    expect(res.body.cards.some((c) => c.type === 'recommendations')).toBe(false);
    expect(res.body.cards.some((c) => c.type === 'gate_notice')).toBe(true);
  });

  test('Recommendation gate: blocks structured commerce payload unless explicit', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/chat')
      .set('X-Aurora-UID', 'uid_test_structured_1')
      .send({ message: 'STRUCTURED_COMMERCE_TEST' })
      .expect(200);

    expect(res.body.cards.some((c) => c.type === 'aurora_structured')).toBe(false);

    const gate = res.body.cards.find((c) => c.type === 'gate_notice');
    expect(gate).toBeTruthy();
    expect(Array.isArray(gate.field_missing)).toBe(true);
    expect(
      gate.field_missing.some((f) => f.field === 'aurora_structured' && f.reason === 'recommendations_not_requested'),
    ).toBe(true);
  });

  test('Chat: action.reply_text is treated as message (no dead loop)', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/chat')
      .set('X-Aurora-UID', 'uid_test_action_reply_1')
      .send({
        action: {
          action_id: 'chip.clarify.test',
          kind: 'chip',
          data: { reply_text: 'ACTION_REPLY_TEXT_TEST' },
        },
        session: { state: 'S2_DIAGNOSIS' },
      })
      .expect(200);

    expect(res.body).toHaveProperty('assistant_message');
    expect(res.body.assistant_message.content).toMatch(/action reply_text received/i);
  });

  test('Chat: include_alternatives enriches recommendations card (reco_products)', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/chat')
      .set('X-Aurora-UID', 'uid_test_alternatives_1')
      .set('X-Lang', 'EN')
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'Recommend a few products',
            include_alternatives: true,
            profile_patch: { skinType: 'oily', sensitivity: 'low', barrierStatus: 'healthy', goals: ['pores'], budgetTier: '¥500' },
          },
        },
        session: { state: 'S2_DIAGNOSIS' },
      })
      .expect(200);

    const reco = res.body.cards.find((c) => c.type === 'recommendations');
    expect(reco).toBeTruthy();
    expect(Array.isArray(reco.payload.recommendations)).toBe(true);
    expect(reco.payload.recommendations.length).toBeGreaterThan(0);

    const first = reco.payload.recommendations[0];
    expect(Array.isArray(first.alternatives)).toBe(true);
    expect(first.alternatives.length).toBeGreaterThan(0);
    expect(first.alternatives[0]).toHaveProperty('kind');
    expect(first.alternatives[0]).toHaveProperty('product');
    expect(Array.isArray(first.alternatives[0].tradeoffs)).toBe(true);
  });

  test('Diagnosis: profile chip patch continues with next missing fields', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/chat')
      .set('X-Aurora-UID', 'uid_test_profile_chip_1')
      .send({
        action: {
          action_id: 'profile.skinType.oily',
          kind: 'chip',
          data: { profile_patch: { skinType: 'oily' } },
        },
        session: { state: 'S2_DIAGNOSIS' },
      })
      .expect(200);

    expect(res.body.cards.some((c) => c.type === 'diagnosis_gate')).toBe(true);
    expect(res.body.suggested_chips.some((c) => String(c.chip_id).startsWith('profile.sensitivity.'))).toBe(true);
    expect(res.body.cards.some((c) => c.type === 'aurora_structured')).toBe(false);
  });

  test('Diagnosis: clarification chip reply maps to profile patch and progresses', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/chat')
      .set('X-Aurora-UID', 'uid_test_clarification_patch_1')
      .send({
        action: {
          action_id: 'chip.clarify.skin_type.Oily',
          kind: 'chip',
          data: { reply_text: 'Oily', clarification_id: 'skin_type' },
        },
        session: { state: 'S2_DIAGNOSIS' },
      })
      .expect(200);

    expect(res.body.cards.some((c) => c.type === 'diagnosis_gate')).toBe(true);
    expect(res.body.suggested_chips.some((c) => String(c.chip_id).startsWith('profile.skinType.'))).toBe(false);
    expect(res.body.suggested_chips.some((c) => String(c.chip_id).startsWith('profile.barrierStatus.'))).toBe(true);
  });

  test('Diagnosis: DIAG_PROFILE with complete profile returns photo opt-in chips (no diagnosis_gate loop)', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/chat')
      .set('X-Aurora-UID', 'uid_test_diag_profile_complete_1')
      .set('X-Lang', 'EN')
      .send({
        client_state: 'DIAG_PROFILE',
        action: {
          action_id: 'profile.patch',
          kind: 'action',
          data: {
            profile_patch: {
              skinType: 'oily',
              barrierStatus: 'healthy',
              sensitivity: 'low',
              goals: ['acne'],
            },
          },
        },
        session: { state: 'S2_DIAGNOSIS' },
      })
      .expect(200);

    expect(res.body.cards.some((c) => c.type === 'diagnosis_gate')).toBe(false);
    expect(res.body.suggested_chips.some((c) => c.chip_id === 'chip.intake.upload_photos')).toBe(true);
    expect(res.body.suggested_chips.some((c) => c.chip_id === 'chip.intake.skip_analysis')).toBe(true);
  });

  test('Routine: initial request returns recommendations with optional budget optimization', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/chat')
      .set('X-Aurora-UID', 'uid_test_budget_gate_1')
      .set('X-Lang', 'CN')
      .send({
        message: '生成一套早晚护肤 routine',
        action: {
          action_id: 'chip.start.routine',
          kind: 'chip',
          data: { profile_patch: { skinType: 'oily', sensitivity: 'low', barrierStatus: 'healthy' } },
        },
        session: { state: 'S2_DIAGNOSIS' },
      })
      .expect(200);

    expect(res.body.assistant_message.content).toMatch(/预算/);
    expect(res.body.cards.some((c) => c.type === 'recommendations')).toBe(true);
    expect(res.body.session_patch.next_state).toBe('S7_PRODUCT_RECO');
    expect(res.body.suggested_chips.some((c) => c.chip_id === 'chip.budget.optimize.entry')).toBe(true);
  });

  test('Routine: budget gate remains in S6_BUDGET when budget is still missing', async () => {
    const app = require('../src/server');
    const payload = {
      message: '继续',
      action: {
        action_id: 'chip.start.routine',
        kind: 'chip',
        data: {},
      },
      session: { state: 'S6_BUDGET' },
    };

    const first = await request(app)
      .post('/v1/chat')
      .set('X-Aurora-UID', 'uid_test_budget_gate_stability_1')
      .set('X-Lang', 'CN')
      .send(payload)
      .expect(200);

    const second = await request(app)
      .post('/v1/chat')
      .set('X-Aurora-UID', 'uid_test_budget_gate_stability_1')
      .set('X-Lang', 'CN')
      .send(payload)
      .expect(200);

    for (const res of [first, second]) {
      expect(res.body.assistant_message.content).toMatch(/预算/);
      expect(res.body.session_patch.next_state).toBe('S6_BUDGET');
      expect(res.body.cards.some((c) => c.type === 'budget_gate')).toBe(true);
      expect(res.body.suggested_chips.some((c) => String(c.chip_id).startsWith('chip.budget.'))).toBe(true);
    }
  });

  test('Routine: selecting budget in S6_BUDGET generates routine recommendations', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/chat')
      .set('X-Aurora-UID', 'uid_test_budget_gate_2')
      .set('X-Lang', 'CN')
      .send({
        client_state: 'RECO_GATE',
        action: {
          action_id: 'chip.budget._500',
          kind: 'chip',
          data: { profile_patch: { budgetTier: '¥500' } },
        },
        session: { state: 'S6_BUDGET' },
      })
      .expect(200);

    expect(res.body.assistant_message.content).toMatch(/routine/);
    expect(res.body.cards.some((c) => c.type === 'recommendations')).toBe(true);
    expect(res.body.session_patch.next_state).toBe('S7_PRODUCT_RECO');
  });

  test('Routine simulate: detects retinoid x acids conflict', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/routine/simulate')
      .set('X-Aurora-UID', 'uid_test_3')
      .send({
        routine: { pm: [{ key_actives: ['retinol'] }] },
        test_product: { key_actives: ['glycolic acid'] },
      })
      .expect(200);

    const simCard = res.body.cards.find((c) => c.type === 'routine_simulation');
    expect(simCard).toBeTruthy();
    expect(simCard.payload.safe).toBe(false);
    expect(simCard.payload.conflicts.some((c) => c.rule_id === 'retinoid_x_acids')).toBe(true);
  });

  test('Routine simulate: detects retinoid x BPO conflict (block)', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/routine/simulate')
      .set('X-Aurora-UID', 'uid_test_conflict_2')
      .send({
        routine: { pm: [{ key_actives: ['adapalene'] }] },
        test_product: { key_actives: ['benzoyl peroxide'] },
      })
      .expect(200);

    const simCard = res.body.cards.find((c) => c.type === 'routine_simulation');
    expect(simCard).toBeTruthy();
    expect(simCard.payload.safe).toBe(false);
    expect(simCard.payload.conflicts.some((c) => c.rule_id === 'retinoid_x_bpo' && c.severity === 'block')).toBe(true);
  });

  test('Routine simulate: detects multiple exfoliants conflict (warn)', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/routine/simulate')
      .set('X-Aurora-UID', 'uid_test_conflict_3')
      .send({
        routine: {
          pm: [
            { key_actives: ['glycolic acid'] },
            { key_actives: ['salicylic acid'] },
          ],
        },
      })
      .expect(200);

    const simCard = res.body.cards.find((c) => c.type === 'routine_simulation');
    expect(simCard).toBeTruthy();
    expect(simCard.payload.safe).toBe(false);
    expect(simCard.payload.conflicts.some((c) => c.rule_id === 'multiple_exfoliants' && c.severity === 'warn')).toBe(true);
  });

  test('Offers resolve: patches price/image via pivota-backend external offers', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/offers/resolve')
      .set('X-Aurora-UID', 'uid_test_4')
      .send({
        market: 'US',
        items: [
          {
            product: { sku_id: 'sku_1', name: 'Old', brand: 'OldBrand', image_url: '' },
            offer: { affiliate_url: 'https://example.com/p/1', price: 0, currency: 'USD', seller: 'X' },
          },
        ],
      })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'offers_resolved');
    expect(card).toBeTruthy();
    expect(card.payload.items[0].product.image_url).toBeTruthy();
    expect(card.payload.items[0].offer.price).toBeGreaterThan(0);
  });

  test('Skin analysis: returns analysis_summary card', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/analysis/skin')
      .set('X-Aurora-UID', 'uid_test_analysis_1')
      .send({ photos: [{ slot_id: 'daylight', qc_status: 'passed' }] })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'analysis_summary');
    expect(card).toBeTruthy();
    expect(card.payload).toHaveProperty('analysis');
    expect(Array.isArray(card.payload.analysis.features)).toBe(true);
    expect(typeof card.payload.analysis.strategy).toBe('string');
    expect(Array.isArray(card.field_missing) ? card.field_missing : []).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ field: 'profile.currentRoutine' })]),
    );
  });

  test('Photo upload proxy: endpoint exists (mock)', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/photos/upload')
      .set('X-Aurora-UID', 'uid_test_photo_upload_1')
      .send({})
      .expect(200);

    expect(res.body.cards.some((c) => c.type === 'photo_confirm')).toBe(true);
  });

  test('Product analyze: returns product_analysis with anchor_product', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/product/analyze')
      .set('X-Aurora-UID', 'uid_test_product_analyze_1')
      .send({ url: 'https://example.com/product/mock' })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'product_analysis');
    expect(card).toBeTruthy();
    expect(card.payload).toHaveProperty('assessment');
    expect(card.payload.assessment).toHaveProperty('anchor_product');
  });

  test('Dupe compare: returns dupe_compare with original/dupe products', async () => {
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/dupe/compare')
      .set('X-Aurora-UID', 'uid_test_dupe_compare_1')
      .send({
        original: { brand: 'MockBrand', name: 'Mock Parsed Product', sku_id: 'mock_sku_1' },
        dupe: { brand: 'MockDupeBrand', name: 'Mock Dupe Product', sku_id: 'mock_dupe_1' },
      })
      .expect(200);

    const card = res.body.cards.find((c) => c.type === 'dupe_compare');
    expect(card).toBeTruthy();
    expect(card.payload).toHaveProperty('original');
    expect(card.payload).toHaveProperty('dupe');
  });
});
