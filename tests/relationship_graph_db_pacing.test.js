const pacing = require('../src/auroraBff/relationshipGraphDbPacing');

// Duty-cycle pacing for relgraph database streams: off by default, bounded when on.
describe('relationship graph DB duty-cycle pacing', () => {
  const saved = {};
  const sleeps = [];
  beforeEach(() => {
    for (const key of ['RELGRAPH_DB_DUTY_CYCLE', 'RELGRAPH_DB_DUTY_CYCLE_MAX_SLEEP_MS']) { saved[key] = process.env[key]; delete process.env[key]; }
    sleeps.length = 0;
    pacing.__setSleepForTests(async (ms) => { sleeps.push(ms); });
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    pacing.__setSleepForTests(null);
    jest.restoreAllMocks();
  });

  // fn takes `ms` of fake time.
  const timedFn = (ms, value = 'rows') => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    return jest.fn(async () => { now += ms; return value; });
  };

  test.each([undefined, '', '0', '-1', 'abc', 'off'])('RELGRAPH_DB_DUTY_CYCLE=%p is off: fn runs once, no timing, no sleep', async (value) => {
    if (value !== undefined) process.env.RELGRAPH_DB_DUTY_CYCLE = value;
    const now = jest.spyOn(Date, 'now');
    const fn = jest.fn(async () => 'rows');
    await expect(pacing.pacedDbCall(fn)).resolves.toBe('rows');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(now).not.toHaveBeenCalled();
    expect(sleeps).toEqual([]);
    expect(pacing.dbDutyCycle()).toBe(0);
  });

  test('on: sleeps duty x the call duration, after the call, and returns its result', async () => {
    process.env.RELGRAPH_DB_DUTY_CYCLE = '1.5';
    const fn = timedFn(2000);
    await expect(pacing.pacedDbCall(fn)).resolves.toBe('rows');
    expect(sleeps).toEqual([3000]);
  });

  test('each sleep is capped by RELGRAPH_DB_DUTY_CYCLE_MAX_SLEEP_MS (default 10 s, at most 60 s)', async () => {
    process.env.RELGRAPH_DB_DUTY_CYCLE = '2';
    await pacing.pacedDbCall(timedFn(8000));
    process.env.RELGRAPH_DB_DUTY_CYCLE_MAX_SLEEP_MS = '2500';
    await pacing.pacedDbCall(timedFn(8000));
    process.env.RELGRAPH_DB_DUTY_CYCLE_MAX_SLEEP_MS = '999999';
    await pacing.pacedDbCall(timedFn(40000));
    process.env.RELGRAPH_DB_DUTY_CYCLE_MAX_SLEEP_MS = '0';
    await pacing.pacedDbCall(timedFn(8000));
    expect(sleeps).toEqual([10000, 2500, 60000]);
  });

  test('the ratio itself is capped at 10', async () => {
    process.env.RELGRAPH_DB_DUTY_CYCLE = '50';
    expect(pacing.dbDutyCycle()).toBe(10);
    await pacing.pacedDbCall(timedFn(100));
    expect(sleeps).toEqual([1000]);
  });

  test('a failed call is thrown at once, without a sleep', async () => {
    process.env.RELGRAPH_DB_DUTY_CYCLE = '1';
    await expect(pacing.pacedDbCall(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(sleeps).toEqual([]);
  });

  test('the serving label scan sleeps once per page when on, and returns the same result', async () => {
    const { scanServingLabels } = require('../src/services/relationshipGraphServingScan');
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `lbl_${i}`, anchor_type: 'product', anchor_ref: `product:sig_${i}`,
      candidate_product_ref: `product:sig_c${i}`, relation_type: 'competitive_alternative', label_state: 'ai_approved', market: 'US' }));
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const queryFn = jest.fn(async (_sql, [, cursor, size]) => {
      now += 50; // each page takes 50 ms
      const start = cursor ? rows.findIndex((row) => row.id === cursor) + 1 : 0;
      return { rows: rows.slice(start, start + size) };
    });
    const scan = () => scanServingLabels({ queryFn, batchSize: 2, collectAnchors: true, collectSuppressedIds: true });
    const off = await scan();
    expect(queryFn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([]);
    process.env.RELGRAPH_DB_DUTY_CYCLE = '1';
    queryFn.mockClear();
    const on = await scan();
    expect(on).toEqual(off);
    expect(queryFn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([50, 50, 50]);
  });
});
