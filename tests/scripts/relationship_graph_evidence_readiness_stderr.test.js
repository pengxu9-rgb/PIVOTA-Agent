jest.mock('../../src/db', () => {
  const query = jest.fn(async () => ({ rows: [] }));
  return { query, closePool: jest.fn(), withClient: jest.fn(async (fn) => fn({ query })) };
});
jest.mock('../../src/auroraBff/productRelationshipGraphSources', () => ({
  ...jest.requireActual('../../src/auroraBff/productRelationshipGraphSources'),
  loadProductRelationshipGraphSourceInputs: jest.fn(),
  buildCandidatesByAnchorFromSources: jest.fn(),
  enrichProductRelationshipGraphProducts: jest.fn(),
}));
jest.mock('../../src/auroraBff/productRelationshipGraphTargetRecall', () => ({
  ...jest.requireActual('../../src/auroraBff/productRelationshipGraphTargetRecall'),
  loadProductRelationshipGraphTargetRecall: jest.fn(),
}));
const sources = require('../../src/auroraBff/productRelationshipGraphSources');
const recall = require('../../src/auroraBff/productRelationshipGraphTargetRecall');
const readiness = require('../../src/services/relationshipEvidenceReadiness');
const builder = require('../../scripts/build-product-relationship-graph');

// A routine keeps only the tail of each build step's output, and the summary printed on stdout is
// long, so evidence_readiness (inside it) never reached a log or the run ledger: on 2026-10-15
// whether the nightly's diagnostic sampled cleanly could not be checked. One stderr line, last.
const { evidenceReadinessStatusLine } = builder.__internal;

test('the status line names the exact-listing count, or the error', () => {
  expect(evidenceReadinessStatusLine({ unique_exact_listings: 487, sampled_anchor_count: 100, sampled_pair_count: 812, product_limit: 500 }))
    .toBe('relgraph evidence readiness: unique_exact_listings 487 (sampled anchors 100, pairs 812, products limit 500)');
  expect(evidenceReadinessStatusLine({ error: 'evidence_unique_products_exceed_bound', sampled_anchor_count: 100, sampled_pair_count: 0, product_limit: 500 }))
    .toBe('relgraph evidence readiness: error evidence_unique_products_exceed_bound (sampled anchors 100, pairs 0, products limit 500)');
  expect(evidenceReadinessStatusLine(null)).toBe('');
  expect(evidenceReadinessStatusLine(undefined)).toBe('');
});

describe('build main', () => {
  const originalArgv = process.argv;
  const anchor = (i) => ({ product_ref: `product:sig_a${i}`, product_key: `a${i}`, pivota_signature_id: `sig_a${i}`,
    name: `Hydrating serum ${i}`, brand: `Brand ${i}`, category: 'Serum', market: 'US', price: 18, price_currency: 'USD' });
  const candidate = (j) => ({ product_ref: `product:sig_c${j}`, product_key: `c${j}`, pivota_signature_id: `sig_c${j}`,
    name: `Hydrating serum c${j}`, brand: `Other ${j}`, category: 'Serum', market: 'US', price: 20, price_currency: 'USD' });
  let stdout; let stderr;
  beforeEach(() => {
    jest.clearAllMocks();
    const anchors = [anchor(1), anchor(2)];
    sources.loadProductRelationshipGraphSourceInputs.mockResolvedValue({ products: anchors, intelRows: [] });
    sources.enrichProductRelationshipGraphProducts.mockImplementation(async ({ products }) => ({ products, ingredientRows: [], intelRows: [], diagnostics: {} }));
    sources.buildCandidatesByAnchorFromSources.mockImplementation(() => ({ [anchors[0].product_ref]: [candidate(1)], [anchors[1].product_ref]: [candidate(2)] }));
    recall.loadProductRelationshipGraphTargetRecall.mockResolvedValue({ products: [], candidatesByAnchor: {}, diagnostics: { caps: { maxCandidates: 5000 } } });
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => { process.argv = originalArgv; jest.restoreAllMocks(); });
  const stdoutText = () => stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
  const lastStderr = () => String(stderr.mock.calls[stderr.mock.calls.length - 1]?.[0] || '');

  test('an expanded build writes the readiness status as its last stderr line; stdout is unchanged', async () => {
    process.argv = ['node', 'build-product-relationship-graph', '--skip-need-nodes', '--expand-target-recall'];
    await builder.main();
    const summary = JSON.parse(stdoutText());
    const evidence = summary.source_diagnostics.evidence_readiness;
    expect(evidence.unique_exact_listings).toBeGreaterThan(0);
    expect(lastStderr()).toBe(`${evidenceReadinessStatusLine(evidence)}\n`);
    expect(lastStderr()).toMatch(/^relgraph evidence readiness: unique_exact_listings \d+ /);
    // stdout carries exactly the summary, as before: the status line goes to stderr only.
    expect(stdoutText()).toBe(`${JSON.stringify(summary, null, 2)}\n`);
  });

  test('a recorded diagnostic error is the status line', async () => {
    jest.spyOn(readiness, 'summarizeRelationshipEvidenceReadiness').mockImplementation(() => { throw new Error('invalid_evidence_identity'); });
    process.argv = ['node', 'build-product-relationship-graph', '--skip-need-nodes', '--expand-target-recall'];
    await builder.main();
    expect(lastStderr()).toMatch(/^relgraph evidence readiness: error invalid_evidence_identity /);
  });

  test('a build without target recall writes no status line', async () => {
    process.argv = ['node', 'build-product-relationship-graph', '--skip-need-nodes'];
    await builder.main();
    expect(stderr.mock.calls.some(([chunk]) => String(chunk).startsWith('relgraph evidence readiness:'))).toBe(false);
  });
});
