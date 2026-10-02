const recall = require('../src/auroraBff/productRelationshipGraphTargetRecall');
const sources = require('../src/auroraBff/productRelationshipGraphSources');
const { buildEdgeForCandidate } = require('../src/auroraBff/productRelationshipGraphBuilder');

const anchor = { product_ref: 'product:sig_anchor', product_key: 'anchor', name: 'Gentle Hyaluronic Face Serum',
  brand: 'House', category: 'Face Serum', description: 'Gentle hydrating hyaluronic acid serum', price: 40, price_currency: 'USD' };
function row(id, overrides = {}) {
  return { recall_anchor_ref: anchor.product_ref, product_key: id, product_ref: `product:sig_${id}`,
    pivota_signature_id: `sig_${id}`, source_product_id: id, title: 'Gentle Hyaluronic Face Serum', brand: `Brand ${id}`,
    category: 'Face Serum', description: 'Gentle hydrating hyaluronic acid serum',
    product_payload: { price: 25, price_currency: 'USD' }, ...overrides };
}

test('catalog recall does not fabricate similarity, price evidence, or recommendation approval', async () => {
  const queryFn = jest.fn(async () => ({ rows: [row('target')] }));
  const loaded = await recall.loadProductRelationshipGraphTargetRecall({ queryFn, anchors: [anchor] });
  const target = loaded.products[0];
  expect(target).not.toHaveProperty('similarity_score');
  expect(target).not.toHaveProperty('score_total');
  expect(target).not.toHaveProperty('review_status');
  const [candidate] = sources.buildCandidatesByAnchorFromSources({ anchors: [anchor], products: loaded.products, includeTransitiveRecall: false })[anchor.product_ref];
  expect(buildEdgeForCandidate({ anchor, candidate }).edge.relation_type).toBe('competitive_alternative');
  const otherCurrency = { ...target, price_currency: 'JPY', price: 5 };
  const [currencyCandidate] = sources.buildCandidatesByAnchorFromSources({ anchors: [anchor], products: [otherCurrency], includeTransitiveRecall: false })[anchor.product_ref];
  expect(currencyCandidate.price_advantage).toBe(0);
  const broadAnchor = { ...anchor, name: 'Alpha Day Formula', description: '', category: 'Skincare', category_taxonomy: ['Skincare'] };
  const [shelfCandidate] = sources.buildCandidatesByAnchorFromSources({ anchors: [broadAnchor], products: [
    { product_ref: target.product_ref, name: 'Night Concentrate', brand: 'Other', category: 'Skincare' },
  ], includeTransitiveRecall: false })[anchor.product_ref];
  expect(buildEdgeForCandidate({ anchor: broadAnchor, candidate: shelfCandidate }).edge?.relation_type).not.toBe('competitive_alternative');
});

test('bounded pages replace incompatible rows, run sequentially, and retain per-anchor budgets', async () => {
  let active = 0; let peak = 0;
  const secondAnchor = { ...anchor, product_ref: 'product:sig_second' };
  const queryFn = jest.fn(async (sql, params) => {
    peak = Math.max(peak, ++active);
    const profiles = JSON.parse(params[0]);
    const rows = profiles.flatMap((profile) => Array.from({ length: params[3] - params[2] }, (_, i) =>
      row(`candidate_${params[2] + i}`, { recall_anchor_ref: profile.anchor_ref,
        title: params[2] === 0 ? 'Hydrating Hair Serum' : 'Gentle Hyaluronic Face Serum',
        category: params[2] === 0 ? 'Hair Serum' : 'Face Serum' })));
    await Promise.resolve(); active -= 1;
    return { rows };
  });
  const loaded = await recall.loadProductRelationshipGraphTargetRecall({ queryFn, anchors: [anchor, secondAnchor],
    batchSize: 1, perAnchor: 5, maxCandidates: 4, maxPages: 2 });
  expect(peak).toBe(1);
  expect(queryFn).toHaveBeenCalledTimes(4);
  expect(loaded.diagnostics).toMatchObject({ rows_read: 8, candidate_count: 4, structural_rejected_count: 4, per_anchor_budget: 2 });
  expect(Object.values(loaded.candidatesByAnchor).map((list) => list.length)).toEqual([2, 2]);
});

test('generic category and brand alone never produce a full-catalog query', async () => {
  const queryFn = jest.fn();
  const loaded = await recall.loadProductRelationshipGraphTargetRecall({ queryFn,
    anchors: [{ product_ref: 'product:a', name: 'Collection Alpha', brand: 'House', category: 'Beauty' }] });
  expect(queryFn).not.toHaveBeenCalled();
  expect(loaded.diagnostics.unqueried_anchor_count).toBe(1);
});

test('same-family decorative variants remain outside alternative recall', async () => {
  const lashAnchor = { product_ref: 'product:lashes', name: 'Cloud False Lashes - Midnight', brand: 'House', category: 'False Lashes' };
  const loaded = await recall.loadProductRelationshipGraphTargetRecall({ anchors: [lashAnchor],
    queryFn: async () => ({ rows: [row('style', { recall_anchor_ref: lashAnchor.product_ref,
      title: 'Cloud False Lashes - Stardust', brand: 'House', category: 'False Lashes' })] }) });
  expect(loaded.products).toHaveLength(0);
  expect(loaded.diagnostics.structural_rejected_count).toBe(1);
});

test('caps, missing trust support, and schema drift fail closed without unbounded retry', async () => {
  expect(recall.normalizeTargetRecallOptions({ maxAnchors: 10000, batchSize: 1000, perAnchor: 10000,
    maxCandidates: 10000, maxPages: 1000 })).toEqual({ maxAnchors: 400, batchSize: 20, perAnchor: 96, maxCandidates: 5000, maxPages: 3 });
  const missing = jest.fn(async () => { throw Object.assign(new Error('relation catalog_row_trust does not exist'), { code: '42P01' }); });
  expect((await recall.loadProductRelationshipGraphTargetRecall({ queryFn: missing, anchors: [anchor] })).diagnostics.skipped)
    .toBe('required_catalog_source_missing');
  expect(missing).toHaveBeenCalledTimes(1);
  const drift = async () => { throw Object.assign(new Error('column recall_market does not exist'), { code: '42703' }); };
  await expect(recall.loadProductRelationshipGraphTargetRecall({ queryFn: drift, anchors: [anchor] })).rejects.toHaveProperty('code', '42703');
});

test('small operator-selected batches cannot bypass the aggregate SQL-call ceiling', async () => {
  const anchors = Array.from({ length: 400 }, (_, i) => ({ ...anchor, product_ref: `product:sig_anchor_${i}` }));
  const queryFn = jest.fn(async () => ({ rows: [] }));
  const loaded = await recall.loadProductRelationshipGraphTargetRecall({ anchors, queryFn,
    maxAnchors: 400, batchSize: 1, maxPages: 3 });
  expect(queryFn).toHaveBeenCalledTimes(60);
  expect(loaded.diagnostics).toMatchObject({ query_cap_reached: true, queried_anchor_count: 60, unqueried_anchor_count: 340 });
});

test('cron expansion and every retrieval cap reach the build only on explicit opt-in', () => {
  const cron = require('../scripts/run-relationship-graph-sync-routine-cron');
  const sync = require('../scripts/run-relationship-graph-sync-routine');
  const routine = require('../scripts/run-relationship-graph-routine-job');
  for (const enabled of [false, true]) {
    const args = cron.buildCronArgs({ RELGRAPH_SYNC_EXPAND_TARGET_RECALL: String(enabled),
      RELGRAPH_SYNC_TARGET_RECALL_MAX_ANCHORS: '12', RELGRAPH_SYNC_TARGET_RECALL_BATCH_SIZE: '4',
      RELGRAPH_SYNC_TARGET_RECALL_PER_ANCHOR: '16', RELGRAPH_SYNC_TARGET_RECALL_MAX_CANDIDATES: '120',
      RELGRAPH_SYNC_TARGET_RECALL_MAX_PAGES: '3', RELGRAPH_SYNC_SKIP_REVIEW: 'true' }).args;
    const syncOptions = sync.parseArgs(args);
    const routineStep = sync.buildSyncRoutineSteps(syncOptions).steps.find((step) => step.id === 'relationship_graph_routine');
    const routineOptions = routine.parseArgs(routineStep.args.slice(1));
    const buildStep = routine.buildRoutineSteps(routineOptions).steps.find((step) => step.id === 'build');
    expect(buildStep.args.includes('--expand-target-recall')).toBe(enabled);
    if (enabled) {
      expect(routineOptions.targetRecallOptions).toEqual({ maxAnchors: 12, batchSize: 4, perAnchor: 16, maxCandidates: 120, maxPages: 3 });
      for (const [flag, value] of [['max-anchors', '12'], ['batch-size', '4'], ['per-anchor', '16'], ['max-candidates', '120'], ['max-pages', '3']]) {
        expect(buildStep.args[buildStep.args.indexOf(`--target-recall-${flag}`) + 1]).toBe(value);
      }
    } else expect(buildStep.args.some((arg) => arg.startsWith('--target-recall-'))).toBe(false);
  }
});
