const selector = require('../../scripts/select-relationship-graph-affected-products');
const sources = require('../../src/auroraBff/productRelationshipGraphSources');
const { uncoveredLiveCatalogSql, prioritizeUncoveredProducts } = require('../../src/auroraBff/relationshipGraphCoverage');
const baselineCalls = require('../fixtures/relgraph_selection_default_sql.json');
const SINCE = '2026-09-29T00:00:00.000Z';

async function fetchCalls(prioritizeUncovered) {
  const queryFn = jest.fn(async (sql) => ({ rows: sql.includes('to_regclass') ? [{ table_name: 'relationship_graph_anchor_attempts', can_insert: true, can_select: true, can_update: true }] : [] }));
  await selector.fetchCatalogProductRows({ queryFn, updatedSince: SINCE, limit: 250, prioritizeUncovered });
  await selector.fetchExternalSeedRows({ queryFn, updatedSince: SINCE, limit: 250, market: 'US', prioritizeUncovered });
  await sources.loadAffectedProductAnchorCandidates({ queryFn, refs: ['sig_fixture'], market: 'US', limit: 250, prioritizeUncovered });
  if (!prioritizeUncovered) {
    expect(queryFn.mock.calls.filter(([sql]) => sql.includes('to_regclass'))).toHaveLength(0);
    return queryFn.mock.calls;
  }
  return queryFn.mock.calls.filter(([sql]) => sql.includes('AS relgraph_uncovered_live'));
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
    if (sql.includes('to_regclass')) return { rows: [{ table_name: 'relationship_graph_anchor_attempts', can_insert: true, can_select: true, can_update: true }] };
    if (sql.includes('FROM relationship_candidate_labels') && !sql.includes('AS relgraph_uncovered_live')) return { rows: [] };
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
    if (sql.includes('to_regclass')) return { rows: [{ table_name: 'relationship_graph_anchor_attempts', can_insert: true, can_select: true, can_update: true }] };
    if (sql.includes('FROM relationship_candidate_labels') && !sql.includes('AS relgraph_uncovered_live')) return { rows: [] };
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
  const queryFn=async(sql)=>({ rows:sql.includes('to_regclass') ? [{ table_name: 'relationship_graph_anchor_attempts', can_insert: true, can_select: true, can_update: true }] : sql.includes('FROM catalog_products cp') ? rows : [] });
  const result=await sources.loadAffectedProductAnchorCandidates({queryFn,refs:['fixture'],prioritizeUncovered:true});
  expect(result.map((product)=>product.pivota_signature_id)).toEqual(['sig_z','sig_c','sig_b','sig_a']);
  const final=prioritizeUncoveredProducts(sources.dedupeNormalizedProducts(result),result);
  expect(final.map((product)=>product.pivota_signature_id)).toEqual(['sig_z','sig_c','sig_b','sig_a']);
});

const { loadCoverageSuppressedIds, requireAnchorAttemptsTable } = require('../../src/auroraBff/relationshipGraphCoverage');
test.each(['selector', 'affected-loader', 'source-pool'])('missing migration fails up front in %s, including empty refs', async (entry) => {
  const queryFn = jest.fn(async () => ({ rows: [{ table_name: null }] }));
  const operation = entry === 'selector'
    ? selector.run(['--updated-since', SINCE, '--prioritize-uncovered', '--allow-empty-selection'], { queryFn })
    : entry === 'affected-loader' ? sources.loadAffectedProductAnchorCandidates({ queryFn, refs: [], prioritizeUncovered: true })
    : sources.loadProductRelationshipGraphSourceInputs({ queryFn, affectedRefs: ['fixture'], prioritizeUncovered: true });
  await expect(operation).rejects.toMatchObject({ code: 'RELGRAPH_ANCHOR_ATTEMPTS_MISSING' });
  expect(queryFn).toHaveBeenCalledTimes(1);
});
test('shared serving guard determines title-based coverage exclusions once per selector run', async () => {
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const hidden = { id:'hidden', label_state:'ai_approved', relation_type:'related_product', anchor_ref:'product:a',candidate_product_ref:'product:b',
    anchor_snapshot:{ brand:'Test',title:'Hydrating Face Foundation - 100 Light' }, candidate_snapshot:{ brand:'Test',title:'Hydrating Face Foundation - 200 Dark' } };
  const queryFn = jest.fn(async (sql) => {
    if (sql.includes('to_regclass')) return { rows:[{ table_name: 'relationship_graph_anchor_attempts', can_insert: true, can_select: true, can_update: true }] };
    if (!sql.includes('AS relgraph_uncovered_live')) return { rows:[hidden] };
    return { rows:[] };
  });
  await selector.run(['--updated-since', SINCE, '--prioritize-uncovered', '--allow-empty-selection'], { queryFn });
  expect(queryFn.mock.calls.filter(([sql]) => sql.includes('to_regclass'))).toHaveLength(1);
  expect(queryFn.mock.calls.filter(([sql]) => !sql.includes('AS relgraph_uncovered_live') && !sql.includes('to_regclass'))).toHaveLength(1);
  const coverage = queryFn.mock.calls.filter(([sql]) => sql.includes('AS relgraph_uncovered_live'));
  expect(coverage).toHaveLength(2);
  coverage.forEach(([sql, params]) => { expect(params.at(-1)).toEqual(['hidden']); expect(sql).toContain('NOT (rcl.id = ANY($5::text[]))'); });
  jest.restoreAllMocks();
});

test('coverage automatically uses a newly installed reason from the shared serving owner', async () => {
  const graph = require('../../src/auroraBff/productRelationshipGraph');
  const guard = jest.spyOn(graph,'isRelationshipEdgeServingSafe')
    .mockImplementation((row)=>row.id !== 'same_product');
  const queryFn=async(sql)=>({rows:sql.includes('to_regclass')?[{table_name: 'relationship_graph_anchor_attempts', can_insert: true, can_select: true, can_update: true}]:[{id:'safe'},{id:'same_product'}]});
  try {expect(await loadCoverageSuppressedIds({queryFn})).toEqual(['same_product']);expect(guard).toHaveBeenCalledTimes(2);}
  finally {guard.mockRestore();}
});

test('coverage SQL refuses an omitted hidden-id input', () => {
  expect(() => uncoveredLiveCatalogSql('cp')).toThrow('requires suppressedIdsSql');
  expect(() => uncoveredLiveCatalogSql('cp', { suppressedIdsSql: '' })).toThrow('requires suppressedIdsSql');
  expect(uncoveredLiveCatalogSql('cp', { suppressedIdsSql: '$2::text[]' })).toContain('ANY($2::text[])');
});
test.each([[false, true, true], [true, false, true], [true, true, false], [false, false, false]])('preflight requires INSERT=%s, SELECT=%s and UPDATE=%s', async (can_insert, can_select, can_update) => {
  await expect(requireAnchorAttemptsTable(async () => ({ rows: [{ table_name: 'relationship_graph_anchor_attempts', can_insert, can_select, can_update }] })))
    .rejects.toMatchObject({ code: 'RELGRAPH_ANCHOR_ATTEMPTS_PRIVILEGES' });
});
test('direct manifest routine fails before PBA refresh or any child when schema is unavailable', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { runRoutineJob, parseArgs } = require('../../scripts/run-relationship-graph-routine-job');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-preflight-'));
  const runner = jest.fn(); const progressReader = jest.fn();
  try {
    const options = parseArgs(['--cutoff', SINCE, '--prioritize-uncovered', '--affected-products-file', path.join(dir, 'affected.json'), '--out-dir', dir]);
    await expect(runRoutineJob(options, { runner, progressReader, preflightQueryFn: async () => ({ rows: [{ table_name: null }] }) }))
      .rejects.toMatchObject({ code: 'RELGRAPH_ANCHOR_ATTEMPTS_MISSING', summary: { failed_step: 'uncovered_priority_preflight', steps: [] } });
    expect(runner).not.toHaveBeenCalled(); expect(progressReader).not.toHaveBeenCalled();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
