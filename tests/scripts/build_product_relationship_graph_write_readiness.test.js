// Write-mode readiness (Peng, 2026-09-27): niche_specialist candidates are limited to the products
// a run touches, and the dry-run summary reports the whole-graph fan-in cap.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dbState = { existingRows: [], calls: [] };
jest.mock('../../src/db', () => ({
  query: jest.fn(async (text, params) => {
    dbState.calls.push({ text: String(text).replace(/\s+/g, ' ').trim(), params });
    if (/FROM relationship_candidate_labels/.test(text)) return { rows: dbState.existingRows };
    return { rows: [] };
  }),
  withClient: jest.fn(async (fn) => fn({ query: async () => ({ rows: [] }) })),
  closePool: jest.fn(async () => {}),
}));

const sourceState = { products: [] };
jest.mock('../../src/auroraBff/productRelationshipGraphSources', () => {
  const actual = jest.requireActual('../../src/auroraBff/productRelationshipGraphSources');
  return {
    ...actual,
    loadProductRelationshipGraphSourceInputs: jest.fn(async () => ({
      products: sourceState.products,
      approvedLiveExternalSeedAnchors: [],
      legacyDupes: [],
      intelRows: [],
      source_counts: { products: sourceState.products.length },
    })),
  };
});

const { buildInputsFromDb, main } = require('../../scripts/build-product-relationship-graph');

function product(id, name, overrides = {}) {
  return {
    product_ref: `product:${id}`,
    product_id: id,
    brand: `Brand ${id}`,
    name,
    category: 'serum',
    category_taxonomy: ['skincare', 'serum'],
    tags: ['hyaluronic acid', 'hydrating', 'serum'],
    description: 'Hydrating hyaluronic acid serum for dry skin.',
    price: 20,
    source_refs: [{ type: 'catalog_products', authoritative: true }],
    ...overrides,
  };
}

describe('niche_specialist candidates follow the affected-products scope', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.RELATIONSHIP_GRAPH_CANONICAL_ANCHOR_ENABLED;
    sourceState.products = [
      product('touched', 'Hydrating Hyaluronic Serum'),
      product('untouched_a', 'Hydrating Hyaluronic Acid Serum Plus'),
      product('untouched_b', 'Hyaluronic Hydration Serum Drops'),
    ];
    dbState.existingRows = [];
    dbState.calls = [];
  });
  afterEach(() => { process.env = { ...originalEnv }; });

  function needCandidateRefs(payload) {
    return Array.from(new Set(Object.values(payload.needCandidatesById).flat().map((row) => row.product_ref))).sort();
  }

  test('with affected refs, need candidates come only from the affected products', async () => {
    const payload = await buildInputsFromDb({ limit: 50, affectedRefs: ['touched'], includeNeedNodes: true });

    expect(payload.anchors.map((row) => row.product_ref)).toEqual(['product:touched']);
    expect(needCandidateRefs(payload)).toEqual(['product:touched']);
    expect(payload.sourceDiagnostics.need_candidate_pool).toBe('affected');
    expect(payload.sourceDiagnostics.need_candidate_pool_size).toBe(1);
  });

  test('accepts: a full run with no affected refs keeps the whole pool', async () => {
    const payload = await buildInputsFromDb({ limit: 50, affectedRefs: [], includeNeedNodes: true });

    expect(payload.anchors).toHaveLength(3);
    expect(needCandidateRefs(payload)).toEqual(['product:touched', 'product:untouched_a', 'product:untouched_b']);
    expect(payload.sourceDiagnostics.need_candidate_pool).toBe('all');
    expect(payload.sourceDiagnostics.need_candidate_pool_size).toBe(3);
  });

  test('accepts: --skip-need-nodes still yields no need candidates in either mode', async () => {
    const scoped = await buildInputsFromDb({ limit: 50, affectedRefs: ['touched'], includeNeedNodes: false });
    const full = await buildInputsFromDb({ limit: 50, affectedRefs: [], includeNeedNodes: false });
    expect(scoped.needCandidatesById).toEqual({});
    expect(full.needCandidatesById).toEqual({});
  });
});

describe('dry run reports the whole-graph fan-in cap without writing', () => {
  const originalArgv = process.argv;
  afterEach(() => { process.argv = originalArgv; dbState.existingRows = []; dbState.calls = []; });

  test('existing stored anchors reduce what this build may add; nothing is upserted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-global-'));
    const anchorIds = ['a1', 'a2', 'a3', 'a4'];
    const input = {
      anchors: anchorIds.map((id) => ({ product_id: id, brand: `Brand ${id}`, name: `${id} Moisture Cream`, category: 'cream', category_taxonomy: ['skincare', 'cream'], price: 60 })),
      candidatesByAnchor: Object.fromEntries(anchorIds.map((id, i) => [`product:${id}`, [{
        product_id: 'hub', brand: 'ALBION', name: 'Excia Replant Whitening Cream', category: 'cream', category_taxonomy: ['skincare', 'cream'], price: 90,
        category_use_case_match: 0.9, ingredient_functional_similarity: 0.8, similarity_score: 0.84 + i * 0.02,
        price_observed_at: '2026-09-27T00:00:00.000Z', source_refs: [{ type: 'catalog_products', authoritative: true }], evidence_grade: 'B',
      }]])),
    };
    fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify(input));
    // 6 anchors already stored for the hub -> only 2 of this build's 4 may be added.
    dbState.existingRows = Array.from({ length: 6 }, (_, i) => ({ candidate_ref: 'product:hub', anchor_ref: `product:stored${i}` }));
    process.argv = ['node', 'build', '--input', path.join(dir, 'input.json'), '--skip-need-nodes', '--review-status', 'pending', '--max-anchors-per-candidate', '8', '--out', path.join(dir, 'out.json')];

    await main();

    const report = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
    expect(report.summary.dry_run).toBe(true);
    expect(report.summary.applied_count).toBe(0);
    expect(report.summary.max_anchors_per_candidate_global).toBe(8);
    expect(report.summary.fan_in_max_existing_anchors_global).toBe(6);
    expect(report.summary.fan_in_max_before_cap_global).toBe(10);
    expect(report.summary.fan_in_capped_count_global).toBe(2);
    expect(report.summary.edge_count).toBe(2);
    expect(report.edges.map((e) => e.anchor_ref).sort()).toEqual(['product:a3', 'product:a4']);
    expect(report.rejected_edges.filter((row) => row.errors.includes('candidate_fan_in_cap_global'))).toHaveLength(2);
    expect(dbState.calls.filter((c) => /INSERT INTO/.test(c.text))).toHaveLength(0);
    expect(dbState.calls.filter((c) => /FROM relationship_candidate_labels/.test(c.text))).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
