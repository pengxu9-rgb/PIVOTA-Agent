'use strict';

// Review findings on the negative review memory (fix/relgraph-producer-loop):
// - the pair fingerprint moved whenever a product row's updated_at moved (source_refs[].observed_at
//   and friends are stamped from it), so cross-night memory almost never hit;
// - a multi-seller signature picked its catalog supplement by row order;
// - a failed memory write failed the review step;
// - a remembered verdict outlived a model / validator change;
// - several guards were only covered by a Postgres-gated test or not at all.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { normalizeExternalProductSeedRow, normalizeCatalogProductRow } = require('../../src/auroraBff/productRelationshipGraphSources');
const { buildEdgeForCandidate } = require('../../src/auroraBff/productRelationshipGraphBuilder');
const { upsertRelationshipCandidateLabel } = require('../../src/auroraBff/productRelationshipGraph');
const {
  REVIEW_VALIDATOR_VERSION,
  buildEvidence,
  buildNegativeReviewMemo,
  fetchSupplementsForRows,
  reviewPairFingerprint,
  runReview,
} = require('../../scripts/review-relationship-candidate-labels');

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-09T10:50:00.000Z');
const MODEL = 'gemini-3-flash-preview';

// ---------------------------------------------------------------------------------------------
// P1-a: the fingerprint through the real builder

function seedRow(id, title, price, updatedAt, { brand = 'Acme', description = 'Hydrating ceramide moisturizer for dry skin barrier repair.' } = {}) {
  return {
    id, external_product_id: id, title, price_amount: price, price_currency: 'USD', availability: 'in_stock', status: 'active',
    domain: 'x.com', canonical_url: `https://x.com/${id}`, updated_at: updatedAt, created_at: '2026-09-01T00:00:00Z',
    seed_data: { title, brand, category: 'Moisturizer', price, currency: 'USD', description, product_type: 'Moisturizer', tags: ['moisturizer', 'ceramide'] },
  };
}

function catalogRow(updatedAt, { title = 'Acme Barrier Cream 50ml' } = {}) {
  return {
    product_key: 'm1:p1', source_product_id: 'p1', pivota_signature_id: 'sig_a', title, brand: 'Acme', category: 'Moisturizer',
    product_type: 'Moisturizer', price: 40, currency: 'USD', description: 'Hydrating ceramide moisturizer for dry skin barrier repair.',
    tags: ['moisturizer', 'ceramide'], updated_at: updatedAt, created_at: '2026-09-01T00:00:00Z',
  };
}

// What the label row looks like after the build upsert and a jsonb round trip.
function builtLabel(anchor, candidate, nowIso) {
  const built = buildEdgeForCandidate({ anchor, candidate, nowIso });
  if (!built.edge) throw new Error(`fixture produced no edge: ${built.errors}`);
  return { id: 'lbl', ...JSON.parse(JSON.stringify(built.edge)), label_state: 'generated' };
}

const fingerprintOf = (row) => reviewPairFingerprint(buildEvidence(row, new Map()));

describe('pair fingerprint through the real builder', () => {
  const seedEdge = ({ nowIso = '2026-10-08T10:40:00Z', anchorUpdated = '2026-10-01T00:00:00Z', candidateUpdated = '2026-10-01T00:00:00Z', candidate = {} } = {}) => builtLabel(
    normalizeExternalProductSeedRow(seedRow('ext_a', 'Acme Barrier Cream 50ml', 40, anchorUpdated)),
    normalizeExternalProductSeedRow(seedRow('ext_c', candidate.title || 'Beta Ceramide Moisturizer 50ml', candidate.price || 20, candidateUpdated, {
      brand: 'Beta', ...(candidate.description ? { description: candidate.description } : {}),
    })),
    nowIso,
  );

  test('fixture: a non-dupe edge whose evidence carries row-derived observed_at stamps', () => {
    const edge = seedEdge();
    expect(edge.relation_type).not.toBe('dupe');
    expect(edge.source_refs[0].observed_at).toBe('2026-10-01T00:00:00.000Z');
    expect(edge.candidate_snapshot.source_refs[0].observed_at).toBe('2026-10-01T00:00:00.000Z');
  });

  test('a seed row whose updated_at moved without a content change keeps its fingerprint', () => {
    const base = fingerprintOf(seedEdge());
    expect(fingerprintOf(seedEdge({ nowIso: '2026-10-09T10:40:00Z' }))).toBe(base);
    expect(fingerprintOf(seedEdge({ nowIso: '2026-10-09T10:40:00Z', candidateUpdated: '2026-10-08T23:00:00Z' }))).toBe(base);
    expect(fingerprintOf(seedEdge({ nowIso: '2026-10-09T10:40:00Z', anchorUpdated: '2026-10-08T22:00:00Z' }))).toBe(base);
  });

  test('a catalog anchor row re-touched by another job keeps its fingerprint', () => {
    const candidate = normalizeExternalProductSeedRow(seedRow('ext_c', 'Beta Ceramide Moisturizer 50ml', 20, '2026-10-01T00:00:00Z', { brand: 'Beta' }));
    const night1 = builtLabel(normalizeCatalogProductRow(catalogRow('2026-10-07T09:00:00Z')), candidate, '2026-10-07T10:40:00Z');
    const night2 = builtLabel(normalizeCatalogProductRow(catalogRow('2026-10-08T09:00:00Z')), candidate, '2026-10-08T10:40:00Z');
    expect(night1.anchor_snapshot.source_refs[0].observed_at).not.toBe(night2.anchor_snapshot.source_refs[0].observed_at);
    expect(fingerprintOf(night2)).toBe(fingerprintOf(night1));
    const retitled = builtLabel(normalizeCatalogProductRow(catalogRow('2026-10-08T09:00:00Z', { title: 'Acme Barrier Cream Rich 50ml' })), candidate, '2026-10-08T10:40:00Z');
    expect(fingerprintOf(retitled)).not.toBe(fingerprintOf(night1));
  });

  test('a real content change still changes it', () => {
    const base = fingerprintOf(seedEdge());
    expect(fingerprintOf(seedEdge({ candidateUpdated: '2026-10-08T23:00:00Z', candidate: { description: 'Lightweight gel moisturizer with niacinamide for oily skin.' } }))).not.toBe(base);
    expect(fingerprintOf(seedEdge({ candidateUpdated: '2026-10-08T23:00:00Z', candidate: { price: 24 } }))).not.toBe(base);
  });

  test('ingredient evidence and intel freshness stamps are bookkeeping too; a dupe keeps its price date', () => {
    const withStamps = (observedAt) => {
      const row = seedEdge();
      row.candidate_snapshot.ingredient_evidence = [{ table: 'external_product_seeds', ingredient_text: 'Water, Glycerin, Ceramide NP', observed_at: observedAt, source_refs: [{ type: 'retailer_page', observed_at: observedAt }] }];
      row.candidate_snapshot.product_intel = { freshness: { generated_at: observedAt, source_version: 'pivota.product_intel.v1' } };
      return row;
    };
    expect(fingerprintOf(withStamps('2026-10-08T00:00:00Z'))).toBe(fingerprintOf(withStamps('2026-10-09T00:00:00Z')));
    // *_until is bookkeeping too: only fresh_until differs here.
    const until = (freshUntil) => {
      const row = seedEdge();
      row.candidate_snapshot.product_intel = { freshness: { fresh_until: freshUntil, source_version: 'pivota.product_intel.v1' } };
      return row;
    };
    expect(fingerprintOf(until('2026-11-08T00:00:00Z'))).toBe(fingerprintOf(until('2026-11-09T00:00:00Z')));
    const dupe = (observedAt) => ({ ...seedEdge(), relation_type: 'dupe', price_evidence: { ...seedEdge().price_evidence, observed_at: observedAt } });
    expect(fingerprintOf(dupe('2026-10-01T00:00:00Z'))).not.toBe(fingerprintOf(dupe('2026-10-08T00:00:00Z')));
  });
});

// ---------------------------------------------------------------------------------------------
// P1-b: deterministic supplements

describe('fetchSupplementsForRows picks the same seller row whatever order Postgres returns', () => {
  const sellerOne = { product_key: 'm1:p1', pivota_signature_id: 'sig_a', title: 'Impress Falsies Lashes - Seller One', brand: 'Impress' };
  const sellerTwo = { product_key: 'm2:p9', pivota_signature_id: 'sig_a', title: 'imPRESS Falsies Press-On Lashes (Seller Two)', brand: 'Impress' };
  const seedOne = { id: 'ext_1', external_product_id: 'shared_ext', title: 'Seed One' };
  const seedTwo = { id: 'ext_2', external_product_id: 'shared_ext', title: 'Seed Two' };
  const queryWith = (catalogRows, seedRows = []) => jest.fn(async (sql) => {
    if (/FROM catalog_products/.test(sql)) return { rows: catalogRows };
    if (/FROM external_product_seeds/.test(sql)) return { rows: seedRows };
    return { rows: [] };
  });
  const supplementTitle = async (ref, catalogRows, seedRows) => {
    const row = { anchor_ref: ref, candidate_product_ref: 'product:other' };
    const supplements = await fetchSupplementsForRows([row], queryWith(catalogRows, seedRows));
    const evidence = buildEvidence({ id: 'x', ...row }, supplements);
    return { catalog: evidence.anchor.catalog && evidence.anchor.catalog.title, seed: evidence.anchor.external_seed && evidence.anchor.external_seed.title };
  };

  test('a signature shared by two sellers resolves to the lowest product_key in either order', async () => {
    expect((await supplementTitle('product:sig_a', [sellerOne, sellerTwo])).catalog).toBe('Impress Falsies Lashes - Seller One');
    expect((await supplementTitle('product:sig_a', [sellerTwo, sellerOne])).catalog).toBe('Impress Falsies Lashes - Seller One');
  });

  test('an exact product_key match beats a signature match', async () => {
    const exact = { product_key: 'sig_a', title: 'Exact Key Row' };
    expect((await supplementTitle('product:sig_a', [sellerOne, exact, sellerTwo])).catalog).toBe('Exact Key Row');
    expect((await supplementTitle('product:sig_a', [exact, sellerTwo, sellerOne])).catalog).toBe('Exact Key Row');
  });

  test('seeds sharing an external_product_id resolve deterministically, exact id first', async () => {
    expect((await supplementTitle('product:shared_ext', [], [seedTwo, seedOne])).seed).toBe('Seed One');
    expect((await supplementTitle('product:shared_ext', [], [seedOne, seedTwo])).seed).toBe('Seed One');
    expect((await supplementTitle('product:ext_2', [], [seedOne, seedTwo])).seed).toBe('Seed Two');
  });

  test('the supplement queries are ordered', async () => {
    const queryFn = queryWith([]);
    await fetchSupplementsForRows([{ anchor_ref: 'product:a', candidate_product_ref: 'product:b' }], queryFn);
    const sqls = queryFn.mock.calls.map(([sql]) => sql);
    expect(sqls.find((sql) => /FROM catalog_products/.test(sql))).toMatch(/ORDER BY product_key/);
    expect(sqls.find((sql) => /FROM external_product_seeds/.test(sql))).toMatch(/ORDER BY id/);
    expect(sqls.find((sql) => /FROM product_beauty_attributes/.test(sql))).toMatch(/ORDER BY product_key/);
  });
});

// ---------------------------------------------------------------------------------------------
// runReview harness

function pairRow(id, overrides = {}) {
  return {
    id, edge_id: id, anchor_type: 'product', anchor_ref: `product:sig_anchor_${id}`,
    anchor_snapshot: { product_id: `sig_anchor_${id}`, brand: 'Impress', title: 'Impress Falsies Long Lasting Pre-Glued False Eyelashes - Demi Edgy', category: 'False Lashes' },
    candidate_product_ref: `product:sig_candidate_${id}`,
    candidate_snapshot: { product_id: `sig_candidate_${id}`, brand: 'Impress', title: 'Impress Lash Glue Remover', category: 'Lash Adhesive' },
    relation_type: 'related_product', display_label: 'related_product', market: 'US', vertical: 'beauty',
    category_taxonomy: ['False Lashes'], use_case: 'False Lashes', label_state: 'generated', score_total: 0.8,
    score_breakdown: {}, price_evidence: {}, source_refs: [], evidence_grade: 'B', why_candidate: { summary: 'Same brand, lash routine.' },
    tradeoffs: [], watchouts: [], provenance: { generated_at: '2026-10-08T10:40:00.000Z' },
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-08T10:40:00.000Z',
    ...overrides,
  };
}
const REJECT = {
  verdict: 'reject', confidence: 0.82, rationale: 'Glue remover is not used alongside pre-glued clusters in this evidence.',
  relationship_kind: 'none', recommendation_reason: '', shared_evidence: [], tradeoffs: [], watchouts: [],
};

function table(rows, { failMemoWrites = false, catalog = [] } = {}) {
  const calls = [];
  const queryFn = jest.fn(async (sql, params) => {
    calls.push({ sql, params });
    if (/^\s*SELECT[\s\S]*FROM relationship_candidate_labels/i.test(sql)) return { rows: JSON.parse(JSON.stringify(rows)) };
    if (/FROM catalog_products/.test(sql)) return { rows: catalog };
    if (/UPDATE relationship_candidate_labels/i.test(sql) && /ai_review_last/.test(sql)) {
      if (failMemoWrites) {
        const err = new Error('Connection terminated unexpectedly');
        err.code = 'ECONNRESET';
        throw err;
      }
      return { rows: [{ id: params[0] }] };
    }
    if (/UPDATE relationship_candidate_labels/i.test(sql)) return { rows: [{ id: params[0], new_label_state: 'needs_evidence' }] };
    return { rows: [] };
  });
  return { calls, queryFn, memoWrites: () => calls.filter(({ sql }) => /UPDATE[\s\S]*ai_review_last/.test(sql)) };
}

const provider = (verdict = REJECT, model = MODEL) => ({ __meta: { provider: 'gemini', model }, analyzeTextToJson: jest.fn(async () => verdict) });

async function applying(fn) {
  const saved = process.env.RELGRAPH_AI_REVIEW_APPLY;
  process.env.RELGRAPH_AI_REVIEW_APPLY = '1';
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    return await fn();
  } finally {
    stdout.mockRestore();
    if (saved === undefined) delete process.env.RELGRAPH_AI_REVIEW_APPLY;
    else process.env.RELGRAPH_AI_REVIEW_APPLY = saved;
  }
}
const review = (t, p, extra = {}) => applying(() => runReview({
  cutoff: '2026-10-01T00:00:00Z', minScore: 0, limit: 10, apply: true, queryFn: t.queryFn, provider: p, clock: () => T0, ...extra,
}));

function rememberedRow(id, memoOverrides = {}, rowOverrides = {}) {
  const row = pairRow(id, rowOverrides);
  const memo = buildNegativeReviewMemo({ ...REJECT }, {
    fingerprint: reviewPairFingerprint(buildEvidence(row, new Map())),
    model: MODEL,
    reviewedAt: new Date(T0 - 2 * DAY_MS).toISOString(),
  });
  return { ...row, provenance: { ...row.provenance, ai_review_last: { ...memo, ...memoOverrides } } };
}

// ---------------------------------------------------------------------------------------------

describe('a failed memory write never fails the review', () => {
  test('the verdict stands, the error is counted, the run completes', async () => {
    const t = table([pairRow('a'), pairRow('b', { score_total: 0.7 })], { failMemoWrites: true });
    const result = await review(t, provider());
    expect(result.decisions.map((d) => d.id)).toEqual(['a', 'b']);
    expect(result.decisions.every((d) => d.verdict === 'reject' && !d.negative_memory_recorded)).toBe(true);
    expect(result.summary).toEqual(expect.objectContaining({
      negative_memory_recorded_count: 0,
      negative_memory_write_errors: 2,
      reviewed_count: 2,
    }));
  });
});

describe('a remembered verdict is only reused by the same model and validator', () => {
  test('memo records the validator version', () => {
    expect(buildNegativeReviewMemo(REJECT, { fingerprint: 'f', model: MODEL, reviewedAt: new Date(T0).toISOString() }))
      .toEqual(expect.objectContaining({ model: MODEL, validator_version: REVIEW_VALIDATOR_VERSION, rubric: 'v4' }));
  });

  test('same model + validator + rubric => skipped; any change => reviewed again', async () => {
    const t = table([
      rememberedRow('same'),
      rememberedRow('othermodel', { model: 'gemini-2.5-pro' }),
      rememberedRow('othervalidator', { validator_version: 'retired' }),
      rememberedRow('nomodelversion', { validator_version: undefined }),
      rememberedRow('otherrubric', { rubric: 'v3' }),
    ]);
    const p = provider();
    const result = await review(t, p);
    expect(result.decisions.map((d) => d.id).sort()).toEqual(['nomodelversion', 'othermodel', 'otherrubric', 'othervalidator']);
    expect(result.summary.negative_memory_skipped_count).toBe(1);
  });

  test('a provider with an unknown model does not reuse a verdict another model gave', async () => {
    const t = table([rememberedRow('same')]);
    const anon = { analyzeTextToJson: jest.fn(async () => REJECT) };
    const result = await review(t, anon);
    expect(result.decisions.map((d) => d.id)).toEqual(['same']);
  });
});

describe('guards the CI suite did not cover', () => {
  test('a verdict stamped in the future (beyond a day) is not trusted', async () => {
    const t = table([rememberedRow('future', { reviewed_at: new Date(T0 + 3 * DAY_MS).toISOString() })]);
    const result = await review(t, provider());
    expect(result.decisions.map((d) => d.id)).toEqual(['future']);
  });

  test('the single-mode prompt carries the catalog supplement', async () => {
    const t = table([pairRow('sup')], { catalog: [{ product_key: 'sig_candidate_sup', title: 'Impress Lash Glue Remover Catalog Title', brand: 'Impress' }] });
    const p = provider();
    await review(t, p);
    expect(p.analyzeTextToJson).toHaveBeenCalledTimes(1);
    expect(p.analyzeTextToJson.mock.calls[0][0].prompt).toContain('Impress Lash Glue Remover Catalog Title');
  });

  test('replayed verdicts never write memory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-replay-'));
    try {
      const verdictsFile = path.join(dir, 'verdicts.json');
      fs.writeFileSync(verdictsFile, JSON.stringify({ decisions: [{ id: 'rep', ...REJECT }] }));
      const t = table([pairRow('rep')]);
      const result = await review(t, null, { verdictsFile });
      expect(result.decisions.map((d) => d.verdict)).toEqual(['reject']);
      expect(t.memoWrites()).toHaveLength(0);
      expect(result.summary.negative_memory_recorded_count).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('consensus mode neither skips on nor writes single-mode memory', async () => {
    const row = rememberedRow('cons', {}, { review_row_version: '2026-10-08 10:40:00.000001+00' });
    const t = table([row]);
    const consensusProviders = [['openai', 'gpt-fixture'], ['gemini', 'gemini-2.5-flash']].map(([name, model]) => ({
      __meta: { provider: name, model }, analyzeTextToJson: jest.fn(async () => REJECT),
    }));
    const result = await review(t, null, { reviewMode: 'consensus', consensusProviders });
    expect(consensusProviders[0].analyzeTextToJson).toHaveBeenCalledTimes(1);
    expect(result.decisions.map((d) => d.id)).toEqual(['cons']);
    expect(result.summary.negative_memory_ttl_days).toBe(0);
    expect(t.memoWrites()).toHaveLength(0);
  });

  test('the build upsert carries ai_review_last over (SQL the CI suite can see)', async () => {
    const queryFn = jest.fn(async () => ({ rows: [{ id: 'x' }] }));
    await upsertRelationshipCandidateLabel({ ...pairRow('ups'), provenance: { generated_at: '2026-10-09T10:40:00.000Z' } }, { queryFn });
    const [sql, params] = queryFn.mock.calls[0];
    const set = sql.slice(sql.indexOf('DO UPDATE SET'), sql.indexOf('WHERE NOT'));
    const provenanceClause = set.slice(set.indexOf('provenance ='), set.indexOf('reviewed_at ='));
    expect(provenanceClause.replace(/\s+/g, ' ')).toContain(
      "WHEN relationship_candidate_labels.provenance ? 'ai_review_last' AND NOT (COALESCE(EXCLUDED.provenance, '{}'::jsonb) ? 'ai_review_last') "
      + "THEN COALESCE(EXCLUDED.provenance, '{}'::jsonb) || jsonb_build_object('ai_review_last', relationship_candidate_labels.provenance -> 'ai_review_last') "
      + 'ELSE EXCLUDED.provenance END',
    );
    expect(set).not.toMatch(/provenance = EXCLUDED\.provenance,/);
    // The build's own provenance is passed through untouched.
    expect(params.map((p) => (typeof p === 'string' && p.includes('generated_at') ? JSON.parse(p) : null)).filter(Boolean))
      .toEqual([{ generated_at: '2026-10-09T10:40:00.000Z' }]);
  });
});
