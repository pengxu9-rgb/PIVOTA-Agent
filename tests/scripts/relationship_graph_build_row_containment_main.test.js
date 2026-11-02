// The build's main(): row failures are contained and reported, attempts are stamped only after the
// writes, and a database failure or a high failure rate still fails the build.
jest.mock('../../src/db', () => {
  const query = jest.fn(async () => ({ rows: [] }));
  return { query, closePool: jest.fn(), withClient: jest.fn(async (fn) => fn({ query })) };
});
jest.mock('../../src/auroraBff/productRelationshipGraphSources', () => ({
  ...jest.requireActual('../../src/auroraBff/productRelationshipGraphSources'),
  loadProductRelationshipGraphSourceInputs: jest.fn(),
}));
const db = require('../../src/db');
const sources = require('../../src/auroraBff/productRelationshipGraphSources');
const builder = require('../../scripts/build-product-relationship-graph');

const product = (id, brand) => ({ product_id: id, product_ref: `product:${id}`, pivota_signature_id: id, title: 'Hydrating Niacinamide Serum',
  name: 'Hydrating Niacinamide Serum', brand, category: 'serum', category_taxonomy: ['skincare', 'serum'], use_case: 'hydrating serum', price: 30,
  price_currency: 'USD', ingredient_text: 'Water, Niacinamide, Hyaluronic Acid, Panthenol, Glycerin' });
const originalArgv = process.argv;
let stdout; let stderr;
beforeEach(() => {
  jest.clearAllMocks();
  process.argv = ['node', 'build-product-relationship-graph', '--skip-need-nodes', '--prioritize-uncovered', '--apply'];
  stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => { process.argv = originalArgv; jest.restoreAllMocks(); db.query.mockImplementation(async () => ({ rows: [] })); });
function catalog(anchors, candidates) {
  const products = [...Array.from({ length: anchors }, (_, i) => product(`sig_a${i}`, `Anchor${i}`)),
    ...Array.from({ length: candidates }, (_, i) => product(`sig_c${i}`, `Cand${i}`))];
  sources.loadProductRelationshipGraphSourceInputs.mockResolvedValue({ products, eligibleAffectedProducts: products.slice(0, anchors) });
}
const statements = () => db.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/).slice(0, 3).join(' '));
const summaryOut = () => JSON.parse(stdout.mock.calls.map(([c]) => String(c)).filter((c) => c.trim().startsWith('{')).at(-1));
function failLabelWrites(error, { onlyFirst = false } = {}) {
  let failedOnce = false;
  db.query.mockImplementation(async (sql) => {
    if (/^\s*INSERT INTO relationship_candidate_labels/.test(sql) && (!onlyFirst || !failedOnce)) { failedOnce = true; throw error; }
    if (/^\s*INSERT INTO relationship_candidate_labels/.test(sql)) return { rows: [{ id: 'x' }] };
    return { rows: [] };
  });
}

test('anchor attempts are stamped after the label writes', async () => {
  catalog(1, 2);
  await builder.main();
  const seq = statements();
  const lastLabel = seq.lastIndexOf('INSERT INTO relationship_candidate_labels');
  const attempts = seq.indexOf('INSERT INTO relationship_graph_anchor_attempts');
  expect(lastLabel).toBeGreaterThan(-1);
  expect(attempts).toBeGreaterThan(lastLabel);
});

test('a database failure while writing fails the build and stamps no attempts', async () => {
  catalog(1, 2);
  failLabelWrites(Object.assign(new Error('connection terminated'), { code: '08006' }));
  await expect(builder.main()).rejects.toMatchObject({ code: '08006' });
  expect(statements()).not.toContain('INSERT INTO relationship_graph_anchor_attempts');
});

test('one row refused for its data: the build carries on, reports it, and stamps the attempts', async () => {
  catalog(1, 2);
  failLabelWrites(Object.assign(new Error('invalid input syntax for type json'), { code: '22P02' }), { onlyFirst: true });
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-contain-')), 'build.json');
  process.argv.push('--out', out);
  await builder.main();
  // The refused row is reported as rejected, not as a stored edge.
  const report = JSON.parse(fs.readFileSync(out, 'utf8'));
  expect(report.rejected_edges.filter((row) => (row.errors || []).includes('write_failed:22P02'))).toHaveLength(1);
  expect(report.summary.edge_count).toBe(report.edges.length);
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  const summary = summaryOut();
  expect(summary).toMatchObject({ write_failed_count: 1, write_failed_by_code: { '22P02': 1 } });
  expect(summary.attempted_write_count).toBeGreaterThanOrEqual(2);
  expect(statements()).toContain('INSERT INTO relationship_graph_anchor_attempts');
  const line = stderr.mock.calls.map(([c]) => String(c)).find((c) => c.includes('RELGRAPH_BUILD_WRITE_FAILED'));
  expect(JSON.parse(line)).toMatchObject({ severity: 'WARNING', write_failed_count: 1 });
});

test('many refused rows (at least 20 and over 5%) still fail the build, after reporting them', async () => {
  catalog(6, 6);
  failLabelWrites(Object.assign(new Error('invalid input syntax for type json'), { code: '22P02' }));
  await expect(builder.main()).rejects.toMatchObject({ code: 'RELGRAPH_BUILD_WRITE_FAILURE_RATE' });
  const summary = summaryOut();
  expect(summary.write_failed_count).toBeGreaterThanOrEqual(20);
  expect(summary.write_failed_count).toBe(summary.attempted_write_count);
  const line = stderr.mock.calls.map(([c]) => String(c)).find((c) => c.includes('RELGRAPH_BUILD_WRITE_FAILED'));
  expect(JSON.parse(line).severity).toBe('ERROR');
});
