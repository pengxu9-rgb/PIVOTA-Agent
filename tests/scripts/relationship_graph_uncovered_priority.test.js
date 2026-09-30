const selector = require('../../scripts/select-relationship-graph-affected-products');
const sources = require('../../src/auroraBff/productRelationshipGraphSources');
const { uncoveredLiveCatalogSql, prioritizeUncoveredProducts } = require('../../src/auroraBff/relationshipGraphCoverage');
const baselineCalls = require('../fixtures/relgraph_selection_default_sql.json');
const SINCE = '2026-09-29T00:00:00.000Z';

async function fetchCalls(prioritizeUncovered) {
  const queryFn = jest.fn(async () => ({ rows: [] }));
  await selector.fetchCatalogProductRows({ queryFn, updatedSince: SINCE, limit: 250, prioritizeUncovered });
  await selector.fetchExternalSeedRows({ queryFn, updatedSince: SINCE, limit: 250, market: 'US', prioritizeUncovered });
  await sources.loadAffectedProductAnchorCandidates({ queryFn, refs: ['sig_fixture'], market: 'US', limit: 250, prioritizeUncovered });
  return queryFn.mock.calls;
}

test('default and explicit flag off preserve every selector and affected-loader SQL byte and parameter from main', async () => {
  expect(await fetchCalls()).toEqual(baselineCalls);
  expect(await fetchCalls(false)).toEqual(baselineCalls);
});

test('flag on projects priority once and sorts the alias before existing tie breakers', async () => {
  const calls = await fetchCalls(true);
  calls.forEach(([sql, params], i) => {
    const [oldSql, oldParams] = baselineCalls[i];
    expect(params.slice(0, oldParams.length)).toEqual(oldParams);
    expect(sql).toContain('LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id');
    expect(sql).toContain('ORDER BY relgraph_uncovered_live DESC, relgraph_priority DESC, relgraph_last_activity ASC NULLS FIRST, ');
    expect(sql).toContain(oldSql.split('ORDER BY ')[1]);
    expect(sql.match(/AS relgraph_uncovered_live/g)).toHaveLength(1);
    expect(sql.split('ORDER BY').at(-1)).not.toContain('NOT EXISTS');
  });
});

test('uncovered live catalog anchor precedes covered signatures, covered attached seeds and suppressed products after dedupe', async () => {
  const catalogRow = (key, priority) => ({ product_key: key, pivota_signature_id: `sig_${key}`,
    source_product_id: key, title: `${key} beauty serum`, brand: key, category: 'Serum',
    canonical_url: `https://${key}.example/serum`, relgraph_uncovered_live: priority });
  const rows = [catalogRow('a_covered_sig', false), catalogRow('b_covered_seed', false),
    catalogRow('c_suppressed', false), catalogRow('z_uncovered', true), catalogRow('zz_uncovered', true)];
  const seed = { id: 'seed', external_product_id: 'ext_seed', attached_product_key: 'b_covered_seed',
    product_key: 'b_covered_seed', pivota_signature_id: 'sig_b_covered_seed', product_ref: 'product:sig_b_covered_seed',
    title: 'b_covered_seed beauty serum', brand: 'b_covered_seed', category: 'Serum',
    canonical_url: 'https://b_covered_seed.example/serum', relgraph_uncovered_live: false };
  const queryFn = jest.fn(async (sql) => {
    if (sql.includes('FROM external_product_seeds eps')) return { rows: [seed] };
    if (sql.includes('FROM products_cache pc')) return { rows: [] };
    return { rows };
  });
  const result = await sources.loadAffectedProductAnchorCandidates({ queryFn, refs: ['fixture'], prioritizeUncovered: true });
  expect(result.map((product) => product.pivota_signature_id)).toEqual([
    'sig_z_uncovered', 'sig_zz_uncovered', 'sig_a_covered_sig', 'sig_b_covered_seed', 'sig_c_suppressed',
  ]);
  // A final pool dedupe loses loader annotations and sorts alphabetically. Repartition by serving
  // refs rather than reconstructing ids, so #2265's sig-owned merged retailer identity stays intact.
  const finalPool = sources.dedupeNormalizedProducts(result);
  const ordered = prioritizeUncoveredProducts(finalPool, result.filter((product) => product._relgraph_uncovered_live));
  expect(ordered.map((product) => product.pivota_signature_id)).toEqual(result.map((product) => product.pivota_signature_id));
  expect(ordered.find((product) => product.pivota_signature_id === 'sig_b_covered_seed').product_ref).toBe('product:sig_b_covered_seed');
});

test('cron flag defaults off and reaches selector and build child only when armed', () => {
  const cron = require('../../scripts/run-relationship-graph-sync-routine-cron');
  const sync = require('../../scripts/run-relationship-graph-sync-routine');
  const routine = require('../../scripts/run-relationship-graph-routine-job');
  for (const value of [undefined, 'false', 'true']) {
    const config = cron.buildCronArgs({ RELGRAPH_SYNC_PRIORITIZE_UNCOVERED: value, RELGRAPH_SYNC_UNCOVERED_COOLDOWN_DAYS: '11', RELGRAPH_SYNC_COVERAGE_SIBLING_REFS: 'false' });
    const steps = sync.buildSyncRoutineSteps(sync.parseArgs(config.args)).steps;
    const selectorStep = steps.find((step) => step.id === 'affected_product_selector');
    const routineStep = steps.find((step) => step.args[0].endsWith('run-relationship-graph-routine-job.js'));
    const build = routine.buildRoutineSteps(routine.parseArgs(routineStep.args)).steps.find((step) => step.id === 'build');
    for (const argv of [config.args, selectorStep.args, routineStep.args, build.args]) {
      expect(argv.includes('--prioritize-uncovered')).toBe(value === 'true');
      const i = argv.indexOf('--uncovered-cooldown-days');
      expect(i >= 0).toBe(value === 'true');
      if (i >= 0) expect(argv[i + 1]).toBe('11');
      const sibling = argv.indexOf('--coverage-sibling-refs');
      expect(sibling >= 0).toBe(value === 'true');
      if (sibling >= 0) expect(argv[sibling + 1]).toBe('false');
    }
  }
});

test('full source pool retains uncovered priority after its final dedupe', async () => {
  const queryFn = jest.fn(async (sql) => {
    if (!sql.includes('AS relgraph_uncovered_live')) return { rows: [] };
    if (!sql.includes('FROM catalog_products cp')) return { rows: [] };
    return { rows: [
      { product_key: 'covered', pivota_signature_id: 'sig_a', title: 'A serum', brand: 'A', category: 'Serum', relgraph_uncovered_live: false },
      { product_key: 'uncovered', pivota_signature_id: 'sig_z', title: 'Z cleanser', brand: 'Z', category: 'Cleanser', relgraph_uncovered_live: true },
    ] };
  });
  const result = await sources.loadProductRelationshipGraphSourceInputs({ queryFn, affectedRefs: ['sig_a', 'sig_z'], prioritizeUncovered: true });
  expect(result.products.map((product) => product.product_ref)).toEqual(['product:sig_z', 'product:sig_a']);
});


test('normalization preserves never-attempted, oldest-pending and terminal ordering', async () => {
  const rows = [
    { product_key:'terminal',pivota_signature_id:'sig_a',relgraph_priority:1,relgraph_last_activity:'2026-01-01' },
    { product_key:'new',pivota_signature_id:'sig_b',relgraph_priority:2,relgraph_last_activity:'2026-02-01' },
    { product_key:'old',pivota_signature_id:'sig_c',relgraph_priority:2,relgraph_last_activity:'2026-01-01' },
    { product_key:'never',pivota_signature_id:'sig_z',relgraph_priority:3,relgraph_last_activity:null },
  ].map((row)=>({...row,title:'Beauty serum',brand:row.product_key,category:'Serum',relgraph_uncovered_live:true}));
  const queryFn=async(sql)=>({ rows:sql.includes('FROM catalog_products cp') ? rows : [] });
  const result=await sources.loadAffectedProductAnchorCandidates({queryFn,refs:['fixture'],prioritizeUncovered:true});
  expect(result.map((product)=>product.pivota_signature_id)).toEqual(['sig_z','sig_c','sig_b','sig_a']);
  const final=prioritizeUncoveredProducts(sources.dedupeNormalizedProducts(result),result);
  expect(final.map((product)=>product.pivota_signature_id)).toEqual(['sig_z','sig_c','sig_b','sig_a']);
});
