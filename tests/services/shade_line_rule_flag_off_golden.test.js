// SHADE_LINE_RULE_V2_ENABLED off (the default) must leave the identity backfill byte-identical to the
// code before rule shade_line_v2: the same statements, in the same order, with the same params —
// so the same product_line_id, review_family_id, variant_axes, match_basis and soft_identity on
// every written row. The golden capture was taken from origin/main (see its generated_from) with
// tests/fixtures/shade_line_backfill_capture.js over invented seed rows.

const golden = require('../fixtures/shade_line_rule_flag_off_golden.json');

describe('shade line rule: flag off is byte-identical to the code before the rule', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test' };
    delete process.env.SHADE_LINE_RULE_V2_ENABLED;
    delete process.env.PDP_IDENTITY_GRAPH_AUTO_ENABLE_LIVE;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test.each([[undefined], ['false'], ['0'], ['off']])('flag=%s: every statement and param equals the golden capture', async (flag) => {
    if (flag !== undefined) process.env.SHADE_LINE_RULE_V2_ENABLED = flag;
    const { captureBackfill } = require('../fixtures/shade_line_backfill_capture');
    const pdpIdentityGraph = require('../../src/services/pdpIdentityGraph');
    const capture = await captureBackfill(pdpIdentityGraph);
    expect(capture.result).toEqual(golden.result);
    expect(capture.statements).toHaveLength(golden.statements.length);
    capture.statements.forEach((statement, idx) => expect(statement).toEqual(golden.statements[idx]));
  });

  test('flag off: the backfill read adds no catalog category fields to the rows it builds from', async () => {
    const { GOLDEN_SEED_ROWS } = require('../fixtures/shade_line_backfill_capture');
    const { _internals } = require('../../src/services/pdpIdentityGraph');
    const queryFn = async (sql) => ({ rows: String(sql).includes('FROM external_product_seeds e') ? GOLDEN_SEED_ROWS : [] });
    const rows = await _internals.fetchBackfillProducts({ queryFn });
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((row) => {
      expect(row.source_meta).not.toHaveProperty('catalog_category_path');
      expect(row.source_meta).not.toHaveProperty('catalog_product_type');
    });
    process.env.SHADE_LINE_RULE_V2_ENABLED = 'true';
    const withFlag = await _internals.fetchBackfillProducts({ queryFn });
    expect(withFlag[0].source_meta).toHaveProperty('catalog_product_type', 'nail-polish');
  });

  test('flag on: the same rows are lined up (so the golden comparison is not vacuous)', async () => {
    process.env.SHADE_LINE_RULE_V2_ENABLED = 'true';
    const { captureBackfill } = require('../fixtures/shade_line_backfill_capture');
    const pdpIdentityGraph = require('../../src/services/pdpIdentityGraph');
    const capture = await captureBackfill(pdpIdentityGraph);
    expect(capture.statements).not.toEqual(golden.statements);
    expect(capture.result.shade_lines.approved).toBeGreaterThan(0);
  });
});
