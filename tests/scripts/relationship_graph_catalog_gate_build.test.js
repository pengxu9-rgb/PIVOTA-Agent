// The source pool passes the catalog serving gate inside loadProductRelationshipGraphSourceInputs.
// Legacy explicit dupes (aurora_dupe_kb), target recall and transitive hops reach the candidates
// without passing through that pool, so the build gates its final candidates once more.
const mockGateFailures = new Set();
jest.mock('../../src/db', () => ({
  query: jest.fn(async (sql, params) => {
    const { CATALOG_GATE_FAILURES_SQL } = jest.requireActual('../../src/auroraBff/relationshipCatalogServingGate');
    if (sql !== CATALOG_GATE_FAILURES_SQL) throw new Error('unexpected database access');
    return { rows: JSON.parse(params[0]).filter((s) => s.keys.some((key) => mockGateFailures.has(key)))
      .map((s) => ({ subject_id: s.subject_id, reason: 'catalog_suppressed' })) };
  }),
  closePool: jest.fn(), withClient: jest.fn(),
}));
jest.mock('../../src/auroraBff/productRelationshipGraphSources', () => {
  const actual = jest.requireActual('../../src/auroraBff/productRelationshipGraphSources');
  return { ...actual, loadProductRelationshipGraphSourceInputs: jest.fn(),
    enrichProductRelationshipGraphProducts: jest.fn(async ({ products }) => ({
      products: actual.enrichProductsWithEvidence(products), ingredientRows: [], intelRows: [], diagnostics: {},
    })) };
});

const sources = require('../../src/auroraBff/productRelationshipGraphSources');
const { buildInputsFromDb } = require('../../scripts/build-product-relationship-graph');

const NOW = '2026-10-21T00:00:00.000Z';
function listing(key, brand, price = 50) {
  return { product_ref: `product:sig_${key}`, product_id: `source_${key}`, source_product_id: `source_${key}`,
    pivota_signature_id: `sig_${key}`, product_key: `cp_${key}`, merchant_id: 'real_seller', platform: 'shopify',
    name: 'Daily Barrier Face Serum', brand, category: 'serum', category_taxonomy: ['skincare', 'serum'],
    description: 'Hydrating facial serum supports the skin barrier with a lightweight gel texture.',
    price, price_currency: 'USD', observed_at: NOW, evidence_grade: 'B', _source_type: 'products_cache',
    source_refs: [{ type: 'products_cache', authoritative: true, url: `https://synthetic.example/${key}` }] };
}
const anchor = listing('a', 'Aster');
const dupe = listing('dupe', 'Cedar', 20);
const legacyDupes = [{ kb_key: anchor.product_ref, original: anchor, verified: true, verified_at: NOW,
  dupes: [{ ...dupe, evidence_grade: 'A', source_refs: [{ type: 'aurora_dupe_kb', authoritative: true }] }], comparables: [] }];
const build = () => buildInputsFromDb({ limit: 1, includeNeedNodes: false, includeTransitiveRecall: false });
const candidateRefs = (payload) => (payload.candidatesByAnchor[anchor.product_ref] || []).map((row) => row.product_ref);

beforeEach(() => {
  jest.clearAllMocks();
  mockGateFailures.clear();
  sources.loadProductRelationshipGraphSourceInputs.mockResolvedValue({ products: [anchor], legacyDupes, intelRows: [] });
});

test('a legacy dupe that passes the gate stays a candidate', async () => {
  const payload = await build();
  expect(candidateRefs(payload)).toEqual([dupe.product_ref]);
  expect(payload.sourceDiagnostics.candidate_catalog_serving_gate).toEqual({ dropped: 0, dropped_by_reason: {} });
});

test('a legacy dupe whose catalog row is suppressed never becomes a candidate', async () => {
  mockGateFailures.add('sig_dupe');
  const payload = await build();
  expect(candidateRefs(payload)).toEqual([]);
  expect(payload.sourceDiagnostics.candidate_catalog_serving_gate).toEqual({ dropped: 1, dropped_by_reason: { catalog_suppressed: 1 } });
});
