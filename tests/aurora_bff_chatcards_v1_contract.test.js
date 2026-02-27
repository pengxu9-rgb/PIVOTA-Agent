const request = require('supertest');

describe('Aurora BFF /v1/chat ChatCards v1 contract', () => {
  jest.setTimeout(20000);

  beforeEach(() => {
    jest.resetModules();
    process.env.AURORA_BFF_USE_MOCK = 'true';
    process.env.AURORA_SAFETY_ENGINE_V1_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.AURORA_BFF_USE_MOCK;
    delete process.env.AURORA_SAFETY_ENGINE_V1_ENABLED;
  });

  test('returns ChatCards v1 fields and does not expose legacy envelope fields', async () => {
    const app = require('../src/server');

    const res = await request(app)
      .post('/v1/chat')
      .set('X-Aurora-UID', 'uid_chatcards_v1_contract_1')
      .set('X-Lang', 'EN')
      .send({ message: 'Please recommend a gentle routine for oily skin.' })
      .expect(200);

    expect(res.body.version).toBe('1.0');
    expect(typeof res.body.request_id).toBe('string');
    expect(typeof res.body.trace_id).toBe('string');
    expect(typeof res.body.assistant_text).toBe('string');

    expect(Array.isArray(res.body.cards)).toBe(true);
    expect(res.body.cards.length).toBeLessThanOrEqual(3);
    expect(Array.isArray(res.body.follow_up_questions)).toBe(true);
    expect(res.body.follow_up_questions.length).toBeLessThanOrEqual(3);
    expect(Array.isArray(res.body.suggested_quick_replies)).toBe(true);
    expect(res.body.suggested_quick_replies.length).toBeLessThanOrEqual(8);

    expect(res.body.ops).toBeTruthy();
    expect(Array.isArray(res.body.ops.thread_ops)).toBe(true);
    expect(Array.isArray(res.body.ops.profile_patch)).toBe(true);
    expect(Array.isArray(res.body.ops.routine_patch)).toBe(true);
    expect(Array.isArray(res.body.ops.experiment_events)).toBe(true);

    expect(res.body.safety).toBeTruthy();
    expect(['none', 'low', 'medium', 'high']).toContain(res.body.safety.risk_level);
    expect(Array.isArray(res.body.safety.red_flags)).toBe(true);

    expect(res.body.telemetry).toBeTruthy();
    expect(typeof res.body.telemetry.intent).toBe('string');
    expect(typeof res.body.telemetry.intent_confidence).toBe('number');
    expect(Array.isArray(res.body.telemetry.entities)).toBe(true);

    expect(res.body).not.toHaveProperty('assistant_message');
    expect(res.body).not.toHaveProperty('suggested_chips');
    expect(res.body).not.toHaveProperty('session_patch');
    expect(res.body).not.toHaveProperty('events');
  });

  test('routine-intent turn keeps v1 bounds (cards <= 3, follow-up <= 3)', async () => {
    const app = require('../src/server');

    const res = await request(app)
      .post('/v1/chat')
      .set('X-Aurora-UID', 'uid_chatcards_v1_contract_2')
      .set('X-Lang', 'EN')
      .send({
        action: {
          action_id: 'chip.start.routine',
          kind: 'chip',
          data: { reply_text: 'Build an AM/PM skincare routine' },
        },
        session: { state: 'S2_DIAGNOSIS' },
      })
      .expect(200);

    expect(res.body.version).toBe('1.0');
    expect(Array.isArray(res.body.cards)).toBe(true);
    expect(res.body.cards.length).toBeLessThanOrEqual(3);
    expect(Array.isArray(res.body.follow_up_questions)).toBe(true);
    expect(res.body.follow_up_questions.length).toBeLessThanOrEqual(3);
  });

  test('topic shift A -> B -> A stays on v1 and returns thread ops without 500', async () => {
    const app = require('../src/server');
    const uid = `uid_chatcards_v1_topic_shift_${Date.now()}`;

    const turnA = await request(app)
      .post('/v1/chat')
      .set('X-Aurora-UID', uid)
      .set('X-Lang', 'EN')
      .send({ message: 'Please build a gentle acne routine for oily skin.' })
      .expect(200);
    expect(turnA.body.version).toBe('1.0');
    expect(Array.isArray(turnA.body.ops?.thread_ops)).toBe(true);

    const turnB = await request(app)
      .post('/v1/chat')
      .set('X-Aurora-UID', uid)
      .set('X-Lang', 'EN')
      .send({ message: 'I am traveling to Tokyo next week, how should I adjust for weather?' })
      .expect(200);
    expect(turnB.body.version).toBe('1.0');
    expect(Array.isArray(turnB.body.ops?.thread_ops)).toBe(true);

    const turnBack = await request(app)
      .post('/v1/chat')
      .set('X-Aurora-UID', uid)
      .set('X-Lang', 'EN')
      .send({ message: 'Back to the previous topic, continue the acne routine please.' })
      .expect(200);
    expect(turnBack.body.version).toBe('1.0');
    expect(Array.isArray(turnBack.body.ops?.thread_ops)).toBe(true);
    const allOps = [
      ...(Array.isArray(turnA.body.ops?.thread_ops) ? turnA.body.ops.thread_ops : []),
      ...(Array.isArray(turnB.body.ops?.thread_ops) ? turnB.body.ops.thread_ops : []),
      ...(Array.isArray(turnBack.body.ops?.thread_ops) ? turnBack.body.ops.thread_ops : []),
    ]
      .map((op) => String(op?.op || '').toLowerCase())
      .filter(Boolean);
    expect(allOps.some((op) => ['thread_push', 'thread_pop', 'thread_update'].includes(op))).toBe(true);
  });

  test('high-risk safety intent maps to safety.risk_level=high on v1 response', async () => {
    const app = require('../src/server');

    const res = await request(app)
      .post('/v1/chat')
      .set('X-Aurora-UID', `uid_chatcards_v1_safety_${Date.now()}`)
      .set('X-Lang', 'EN')
      .send({ message: 'Can I use retinol during pregnancy?' })
      .expect(200);

    expect(res.body.version).toBe('1.0');
    expect(res.body.safety).toBeTruthy();
    expect(res.body.safety.risk_level).toBe('high');
    expect(Array.isArray(res.body.safety.red_flags)).toBe(true);
  });
});
