const { wellFormedText, truncateText, wellFormedJsonValue, safeJsonbParam } = require('../src/auroraBff/relationshipSafeText');
const { normalizeProductsCacheRow } = require('../src/auroraBff/productRelationshipGraphSources');
const { recordRelationshipGraphRun } = require('../src/services/relationshipGraphRunLedger');
const { rememberNegativeVerdict } = require('../scripts/review-relationship-candidate-labels');
const { runCli, persistEdgesWithGlobalFanInCap, __internal: { describeFailure } } = require('../scripts/build-product-relationship-graph');

// 2026-11-02: relgraph-sync's build died on "invalid input syntax for type json". A product
// description longer than 512 characters had an emoji at the cut; slice(0, 512) kept its first
// half, JSON.stringify wrote it as "\ud83c", and Postgres refused the label row. Every text cut and
// every jsonb parameter in the pipeline now goes through relationshipSafeText.
const LEAF = '\u{1F33F}'; // 🌿, two UTF-16 code units
const LONE_ESCAPE = /\\ud[89a-f][0-9a-f]{2}/i;
const isWellFormed = (s) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('truncateText', () => {
  test('a cut that would split a pair drops the whole character', () => {
    const text = 'a'.repeat(511) + LEAF + ' more';
    expect(text.slice(0, 512).endsWith('\uD83C')).toBe(true); // the old cut
    const cut = truncateText(text, 512);
    expect(cut).toBe('a'.repeat(511));
    expect(isWellFormed(cut)).toBe(true);
  });
  test('a cut just after a whole pair keeps it', () => {
    expect(truncateText('a'.repeat(510) + LEAF + 'b', 512)).toBe('a'.repeat(510) + LEAF);
  });
  test('short text is returned unchanged, never longer than max', () => {
    expect(truncateText('Hydrating Cream', 512)).toBe('Hydrating Cream');
    for (let max = 0; max < 8; max += 1) {
      const out = truncateText(`${LEAF}x${LEAF}${LEAF}`, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(isWellFormed(out)).toBe(true);
    }
  });
  test('text that arrives malformed is repaired, and NUL is removed', () => {
    expect(truncateText('ab\uD83Ccd\u0000e', 512)).toBe('ab\uFFFDcde');
    expect(truncateText('\uDF3Fx', 512)).toBe('\uFFFDx');
  });
  test('cutting twice gives the same text', () => {
    const once = truncateText('a'.repeat(300) + LEAF.repeat(40), 350);
    expect(truncateText(once, 350)).toBe(once);
  });
});

describe('safeJsonbParam', () => {
  test('lone halves in values and keys never reach the JSON text', () => {
    const value = { title: 'x\uD83C', ['k\uDF3F']: ['\uD83C', { nested: 'ok\u0000' }], whole: LEAF };
    const json = safeJsonbParam(value);
    expect(json).not.toMatch(LONE_ESCAPE);
    expect(json).not.toContain('\\u0000');
    expect(JSON.parse(json)).toEqual({ title: 'x\uFFFD', 'k\uFFFD': ['\uFFFD', { nested: 'ok' }], whole: LEAF });
  });
  test('well-formed values serialise exactly as JSON.stringify did', () => {
    const value = { a: 1, b: [true, null, 'Crème 🌿', { c: 'd' }], e: { f: 0.5 } };
    expect(safeJsonbParam(value)).toBe(JSON.stringify(value));
    const at = new Date('2026-11-02T10:37:00Z');
    expect(safeJsonbParam({ at })).toBe(JSON.stringify({ at }));
  });
  test('a shared sub-object is cleaned at every place it appears; a cycle falls back', () => {
    const shared = { t: 'a\uD83C' };
    expect(JSON.parse(safeJsonbParam({ x: shared, y: shared }))).toEqual({ x: { t: 'a\uFFFD' }, y: { t: 'a\uFFFD' } });
    const cyclic = { a: 1 }; cyclic.self = cyclic;
    expect(safeJsonbParam(cyclic)).toBe('null');
    expect(safeJsonbParam(cyclic, {})).toBe('{}');
  });
  test('undefined uses the fallback', () => {
    expect(safeJsonbParam(undefined, [])).toBe('[]');
    expect(safeJsonbParam(null, {})).toBe('null');
  });
  test('wellFormedText and wellFormedJsonValue leave good text alone', () => {
    expect(wellFormedText(`Glow ${LEAF} 美容液`)).toBe(`Glow ${LEAF} 美容液`);
    expect(wellFormedJsonValue(['a', 1, null])).toEqual(['a', 1, null]);
  });
});

describe('the pipeline writes no lone halves', () => {
  test('a products_cache row cut at 512 characters through an emoji (the 2026-11-02 shape)', () => {
    const row = normalizeProductsCacheRow({ product_id: 'p1', merchant_id: 'm1',
      product_data: { title: 'T', brand: 'B', description: 'a'.repeat(511) + LEAF + ' more' } });
    expect(JSON.stringify(row)).not.toMatch(LONE_ESCAPE);
  });

  test('the run ledger summary', async () => {
    const calls = [];
    await recordRelationshipGraphRun({ run_id: 'relgraph_sync_routine_test', status: 'failed', stderr_tail: `x${'\uD83C'}`,
      steps: [{ id: 'build', stderr_tail: 'y\uDF3F' }] }, { queryFn: async (sql, params) => { calls.push(params); return { rows: [] }; } });
    expect(calls).toHaveLength(1);
    for (const param of calls[0]) if (typeof param === 'string') expect(param).not.toMatch(LONE_ESCAPE);
  });

  test('the review negative memo', async () => {
    const calls = [];
    await rememberNegativeVerdict({ id: 'prel_1' }, { verdict: 'reject', rationale: `cut ${'\uD83C'}`, reviewed_at: '2026-11-02T00:00:00Z' },
      async (sql, params) => { calls.push(params); return { rows: [] }; });
    expect(calls[0][1]).not.toMatch(LONE_ESCAPE);
    expect(JSON.parse(calls[0][1]).rationale).toBe('cut \uFFFD');
  });
});

describe('a failed build names what Postgres refused', () => {
  test('describeFailure keeps the pg fields and the row', () => {
    const err = Object.assign(new Error('invalid input syntax for type json'), {
      code: '22P02', detail: 'Unicode low surrogate must follow a high surrogate.', where: 'JSON data, line 1: ...',
      relgraph_write: { edge_id: 'prel_x', anchor_ref: 'product:a', candidate_ref: 'product:b' } });
    expect(describeFailure(err)).toEqual({ code: '22P02', detail: 'Unicode low surrogate must follow a high surrogate.',
      where: 'JSON data, line 1: ...', relgraph_write: { edge_id: 'prel_x', anchor_ref: 'product:a', candidate_ref: 'product:b' } });
    expect(describeFailure(new Error('plain'))).toBeNull();
  });

  test.each(['related_product', 'competitive_alternative'])('a refused %s label write carries its pair and still throws', async (relation) => {
    const refused = Object.assign(new Error('invalid input syntax for type json'), { code: '22P02' });
    const queryFn = async (sql) => {
      if (/INSERT INTO relationship_candidate_labels/.test(sql)) throw refused;
      return { rows: [] };
    };
    const runInClient = async (fn) => fn({ query: queryFn });
    const edge = { id: 'prel_bad', anchor_type: 'product', anchor_ref: 'product:a', candidate_product_ref: 'product:b',
      relation_type: relation, market: 'US', score_total: 0.8 };
    await expect(persistEdgesWithGlobalFanInCap({ edges: [edge], cap: 8, queryFn, runInClient })).rejects.toBe(refused);
    expect(refused.relgraph_write).toEqual({ edge_id: 'prel_bad', anchor_ref: 'product:a', candidate_ref: 'product:b',
      relation_type: relation, label_state: 'generated' });
    delete refused.relgraph_write;
  });

  test('runCli prints it and still exits 1', async () => {
    const writes = [];
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => { writes.push(String(chunk)); return true; });
    const before = process.exitCode;
    try {
      await runCli({ runMain: async () => { throw Object.assign(new Error('boom'), { code: '22P02', detail: 'd' }); }, closeDbPool: async () => {} });
      expect(process.exitCode).toBe(1);
    } finally {
      spy.mockRestore();
      process.exitCode = before;
    }
    expect(writes.join('')).toContain('relgraph build failure: {"code":"22P02","detail":"d"}');
  });
});
