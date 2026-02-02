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
});
