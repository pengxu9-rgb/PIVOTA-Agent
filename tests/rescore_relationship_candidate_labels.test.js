const {
  rescore,
  scoreRow,
  FETCH_GENERATED_SQL,
  PROMOTE_SQL,
} = require('../scripts/rescore-relationship-candidate-labels');

const FIXED_NOW = 1_700_000_000_000;
const TICK = 1_000;
function makeNow() {
  let calls = 0;
  return () => {
    const v = FIXED_NOW + calls * TICK;
    calls += 1;
    return v;
  };
}

function attrs(overrides = {}) {
  return {
    product_form: 'serum',
    product_form_confidence: 0.95,
    category_leaf: 'hydrating_serum',
    category_leaf_confidence: 0.95,
    target_area: 'face',
    target_area_confidence: 0.95,
    spf_or_otc_flag: 'cosmetic',
    spf_or_otc_flag_confidence: 0.95,
    ...overrides,
  };
}

describe('scoreRow', () => {
  test('promotes when applyAllGates fails (target_area mismatch)', () => {
    const map = new Map([
      ['ext_a', attrs({ target_area: 'face' })],
      ['ext_b', attrs({ target_area: 'lips', category_leaf: 'lip_balm' })],
    ]);
    const out = scoreRow({
      anchor_ref: 'product:ext_a',
      candidate_product_ref: 'product:ext_b',
      relation_type: 'competitive_alternative',
    }, map);
    expect(out.bucket).toBe('promoted_prefilter_rejected');
    expect(out.reasons.length).toBeGreaterThan(0);
    expect(out.reasons.some((r) => r.startsWith('target_area_mismatch'))).toBe(true);
  });

  test('passes when applyAllGates passes (same attrs)', () => {
    const a = attrs();
    const map = new Map([['ext_a', a], ['ext_b', a]]);
    const out = scoreRow({
      anchor_ref: 'product:ext_a',
      candidate_product_ref: 'product:ext_b',
      relation_type: 'competitive_alternative',
    }, map);
    expect(out.bucket).toBe('passed');
    expect(out.reasons).toBeNull();
  });

  test('skips when attrs missing on either side', () => {
    const map = new Map([['ext_a', attrs()]]);
    const out = scoreRow({
      anchor_ref: 'product:ext_a',
      candidate_product_ref: 'product:ext_missing',
      relation_type: 'competitive_alternative',
    }, map);
    expect(out.bucket).toBe('skipped_missing_attrs');
  });
});

describe('rescore', () => {
  function makeQueryFn(generatedRows, { updates = [] } = {}) {
    return jest.fn(async (sql, params) => {
      if (sql === FETCH_GENERATED_SQL) return { rows: generatedRows };
      if (sql === PROMOTE_SQL) {
        updates.push({ reasons: params[0], id: params[1] });
        return { rowCount: 1 };
      }
      return { rows: [] };
    });
  }

  test('emits noop metric when no generated rows exist', async () => {
    const queryFn = makeQueryFn([]);
    const lookupFn = jest.fn(async () => new Map());
    const { metric } = await rescore({ queryFn, lookupFn, apply: true, now: makeNow() });
    expect(metric.status).toBe('noop');
    expect(metric.candidates_scored).toBe(0);
    expect(metric.promoted).toBe(0);
    expect(lookupFn).not.toHaveBeenCalled();
  });

  test('dry-run scores but does NOT write UPDATE', async () => {
    const rows = [
      { id: 'rcl_1', edge_id: 'e1', anchor_ref: 'product:ext_a', candidate_product_ref: 'product:ext_b', relation_type: 'competitive_alternative' },
    ];
    const updates = [];
    const queryFn = makeQueryFn(rows, { updates });
    const lookupFn = jest.fn(async () => new Map([
      ['ext_a', attrs({ target_area: 'face' })],
      ['ext_b', attrs({ target_area: 'lips', category_leaf: 'lip_balm' })],
    ]));
    const { metric } = await rescore({ queryFn, lookupFn, apply: false, now: makeNow() });
    expect(metric.dry_run).toBe(true);
    expect(metric.promoted).toBe(1);
    expect(updates).toHaveLength(0);
    expect(metric.promotion_reasons).toHaveProperty('target_area_mismatch', 1);
  });

  test('apply mode writes UPDATE with reasons + id', async () => {
    const rows = [
      { id: 'rcl_1', edge_id: 'e1', anchor_ref: 'product:ext_a', candidate_product_ref: 'product:ext_b', relation_type: 'competitive_alternative' },
    ];
    const updates = [];
    const queryFn = makeQueryFn(rows, { updates });
    const lookupFn = jest.fn(async () => new Map([
      ['ext_a', attrs({ target_area: 'face' })],
      ['ext_b', attrs({ target_area: 'lips', category_leaf: 'lip_balm' })],
    ]));
    const { metric } = await rescore({ queryFn, lookupFn, apply: true, now: makeNow() });
    expect(metric.dry_run).toBe(false);
    expect(metric.promoted).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('rcl_1');
    expect(updates[0].reasons.some((r) => r.startsWith('target_area_mismatch'))).toBe(true);
  });

  test('counts promoted, skipped, and passed correctly', async () => {
    const rows = [
      // Will promote (target_area mismatch)
      { id: 'rcl_promote', edge_id: 'e1', anchor_ref: 'product:ext_a', candidate_product_ref: 'product:ext_b', relation_type: 'competitive_alternative' },
      // Will pass (same attrs)
      { id: 'rcl_pass', edge_id: 'e2', anchor_ref: 'product:ext_c', candidate_product_ref: 'product:ext_d', relation_type: 'competitive_alternative' },
      // Will skip (missing attrs)
      { id: 'rcl_skip', edge_id: 'e3', anchor_ref: 'product:ext_missing1', candidate_product_ref: 'product:ext_missing2', relation_type: 'competitive_alternative' },
    ];
    const queryFn = makeQueryFn(rows);
    const lookupFn = jest.fn(async () => new Map([
      ['ext_a', attrs({ target_area: 'face' })],
      ['ext_b', attrs({ target_area: 'lips', category_leaf: 'lip_balm' })],
      ['ext_c', attrs()],
      ['ext_d', attrs()],
    ]));
    const { metric } = await rescore({ queryFn, lookupFn, apply: false, now: makeNow() });
    expect(metric.candidates_scored).toBe(3);
    expect(metric.promoted).toBe(1);
    expect(metric.passed).toBe(1);
    expect(metric.skipped_missing_attrs).toBe(1);
  });

  test('returns promotion list for audit/replay', async () => {
    const rows = [
      { id: 'rcl_1', edge_id: 'e1', anchor_ref: 'product:ext_a', candidate_product_ref: 'product:ext_b', relation_type: 'competitive_alternative' },
    ];
    const queryFn = makeQueryFn(rows);
    const lookupFn = jest.fn(async () => new Map([
      ['ext_a', attrs({ target_area: 'face' })],
      ['ext_b', attrs({ target_area: 'lips', category_leaf: 'lip_balm' })],
    ]));
    const { promotions } = await rescore({ queryFn, lookupFn, apply: false, now: makeNow() });
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({ id: 'rcl_1', edge_id: 'e1' });
    expect(promotions[0].reasons).toEqual(expect.arrayContaining([expect.stringMatching(/^target_area_mismatch/)]));
  });
});
