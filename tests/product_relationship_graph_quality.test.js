// Relationship-graph quality rules measured on the 2026-09-26 JP/AU dry run (2,677 anchors,
// 33,881 edges, gateway 91ecb2fe8):
//   - score saturation: 94.8% of edges >= 0.8, provenance constants not pair evidence;
//   - hub effect: one candidate (ALBION Excia Replant Whitening Cream) was the alternative for most
//     cream anchors in its shard; nothing capped a candidate's fan-in;
//   - wrong-form alternatives: lip gloss -> lip balm, hand cream -> hair oil;
//   - unsupported claims: the only failing audit gate, 27 edges quoting merchant social proof
//     ("The viral product you've been waiting for!", "A viral bestseller").
// Each rule is paired with the cases it must still accept.
const {
  buildProductRelationshipGraphDryRun,
  buildEdgeForCandidate,
  buildNicheSpecialistEdge,
  capCandidateFanIn,
  DEFAULT_MAX_ANCHORS_PER_CANDIDATE,
  __internal: { leafCategoryCompatibility, snapshotLeafProfile, inferRelationship },
} = require('../src/auroraBff/productRelationshipGraphBuilder');
const {
  normalizeProductCandidateSnapshot,
  __internal: { scoreCandidateForAnchor, buildTransitiveRecallCandidate },
} = require('../src/auroraBff/productRelationshipGraphSources');
const { DUPE_MIN_SCORE_TOTAL, validateRelationshipEdge } = require('../src/auroraBff/productRelationshipGraph');
const claimPhrases = require('../src/auroraBff/relationshipClaimPhrases');
const audit = require('../scripts/audit-product-relationship-graph');

const NOW = '2026-09-26T00:00:00.000Z';

function anchor(id, overrides = {}) {
  return {
    product_id: id,
    brand: `Brand ${id}`,
    name: `${id} Moisture Cream`,
    category: 'cream',
    category_taxonomy: ['skincare', 'cream'],
    price: 60,
    ...overrides,
  };
}

function candidate(id, overrides = {}) {
  return {
    product_id: id,
    brand: 'ALBION',
    name: 'Excia Replant Whitening Cream',
    category: 'cream',
    category_taxonomy: ['skincare', 'cream'],
    price: 90,
    category_use_case_match: 0.9,
    ingredient_functional_similarity: 0.8,
    similarity_score: 0.86,
    price_observed_at: NOW,
    source_refs: [{ type: 'catalog_products', authoritative: true }],
    evidence_grade: 'B',
    ...overrides,
  };
}

function build(anchors, candidatesByAnchor, options = {}) {
  return buildProductRelationshipGraphDryRun({
    anchors,
    candidatesByAnchor,
    needs: [],
    now: new Date(NOW),
    limit: 500,
    ...options,
  });
}

function snap(overrides = {}) {
  const { source_refs, ...rest } = overrides;
  return normalizeProductCandidateSnapshot(
    { product_ref: `product:${String(rest.name).replace(/\W+/g, '_')}`, ...rest, ...(source_refs ? { source_refs } : {}) },
    { sourceType: source_refs ? undefined : 'catalog_products' },
  );
}

// ---------------------------------------------------------------------------------------------
describe('per-candidate fan-in cap (per build) for dupe / competitive_alternative', () => {
  const anchorIds = Array.from({ length: 12 }, (_, i) => `anchor_${String(i).padStart(2, '0')}`);
  const anchors = anchorIds.map((id) => anchor(id));
  const hubScore = (i) => 0.84 + (i % 6) * 0.02;
  const candidatesByAnchor = Object.fromEntries(
    anchorIds.map((id, i) => [`product:${id}`, [
      candidate('hub', { similarity_score: hubScore(i) }),
      candidate(`sibling_${id}`, { brand: `Brand ${id}`, name: `${id} Moisture Cream Refill` }),
    ]]),
  );

  test('a candidate serves at most the cap, keeping its best-scoring anchors', () => {
    const out = build(anchors, candidatesByAnchor, { maxAnchorsPerCandidate: 4 });
    const hubEdges = out.edges.filter((edge) => edge.candidate_product_ref === 'product:hub');

    expect(hubEdges).toHaveLength(4);
    expect(hubEdges.every((edge) => edge.relation_type === 'competitive_alternative')).toBe(true);
    expect(hubEdges.map((edge) => edge.anchor_ref).sort()).toEqual([
      'product:anchor_04', 'product:anchor_05', 'product:anchor_10', 'product:anchor_11',
    ]);
    const capped = out.rejected_edges.filter((row) => row.errors.includes('candidate_fan_in_cap_per_build'));
    expect(capped).toHaveLength(8);
    expect(out.summary.fan_in_capped_count_per_build).toBe(8);
    expect(out.summary.max_fan_in_before_cap_per_build).toBe(12);
    expect(out.summary.max_anchors_per_candidate_per_build).toBe(4);
  });

  test('accepts: related_product fan-in is never capped', () => {
    const sameBrand = Object.fromEntries(
      anchorIds.map((id) => [`product:${id}`, [candidate('house_sibling', { brand: `Brand ${id}` })]]),
    );
    const out = build(anchors, sameBrand, { maxAnchorsPerCandidate: 2 });

    expect(out.edges.filter((edge) => edge.relation_type === 'related_product')).toHaveLength(12);
    expect(out.summary.fan_in_capped_count_per_build).toBe(0);
  });

  test('ties break on anchor_ref, so the kept set is the same for any input order', () => {
    const tied = Object.fromEntries(anchorIds.map((id) => [`product:${id}`, [candidate('hub')]]));
    const forward = build(anchors, tied, { maxAnchorsPerCandidate: 3 });
    const reversed = build([...anchors].reverse(), tied, { maxAnchorsPerCandidate: 3 });

    const kept = (out) => out.edges.map((edge) => edge.anchor_ref).sort();
    expect(kept(forward)).toEqual(['product:anchor_00', 'product:anchor_01', 'product:anchor_02']);
    expect(kept(reversed)).toEqual(kept(forward));
  });

  test('the default cap applies without an explicit option', () => {
    const out = build(anchors, candidatesByAnchor);
    const hubEdges = out.edges.filter((edge) => edge.candidate_product_ref === 'product:hub');

    expect(DEFAULT_MAX_ANCHORS_PER_CANDIDATE).toBeLessThan(anchorIds.length);
    expect(hubEdges).toHaveLength(DEFAULT_MAX_ANCHORS_PER_CANDIDATE);
    expect(out.summary.fan_in_capped_count_per_build).toBe(anchorIds.length - DEFAULT_MAX_ANCHORS_PER_CANDIDATE);
  });

  test('capCandidateFanIn counts dupe and competitive_alternative against one budget', () => {
    const edges = [
      { anchor_ref: 'product:a1', candidate_product_ref: 'product:x', relation_type: 'dupe', score_total: 0.9 },
      { anchor_ref: 'product:a2', candidate_product_ref: 'product:x', relation_type: 'competitive_alternative', score_total: 0.85 },
      { anchor_ref: 'product:a3', candidate_product_ref: 'product:X', relation_type: 'competitive_alternative', score_total: 0.8 },
      { anchor_ref: 'product:a4', candidate_product_ref: 'product:x', relation_type: 'niche_specialist', score_total: 0.7 },
    ];
    const out = capCandidateFanIn(edges, { maxAnchorsPerCandidate: 2 });

    expect(out.kept.map((edge) => edge.anchor_ref)).toEqual(['product:a1', 'product:a2', 'product:a4']);
    expect(out.dropped).toEqual([
      expect.objectContaining({ anchor_ref: 'product:a3', errors: ['candidate_fan_in_cap_per_build'] }),
    ]);
    expect(out.max_fan_in_before_cap).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
describe('social-proof copy is stripped, phrase by phrase, from the snapshot text an edge stores', () => {
  const VIRAL = "The viral product you've been waiting for! Introducing Neo Blurring Powder for the ultimate natural finish.";

  function edgeFor(candidateOverrides = {}, anchorOverrides = {}) {
    const built = buildEdgeForCandidate({
      anchor: anchor('a1', anchorOverrides),
      candidate: candidate('c1', candidateOverrides),
      nowIso: NOW,
    });
    expect(built.errors).toEqual([]);
    return built.edge;
  }

  test('the builder and the audit share one detector and one field list', () => {
    expect(audit.SOCIAL_CLAIM_PATTERN).toBe(claimPhrases.SOCIAL_CLAIM_PATTERN);
    expect(audit.claimTextFragments({
      candidate_snapshot: Object.fromEntries(claimPhrases.CANDIDATE_CLAIM_FIELDS.map((f) => [f, `${f} text`])),
      anchor_snapshot: Object.fromEntries(claimPhrases.ANCHOR_CLAIM_FIELDS.map((f) => [f, `${f} text`])),
    }).map((fragment) => fragment.path).sort()).toEqual([
      ...claimPhrases.CANDIDATE_CLAIM_FIELDS.map((f) => `candidate_snapshot.${f}`),
      ...claimPhrases.ANCHOR_CLAIM_FIELDS.map((f) => `anchor_snapshot.${f}`),
    ].sort());
  });

  test('the phrase is cut out and the sentence keeps its product words; the audit then passes', () => {
    const edge = edgeFor({ description: VIRAL });

    expect(edge.candidate_snapshot.description).toBe("The product you've been waiting for! Introducing Neo Blurring Powder for the ultimate natural finish.");
    expect(audit.auditUnsupportedClaims(edge, 0)).toEqual([]);
  });

  test('copy that is nothing but social proof is removed rather than stored empty', () => {
    const edge = edgeFor({ description: 'A viral bestseller', short_description: 'Award-winning. #1 in Japan.' });

    expect(edge.candidate_snapshot).not.toHaveProperty('description');
    expect(edge.candidate_snapshot).not.toHaveProperty('short_description');
    expect(audit.auditUnsupportedClaims(edge, 0)).toEqual([]);
  });

  test('anchor copy, why_candidate, tradeoffs and need-node edges are neutralised too', () => {
    const edge = edgeFor(
      {
        why_candidate: { summary: 'Trending on TikTok right now. Same peptide complex at half the price.', reasons_user_visible: ['Cult favourite', 'Cheaper'] },
        tradeoffs: ['Smaller size', 'Best seller'],
      },
      { description: 'Our best-selling cream. Rich texture for dry skin.' },
    );
    expect(edge.anchor_snapshot.description).toBe('Rich texture for dry skin.');
    expect(edge.why_candidate.summary).toBe('Same peptide complex at half the price.');
    expect(edge.why_candidate.reasons_user_visible).toEqual(['Cheaper']);
    expect(edge.tradeoffs).toEqual(['Smaller size']);
    expect(audit.auditUnsupportedClaims(edge, 0)).toEqual([]);

    const niche = buildNicheSpecialistEdge({
      need: { need_id: 'need:budget-peptide-serum', label: 'budget peptide serum', category_taxonomy: ['skincare', 'serum'] },
      candidate: candidate('n1', { name: 'Peptide Serum Drops', category: 'serum', description: `Peptide serum. ${VIRAL}`, score_total: 0.9 }),
      nowIso: NOW,
    });
    expect(niche.errors).toEqual([]);
    expect(niche.edge.candidate_snapshot.description).toBe("Peptide serum. The product you've been waiting for! Introducing Neo Blurring Powder for the ultimate natural finish.");
  });

  test('every phrase the audit gate flags, and every popularity claim, is stripped by the builder', () => {
    const phrases = [
      'A viral bestseller',
      'Best seller in Australia',
      'Our #1 serum',
      'The No. 1 cushion in Japan',
      'Award-winning formula',
      'As seen on TikTok',
      'Influencer favourite',
      'Cult classic',
      'Hyped on Instagram',
    ];
    const anyClaim = new RegExp([claimPhrases.SOCIAL_CLAIM_PATTERN.source, claimPhrases.POPULARITY_CLAIM_PATTERN.source, claimPhrases.ORDINAL_CLAIM_PATTERN.source].join('|'), 'i');
    for (const phrase of phrases) {
      expect(anyClaim.test(phrase)).toBe(true);
      const edge = edgeFor({ description: `${phrase}. Formulated with niacinamide.` });
      expect(edge.candidate_snapshot.description).not.toMatch(anyClaim);
      expect(edge.candidate_snapshot.description).toMatch(/Formulated with niacinamide\.$/);
      expect(audit.auditUnsupportedClaims(edge, 0)).toEqual([]);
    }
  });

  test('accepts: product-name and ordinary contexts are stored unchanged', () => {
    const kept = [
      { brand: 'Chanel', description: 'Chanel No. 1 de Chanel revitalizing serum with red camellia.' },
      { brand: 'Nars', description: 'Nars #1 shade of the season in a satin finish.' },
      { description: 'Insta-Glow Serum brightens in seconds.' },
      { description: 'Made by creator labs in Seoul with 2% niacinamide.' },
      { description: 'Trending shade for autumn with a soft matte finish.' },
      { description: 'Top-rated by dermatologists for sensitive skin.' },
      { description: 'Contains 1% niacinamide and 3 ceramides. Use 1-2 pumps morning and night.' },
    ];
    for (const overrides of kept) {
      const edge = edgeFor(overrides);
      expect(edge.candidate_snapshot.description).toBe(overrides.description);
      expect(audit.auditUnsupportedClaims(edge, 0)).toEqual([]);
    }
  });

  test('Japanese copy splits on 。 without whitespace and keeps its other sentences', () => {
    const edge = edgeFor({ description: '浸透型ヒアルロン酸配合。TikTokで話題のバイラル商品。しっとり保湿する化粧水です。' });
    expect(edge.candidate_snapshot.description).toBe('浸透型ヒアルロン酸配合。 しっとり保湿する化粧水です。');
  });

  test('accepts: social proof a social source_ref supports is kept, and the audit accepts it', () => {
    const edge = edgeFor({
      description: 'Trending on Instagram this month. Lightweight gel texture.',
      source_refs: [{ type: 'social_review', name: 'Instagram creator source' }],
    });
    expect(edge.candidate_snapshot.description).toBe('Trending on Instagram this month. Lightweight gel texture.');
    expect(audit.hasSupportingSocialSource(edge)).toBe(true);
    expect(audit.auditUnsupportedClaims(edge, 0)).toEqual([]);
  });

  test('why_candidate.summary never ends up empty', () => {
    const edge = edgeFor({ why_candidate: { summary: 'A viral bestseller', reasons_user_visible: ['Cheaper'] } });
    expect(edge.why_candidate.summary).toBe('Cross-brand alternative with matching category and use-case signals.');
    expect(edge.why_candidate.reasons_user_visible).toEqual(['Cheaper']);

    const niche = buildNicheSpecialistEdge({
      need: { need_id: 'need:budget-peptide-serum', label: 'budget peptide serum', category_taxonomy: ['skincare', 'serum'] },
      candidate: candidate('n2', { name: 'Peptide Serum Drops', category: 'serum', score_total: 0.9, why_candidate: { summary: 'Viral hit' } }),
      nowIso: NOW,
    });
    expect(niche.edge.why_candidate.summary).toBe('Specialist candidate for budget peptide serum.');
  });

  test('the audit gate is not wider than before: a stored edge with "best-selling" still passes, and the gate ignores name compounds', () => {
    const stored = { candidate_snapshot: { description: 'Our best-selling, award-winning #1 cream.' }, source_refs: [{ type: 'catalog_products' }] };
    expect(audit.auditUnsupportedClaims(stored, 0)).toEqual([]);
    for (const text of ['Insta-Glow Serum', 'creator labs', 'Trending shade']) {
      expect(audit.auditUnsupportedClaims({ candidate_snapshot: { description: text } }, 0)).toEqual([]);
    }
    for (const text of ['viral hit', 'as raved about on TikTok', 'trending on Instagram', 'content creator pick', 'Insta famous']) {
      expect(audit.auditUnsupportedClaims({ candidate_snapshot: { description: text } }, 0)).not.toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Score spread. 2026-09-26 shard-0 dry run (gateway cecd89171): 764 of 1,184 competitive
// alternatives scored exactly 0.93 and 371 exactly 0.80 — the exact-category floor (0.72) plus
// provenance constants (product-intel +0.05 +0.05 +0.11, external seed +0.08). Name, INCI and
// description agreement changed nothing, and an identical tag list pushed the builder to 1.0.
// ---------------------------------------------------------------------------------------------
describe('score spread: pair evidence, not provenance, moves the score', () => {
  const creamAnchor = snap({
    brand: 'Twany', name: 'Twany Century The Cream SP', category: 'cream', tags: ['cream'], price: 120,
    description: 'Rich anti-ageing face cream with peptides and ceramides for dry skin.',
    inci_list: 'water glycerin ceramide np peptide squalane',
  });
  const scoreOf = (candidate, options) => scoreCandidateForAnchor(creamAnchor, candidate, options).score_total;

  test('a product-intel row or a stronger source does not lift a shelf-only pair off the floor', () => {
    const plain = scoreOf(snap({ brand: 'X', name: 'Gamma Delta', category: 'cream', tags: ['cream'], price: 40 }));
    const seed = scoreOf(snap({ brand: 'X', name: 'Gamma Delta', category: 'cream', tags: ['cream'], price: 40, source_refs: [{ type: 'external_product_seed', authoritative: true }] }));
    const intel = scoreOf(
      snap({ brand: 'X', name: 'Gamma Delta', category: 'cream', tags: ['cream'], price: 40, source_refs: [{ type: 'catalog_products' }, { type: 'product_intel_kb' }] }),
      { intelMatch: true },
    );

    expect(plain).toBeCloseTo(0.72, 2);
    expect(seed).toBe(plain);
    expect(intel).toBe(plain);
  });

  test('same-shelf candidates rank by how alike they are named and formulated', () => {
    const shelfOnly = scoreOf(snap({ brand: 'X', name: 'Gamma Delta', category: 'cream', tags: ['cream'], price: 40 }));
    const sameForm = scoreOf(snap({ brand: 'Ayura', name: 'Ayura Moist Barrier Cream', category: 'cream', tags: ['cream'], price: 50 }));
    const sameFormAndInci = scoreOf(snap({ brand: 'POLA', name: 'Pola Wrinkle Shot Night Cream', category: 'cream', tags: ['cream'], price: 90, inci_list: 'water glycerin ceramide np squalane niacinamide' }));
    const alike = scoreOf(snap({
      brand: 'Est', name: 'Est The Cream TR Peptide Ceramide', category: 'cream', tags: ['cream', 'ceramide'], price: 100,
      description: 'Rich anti-ageing face cream with peptides and ceramides for dry skin.',
      inci_list: 'water glycerin ceramide np peptide squalane',
    }));

    expect(shelfOnly).toBeLessThan(sameForm);
    expect(sameForm).toBeLessThan(sameFormAndInci);
    expect(sameFormAndInci).toBeLessThan(alike);
    expect(alike).toBeGreaterThanOrEqual(0.9);
    expect(alike).toBeLessThan(1);
  });

  test('accepts: curated dupe evidence still lifts the pair above the dupe threshold', () => {
    const curated = scoreOf(snap({ brand: 'Value', name: 'Value Cream', category: 'cream', tags: ['cream'], price: 20 }), { legacyMatch: true });
    expect(curated).toBeGreaterThan(DUPE_MIN_SCORE_TOTAL);
  });

  test('an identical retailer tag list is not a 1.0 edge, and the builder takes the sources score as-is', () => {
    const anchorRow = { product_id: 'a', brand: 'Twany', name: 'Twany Century The Cream SP', category: 'cream', tags: ['cream', 'skincare', 'japan', 'new'], price: 120 };
    const cand = snap({ brand: 'X', name: 'Gamma Delta', category: 'cream', tags: ['cream', 'skincare', 'japan', 'new'], price: 40 });
    const score = scoreCandidateForAnchor(snap(anchorRow), cand);
    expect(score.score_total).toBeLessThan(0.8);

    const inferred = inferRelationship(
      { brand: 'Twany', name: anchorRow.name, category: 'cream', price: 120 },
      { brand: 'X', name: 'Gamma Delta', category: 'cream', price: 40 },
      { ...cand, ...score, similarity_score: score.score_total, score_breakdown: score },
    );
    expect(inferred.scoreTotal).toBe(score.score_total);
  });

  test('accepts: a candidate without a sources score still falls back to its components', () => {
    const inferred = inferRelationship(
      { brand: 'A', name: 'Barrier Serum', category: 'serum', price: 50 },
      { brand: 'B', name: 'Barrier Serum Alternative', category: 'serum', price: 40 },
      { category_use_case_match: 0.9, ingredient_functional_similarity: 0.84 },
    );
    expect(inferred.scoreTotal).toBe(0.84);
  });

  test('a two-hop candidate never outranks the direct score for the same pair', () => {
    const anchorRow = snap({ brand: 'Twany', name: 'Twany Century The Cream SP', category: 'cream', tags: ['cream', 'skincare', 'japan', 'new'], price: 120 });
    const bridge = { ...snap({ brand: 'B', name: 'Bridge Cream', category: 'cream', price: 50 }), similarity_score: 0.95, category_use_case_match: 0.95, ingredient_functional_similarity: 0.95 };
    const twoHopRow = snap({ brand: 'X', name: 'Gamma Delta', category: 'cream', tags: ['cream', 'skincare', 'japan', 'new'], price: 40 });
    // similarity_score here is the second hop's score against the BRIDGE, not the anchor.
    const twoHop = { ...twoHopRow, similarity_score: 0.95, category_use_case_match: 0.95, ingredient_functional_similarity: 0.95 };
    const direct = scoreCandidateForAnchor(anchorRow, twoHopRow).score_total;
    const transitive = buildTransitiveRecallCandidate({ anchor: anchorRow, bridge, candidate: twoHop });

    expect(direct).toBeLessThan(0.8);
    expect(transitive).not.toBeNull();
    expect(transitive.score_total).toBeLessThan(direct);
    expect(transitive.similarity_score).toBe(transitive.score_total);
  });
});

// ---------------------------------------------------------------------------------------------
describe('dupe: an explicit rule on the graded scale', () => {
  const sunAnchor = snap({
    brand: 'Skin Aqua', name: 'Skin Aqua UV Super Moisture Essence Sunscreen SPF50+ PA++++', category: 'sunscreen', price: 14,
    inci_list: 'water alcohol ethylhexyl methoxycinnamate glycerin butylene glycol hyaluronic acid dimethicone tocopherol',
  });
  function relationFor(cand) {
    const score = scoreCandidateForAnchor(sunAnchor, cand);
    const scored = { ...cand, ...score, similarity_score: score.score_total, score_breakdown: score, price_observed_at: NOW };
    const out = build([sunAnchor], { [sunAnchor.product_ref]: [scored] });
    const edge = out.edges[0];
    return { relation: edge ? edge.relation_type : null, score: score.score_total, rejected: out.rejected_edges[0] || null };
  }

  test('the validator threshold is the exported constant on the new scale', () => {
    expect(DUPE_MIN_SCORE_TOTAL).toBe(0.78);
    const base = { anchor_ref: 'product:a', candidate_product_ref: 'product:b', relation_type: 'dupe', category_taxonomy: ['sunscreen'], use_case: 'sunscreen', source_refs: [{ type: 'catalog_products', authoritative: true }], price_evidence: { anchor_price_amount: 14, candidate_price_amount: 9, price_ratio: 0.64, observed_at: NOW }, candidate_snapshot: { price: 9 }, score_breakdown: { category_use_case_match: 0.72 } };
    expect(validateRelationshipEdge({ ...base, score_total: 0.79 }, { nowMs: Date.parse(NOW) }).errors).not.toContain('dupe_similarity_below_threshold');
    expect(validateRelationshipEdge({ ...base, score_total: 0.77 }, { nowMs: Date.parse(NOW) }).errors).toContain('dupe_similarity_below_threshold');
  });

  test('accepts: a genuine cross-brand dupe (same leaf, similar INCI, shared name words) emits with margin', () => {
    const got = relationFor(snap({
      brand: 'Biore', name: 'Biore UV Aqua Rich Watery Essence Sunscreen SPF50+ PA++++', category: 'sunscreen', price: 9,
      inci_list: 'water alcohol ethylhexyl methoxycinnamate glycerin butylene glycol hyaluronic acid tocopherol niacinamide',
    }));
    expect(got.relation).toBe('dupe');
    expect(got.score - DUPE_MIN_SCORE_TOTAL).toBeGreaterThanOrEqual(0.05);
  });

  test('accepts: a modest-evidence dupe between the new threshold and the old 0.82 is still a dupe', () => {
    const got = relationFor(snap({
      brand: 'Anessa', name: 'Anessa Perfect UV Sunscreen Skincare Milk SPF50+', category: 'sunscreen', price: 12,
      inci_list: 'water alcohol zinc oxide glycerin butylene glycol silica tocopherol',
    }));
    expect(got.relation).toBe('dupe');
    expect(got.score).toBeGreaterThanOrEqual(DUPE_MIN_SCORE_TOTAL);
    expect(got.score).toBeLessThan(0.82);
  });

  test('a contradicting INCI refutes a dupe even when the names match', () => {
    const got = relationFor(snap({
      brand: 'Other', name: 'Other UV Aqua Essence Sunscreen SPF50+', category: 'sunscreen', price: 9,
      inci_list: 'zinc oxide titanium dioxide caprylic triglyceride coconut alkanes',
    }));
    expect(got.relation).toBe('competitive_alternative');
  });

  test('accepts: a retailer row without an ingredient list can still be a dupe on its name words', () => {
    const got = relationFor(snap({ brand: 'Biore', name: 'Biore UV Aqua Rich Watery Essence Sunscreen SPF50+', category: 'sunscreen', price: 9 }));
    expect(got.relation).toBe('dupe');
  });
});

// ---------------------------------------------------------------------------------------------
// Leaf-category / area agreement. Fails open on anything unknown; rejects only explicit conflicts.
// ---------------------------------------------------------------------------------------------
describe('leaf category agreement for dupe / competitive_alternative', () => {
  const rejects = [
    ['face cream vs eye cream', { category: 'Face Cream', name: 'Ayura Face Cream' }, { category: 'Eye Cream', name: 'INNBEAUTY Bright & Tight Eye Cream' }, 'leaf_area_mismatch:face_vs_eye'],
    ['face cream vs hand cream', { category: 'cream', name: 'Twany Face Cream' }, { category: 'Hand Cream', name: 'NUXE Hand and Nail Cream' }, 'leaf_area_mismatch:face_vs_hand+nail'],
    ['face wash vs hair oil', { category: 'cleanser', name: 'FANCL Face Wash' }, { category: 'Hair Oil', name: 'Moroccanoil Hair Oil' }, 'leaf_area_mismatch:face_vs_hair'],
    ['hand cream vs hair oil', { category: 'Hand Cream', name: 'Frosted Citrus Hand Cream' }, { category: 'Hair Oil', name: 'Moroccanoil Pure Argan Oil' }, 'leaf_area_mismatch:hand_vs_hair'],
    ['body wash vs face cleanser', { category: 'Body Wash', name: 'Aromatic Body Wash' }, { category: 'cleanser', name: 'Gentle Face Cleanser' }, 'leaf_area_mismatch:body_vs_face'],
    ['lip gloss vs lip balm', { category: 'lips', name: 'MCoBeauty Jelly Gloss' }, { category: 'lips', name: 'Upcircle Lip Balm with Hemp Seed Oil + Shea Butter' }, 'leaf_form_mismatch:gloss_vs_balm'],
    ['lip tint vs lip balm', { category: 'lips', name: 'MCoBeauty Dream Lip Tint Hydrating Gel' }, { category: 'lips', name: 'Missnella Sugar Plum Lip Balm' }, 'leaf_form_mismatch:lipstick_vs_balm'],
    ['sunscreen gel vs face wash mislabelled sunscreen', { category: 'sunscreen', name: 'Ayura Water Feel UV Gel Alpha Prism' }, { category: 'sunscreen', name: 'Upcircle Powder to Foam Face Wash with Willow Bark' }, 'leaf_form_mismatch:sunscreen_vs_cleanser'],
    ['loose powder vs powder wash', { category: 'powder', name: 'Est Long Lasting Loose Powder' }, { category: 'Cleanser', name: 'TIRTIR Hydro Boost Enzyme Powder Wash' }, 'leaf_form_mismatch:powder_vs_cleanser'],
    ['rouge (a lipstick) vs lip balm', { category: 'Rouge', name: 'Guerlain Rouge G' }, { category: 'lips', name: 'Missnella Sugar Plum Lip Balm' }, 'leaf_form_mismatch:lipstick_vs_balm'],
    ['rouge (a lip product) vs eye cream', { category: 'Rouge', name: 'Guerlain Rouge G' }, { category: 'Eye Cream', name: 'BYOMA Barrier Repair Eye Cream' }, 'leaf_area_mismatch:lip_vs_eye'],
    ['sun cream (a sunscreen) vs foaming cleanser', { category: 'sun care', name: 'Nivea Sun Cream SPF50' }, { category: 'cleanser', name: 'Ayura Foaming Wash' }, 'leaf_form_mismatch:sunscreen_vs_cleanser'],
  ];
  test.each(rejects)('rejects: %s', (_label, a, c, reason) => {
    expect(leafCategoryCompatibility(a, c)).toEqual({ compatible: false, reason, evaluated: true });
  });

  const accepts = [
    ['JP "lotion" is a toner', { category: 'toner', name: 'Hada Labo Gokujyun Lotion' }, { category: 'toner', name: "Kiehl's Calendula Toner" }],
    ['clarifying lotion vs toner', { category: 'lotion', name: 'Clinique Clarifying Lotion' }, { category: 'Toner', name: 'Pixi Glow Tonic Toner' }],
    ['BB cream vs foundation', { category: 'foundation', name: 'Erborian BB Cream' }, { category: 'Foundation', name: "Fenty Pro Filt'r Foundation" }],
    ['tinted moisturizer vs foundation', { category: 'complexion', name: 'Laura Mercier Tinted Moisturizer' }, { category: 'Foundation', name: 'Rare Beauty Liquid Touch Foundation' }],
    ['sun cream vs UV gel', { category: 'sunscreen', name: 'Nivea Sun Cream SPF50' }, { category: 'sunscreen', name: 'Ayura Water Feel UV Gel' }],
    ['night cream vs face oil', { category: 'cream', name: "Kiehl's Midnight Night Cream" }, { category: 'oil', name: 'Sunday Riley Face Oil' }],
    ['blush vs cheek tint', { category: 'blush', name: 'Nars Blush' }, { category: 'cheek', name: 'Benefit Cheek Tint' }],
    ['shampoo vs hair shampoo (no default area)', { category: 'shampoo', name: 'Fenty Shampoo' }, { category: 'Hair Shampoo', name: 'Bondi Boost Hair Shampoo' }],
    ['body wash vs shower gel', { category: 'Body Wash', name: 'Dove Body Wash' }, { category: 'Shower Gel', name: 'Rituals Shower Gel' }],
    ['deodorant vs body deodorant', { category: 'Deodorant', name: 'Native Deodorant' }, { category: 'Body Deodorant', name: 'Dove Body Deodorant' }],
    ['lipstick vs rouge', { category: 'Lipstick', name: 'MAC Lipstick' }, { category: 'Rouge', name: 'Guerlain Rouge G' }],
    ['cream vs lotion (preflight alias)', { category: 'skincare/moisturize/cream', name: 'Moist Cream' }, { category: 'skincare > moisturizer', name: 'Hydrating Lotion' }],
    ['cleanser vs cream-to-foam face cleanser (head form)', { category: 'cleanser', name: 'FANCL Facial Cleanser 150ml' }, { category: 'Cleanser', name: 'First Aid Beauty Ultra Gentle Cream-to-Foam Face Cleanser with Colloidal Oatmeal' }],
    ['hand & body milk vs hand and nail cream (areas intersect)', { category: 'Hand & Body', name: 'Sweet Bouquet Hand & Body Milk' }, { category: 'Hand Cream', name: 'NUXE Hand and Nail Cream' }],
    ['unknown area fails open: hand cream vs multi-purpose oil', { category: 'Hand Cream', name: 'To/one Frosted Citrus Hand Cream' }, { category: 'care', name: 'NUXE Huile Prodigieuse Or 50 ml' }],
    ['unknown area fails open: cream vs eye emulsion (caught by the apply-time eye prefilter)', { category: 'cream', name: 'Ayura Increase Moist Cream' }, { category: 'cream', name: 'Acseine White Emulsion Cell Up Eye' }],
    ['taxonomy leaf when category is broad', { category: 'skincare', category_taxonomy: ['skincare', 'serum'], name: 'Luxury Barrier Serum' }, { category: 'beauty', category_taxonomy: ['skincare', 'serum'], name: 'Barrier Serum Alternative' }],
    ['Japanese-script names fail open', { category: '化粧水', name: '肌ラボ 極潤 ヒアルロン液' }, { category: 'Face Cream', name: 'Pixi Face Cream' }],
    ['no leaf on either side abstains', { category: 'general', name: 'Alpha Beta' }, { category: '', name: 'Gamma Delta' }],
  ];
  test.each(accepts)('accepts: %s', (_label, a, c) => {
    expect(leafCategoryCompatibility(a, c).compatible).toBe(true);
  });

  test('synonym groups canonicalise the head form and the area', () => {
    const forms = (snapshot) => [...snapshotLeafProfile(snapshot).forms].sort();
    const areas = (snapshot) => [...snapshotLeafProfile(snapshot).areas].sort();
    expect(forms({ name: 'Nivea Sun Cream SPF50' })).toEqual(['sunscreen']);
    expect(forms({ name: 'Ayura Water Feel UV Gel' })).toEqual(['sunscreen']);
    expect(forms({ name: 'Erborian BB Cream' })).toEqual(['foundation']);
    expect(forms({ name: 'Laura Mercier Tinted Moisturizer' })).toEqual(['foundation']);
    expect(forms({ name: 'Guerlain Rouge G' })).toEqual(['lipstick']);
    expect(areas({ name: 'Guerlain Rouge G' })).toEqual(['lip']);
    expect(forms({ name: 'Hada Labo Gokujyun Lotion' })).toEqual(['lotion']);
    expect(forms({ name: 'Benefit Cheek Tint' })).toEqual(['blush']);
    expect(forms({ name: 'Upcircle Lip Balm with Hemp Seed Oil + Shea Butter' })).toEqual(['balm']);
    expect(forms({ name: 'First Aid Beauty Ultra Gentle Cream-to-Foam Face Cleanser' })).toEqual(['cleanser']);
    expect(forms({ name: '肌ラボ 極潤 ヒアルロン液' })).toEqual([]);
    expect(areas({ name: 'Fenty Shampoo' })).toEqual(['hair']);
  });

  test('description copy never feeds the rule: it is what leaked area and form words before', () => {
    const gloss = { category: 'lips', name: 'MCoBeauty Jelly Gloss', description: 'A hydrating lip balm-like gloss with nourishing oils from our summer collection.' };
    const balm = { category: 'lips', name: 'Upcircle Lip Balm', description: 'Glossy finish balm.' };
    expect(leafCategoryCompatibility(gloss, balm)).toEqual({ compatible: false, reason: 'leaf_form_mismatch:gloss_vs_balm', evaluated: true });

    const faceCream = { category: 'Face Cream', name: 'Ayura Moist Barrier Face Cream', description: 'Also gentle enough for the eye area and hands.' };
    const otherCream = { category: 'cream', name: 'Twany Century The Cream SP', description: 'Hair and body friendly texture.' };
    expect(leafCategoryCompatibility(faceCream, otherCream).compatible).toBe(true);
  });

  test('the builder rejects a leaf mismatch before it becomes a competitive_alternative', () => {
    const out = build(
      [anchor('hand', { name: 'Frosted Citrus Hand Cream', category: 'Hand Cream' })],
      { 'product:hand': [
        candidate('hair_oil', { brand: 'Moroccanoil', name: 'Pure Argan Hair Oil', category: 'Hair Oil', category_taxonomy: ['hair', 'oil'] }),
        candidate('hand_cream', { brand: 'NUXE', name: 'Hand and Nail Cream', category: 'Hand Cream', category_taxonomy: ['skincare', 'hand cream'] }),
      ] },
    );
    expect(out.edges.map((edge) => edge.candidate_product_ref)).toEqual(['product:hand_cream']);
    const rejected = out.rejected_edges.find((row) => row.candidate_ref === 'product:hair_oil');
    expect(rejected.metrics.leafCompatibility.reason).toBe('leaf_area_mismatch:hand_vs_hair');
  });

  test('accepts: related_product is decided by brand before the leaf rule', () => {
    const out = build(
      [anchor('hand', { name: 'Frosted Citrus Hand Cream', category: 'Hand Cream', brand: 'To/one' })],
      { 'product:hand': [candidate('sibling', { brand: 'To/one', name: 'Argan Hair Oil', category: 'Hair Oil' })] },
    );
    expect(out.edges.map((edge) => edge.relation_type)).toEqual(['related_product']);
  });
});

// ---------------------------------------------------------------------------------------------
describe('builder CLI: --max-anchors-per-candidate reaches the dry run', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');

  test('the flag caps fan-in in the written report (no --apply, no database)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-cli-'));
    const anchorIds = Array.from({ length: 12 }, (_, i) => `anchor_${String(i).padStart(2, '0')}`);
    const input = {
      anchors: anchorIds.map((id) => anchor(id)),
      candidatesByAnchor: Object.fromEntries(anchorIds.map((id, i) => [`product:${id}`, [candidate('hub', { similarity_score: 0.84 + (i % 6) * 0.02 })]])),
    };
    fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify(input));
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const run = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'build-product-relationship-graph.js'),
      '--input', path.join(dir, 'input.json'),
      '--max-anchors-per-candidate', '3',
      '--skip-need-nodes',
      '--review-status', 'pending',
      '--out', path.join(dir, 'out.json'),
    ], { env, encoding: 'utf8' });

    expect(run.status).toBe(0);
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
    expect(report.summary.dry_run).toBe(true);
    expect(report.summary.max_anchors_per_candidate_per_build).toBe(3);
    expect(report.summary.edge_count).toBe(3);
    expect(report.summary.fan_in_capped_count_per_build).toBe(9);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
