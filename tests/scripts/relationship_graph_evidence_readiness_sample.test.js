jest.mock('../../src/db', () => ({ query: jest.fn(), closePool: jest.fn(), withClient: jest.fn() }));
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
const { buildInputsFromDb, __internal: { sampleEvidenceReadiness } } = require('../../scripts/build-product-relationship-graph');

// The build's evidence-readiness block is a planning-only diagnostic sample. On 2026-10-15 the
// nightly relgraph-sync failed twice with evidence_unique_products_exceed_bound: the sample was
// deduped by listing identity (product_key/signature) but readiness counts exact identities
// (also market, merchant, platform, variant), so aliased candidates in the sampled pairs pushed
// the unique count past 500 and the diagnostic aborted the build.
const anchor = (i) => ({ product_ref: `product:sig_a${i}`, product_key: `a${i}`, pivota_signature_id: `sig_a${i}`,
  name: `Serum ${i}`, brand: `Brand ${i % 9}`, category: 'Serum', market: 'US', price: 18, price_currency: 'USD' });
// Listing c<j> under anchor i, carrying an anchor-specific variant title: one listing, two aliases.
const candidate = (j, i) => ({ product_ref: `product:sig_c${j}`, product_key: `c${j}`, pivota_signature_id: `sig_c${j}`,
  name: `Serum c${j}`, brand: `Other ${j % 7}`, category: 'Serum', market: 'US', price: 20, price_currency: 'USD',
  variant_title: `${i % 2 ? 'mini' : 'full'} ${j}`, score_total: 0.5 });

function aliasedFixture({ aliases = true } = {}) {
  const anchors = Array.from({ length: 100 }, (_, i) => anchor(i));
  // 100 anchors x 8 candidates over 400 listings: each listing under two anchors.
  const candidatesByAnchor = Object.fromEntries(anchors.map((a, i) => [a.product_ref,
    Array.from({ length: 8 }, (_, k) => { const j = (i * 4 + k) % 400; return candidate(j, aliases ? i : 0); })]));
  return { anchors, candidatesByAnchor };
}

beforeEach(() => {
  jest.clearAllMocks();
  sources.enrichProductRelationshipGraphProducts.mockImplementation(async ({ products }) => ({
    products, ingredientRows: [], intelRows: [], diagnostics: {} }));
  recall.loadProductRelationshipGraphTargetRecall.mockResolvedValue({ products: [], candidatesByAnchor: {},
    diagnostics: { caps: { maxCandidates: 5000 } } });
});

function arrange(fixture) {
  sources.loadProductRelationshipGraphSourceInputs.mockResolvedValue({ products: fixture.anchors, intelRows: [] });
  sources.buildCandidatesByAnchorFromSources.mockImplementation(() => fixture.candidatesByAnchor);
}

test('aliased candidates past 500 exact identities no longer fail the build (2026-10-15 nightly)', async () => {
  const fixture = aliasedFixture();
  arrange(fixture);
  const payload = await buildInputsFromDb({ limit: 100, includeNeedNodes: false, expandTargetRecall: true });
  const evidence = payload.sourceDiagnostics.evidence_readiness;
  expect(evidence.error).toBeUndefined();
  expect(evidence.unique_exact_listings).toBeLessThanOrEqual(500);
  expect(evidence.diagnostic_sample).toBe(true);
  // The diagnostic never touches the graph inputs.
  expect(payload.candidatesByAnchor).toBe(fixture.candidatesByAnchor);
  expect(payload.anchors).toHaveLength(100);
});

test('the sample bound is counted in the exact identities readiness counts', () => {
  const { anchors, candidatesByAnchor } = aliasedFixture();
  const sample = sampleEvidenceReadiness({ anchors, candidatesByAnchor });
  expect(sample.error).toBeUndefined();
  const keys = new Set([...sample.products, ...sample.pairs.flatMap((pair) => [pair.anchor, pair.candidate])]
    .map((product) => readiness.exactIdentity(product).exact_key).filter(Boolean));
  expect(keys.size).toBeLessThanOrEqual(500);
  expect(sample.products.length).toBeLessThanOrEqual(500);
  expect(sample.pairs.length).toBeGreaterThan(0);
  expect(sample.pairs.length).toBeLessThanOrEqual(1000);
});

test('a diagnostic failure is recorded, never thrown', async () => {
  const fixture = aliasedFixture({ aliases: false });
  arrange(fixture);
  const spy = jest.spyOn(readiness, 'summarizeRelationshipEvidenceReadiness').mockImplementation(() => { throw new Error('invalid_evidence_identity'); });
  try {
    const payload = await buildInputsFromDb({ limit: 100, includeNeedNodes: false, expandTargetRecall: true });
    expect(payload.sourceDiagnostics.evidence_readiness).toMatchObject({ diagnostic_sample: true, error: 'invalid_evidence_identity' });
    expect(payload.candidatesByAnchor).toBe(fixture.candidatesByAnchor);
  } finally {
    spy.mockRestore();
  }
});

test('a malformed identity inside the sample is recorded, never thrown', async () => {
  const fixture = aliasedFixture({ aliases: false });
  // exactIdentity rejects control characters: the sampler itself must not abort the build.
  fixture.candidatesByAnchor[fixture.anchors[0].product_ref][0] = { ...candidate(0, 0), product_key: 'bad\u0001key' };
  arrange(fixture);
  const payload = await buildInputsFromDb({ limit: 100, includeNeedNodes: false, expandTargetRecall: true });
  expect(payload.sourceDiagnostics.evidence_readiness).toMatchObject({ diagnostic_sample: true, error: 'invalid_evidence_identity' });
  expect(payload.candidatesByAnchor).toBe(fixture.candidatesByAnchor);
});

// The pre-fix sampler (listing identity), kept verbatim as the reference for unaliased inputs.
function legacySample(anchors, candidatesByAnchor, listingIdentity, interleave) {
  const diagnosticAnchors = anchors.slice(0, 100);
  const diagnosticProducts = new Map();
  for (const product of [...diagnosticAnchors, ...interleave(diagnosticAnchors, [candidatesByAnchor])]) {
    const key = listingIdentity(product);
    if (!diagnosticProducts.has(key) && diagnosticProducts.size < 500) diagnosticProducts.set(key, product);
  }
  const diagnosticPairs = diagnosticAnchors.flatMap((a) => (candidatesByAnchor[a.product_ref] || [])
    .filter((c) => diagnosticProducts.has(listingIdentity(c)))
    .map((c) => ({ anchor: a, candidate: c, score: c.score_total }))).slice(0, 1000);
  return { products: [...diagnosticProducts.values()], pairs: diagnosticPairs };
}

test('an input the old sampler accepted yields a byte-identical evidence_readiness', async () => {
  const fixture = aliasedFixture({ aliases: false }); // one exact identity per listing
  arrange(fixture);
  const payload = await buildInputsFromDb({ limit: 100, includeNeedNodes: false, expandTargetRecall: true });
  const listingIdentity = (product) => (product.product_key ? `product_key:${product.product_key}` : `pivota_signature_id:${product.pivota_signature_id}`);
  const legacy = legacySample(fixture.anchors, fixture.candidatesByAnchor, listingIdentity, sources.interleaveCandidateHydrationTargets);
  const { evidence_readiness: evidence } = payload.sourceDiagnostics;
  const { diagnostic_sample: _d, requested_anchor_count: _r, sampled_anchor_count: _s, requested_candidate_memberships: _m,
    sampled_pair_count: sampledPairs, product_limit: _p, pair_limit: _l, selection_complete: _c, ...summary } = evidence;
  const expected = readiness.summarizeRelationshipEvidenceReadiness({ products: legacy.products, pairs: legacy.pairs });
  expect(JSON.stringify(summary)).toBe(JSON.stringify(expected));
  expect(summary.unique_exact_listings).toBeGreaterThan(400);
  expect(sampledPairs).toBe(legacy.pairs.length);
});
