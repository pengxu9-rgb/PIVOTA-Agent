// Relationship-graph quality rules measured on the 2026-09-26 JP/AU dry run (2,677 anchors,
// 33,881 edges, gateway 91ecb2fe8):
//   - hub effect: one candidate (ALBION Excia Replant Whitening Cream) was the alternative for most
//     cream anchors in its shard; nothing capped a candidate's fan-in;
//   - unsupported claims: the only failing audit gate, 27 edges quoting merchant social proof
//     ("The viral product you've been waiting for!", "A viral bestseller").
// Each rule is paired with the case it must still accept.
const {
  buildProductRelationshipGraphDryRun,
  buildEdgeForCandidate,
  buildNicheSpecialistEdge,
  capCandidateFanIn,
  DEFAULT_MAX_ANCHORS_PER_CANDIDATE,
} = require('../src/auroraBff/productRelationshipGraphBuilder');
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

describe('per-candidate fan-in cap for dupe / competitive_alternative', () => {
  const anchorIds = Array.from({ length: 12 }, (_, i) => `anchor_${String(i).padStart(2, '0')}`);
  const anchors = anchorIds.map((id) => anchor(id));
  // The hub scores differently per anchor so "best-scoring anchors" is observable.
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
    // Scores 0.94 (anchors 5, 11) and 0.92 (anchors 4, 10) outrank the other eight.
    expect(hubEdges.map((edge) => edge.anchor_ref).sort()).toEqual([
      'product:anchor_04', 'product:anchor_05', 'product:anchor_10', 'product:anchor_11',
    ]);
    const capped = out.rejected_edges.filter((row) => row.errors.includes('candidate_fan_in_cap'));
    expect(capped).toHaveLength(8);
    expect(out.summary.fan_in_capped_count).toBe(8);
    expect(out.summary.max_fan_in_before_cap).toBe(12);
    expect(out.summary.max_anchors_per_candidate).toBe(4);
  });

  test('accepts: related_product fan-in is never capped', () => {
    const sameBrand = Object.fromEntries(
      anchorIds.map((id) => [`product:${id}`, [candidate('house_sibling', { brand: `Brand ${id}` })]]),
    );
    // Every anchor has a different brand, so make the sibling share each anchor's brand.
    for (const id of anchorIds) sameBrand[`product:${id}`][0].brand = `Brand ${id}`;
    const out = build(anchors, sameBrand, { maxAnchorsPerCandidate: 2 });

    const related = out.edges.filter((edge) => edge.relation_type === 'related_product');
    expect(related).toHaveLength(12);
    expect(out.summary.fan_in_capped_count).toBe(0);
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
    expect(out.summary.fan_in_capped_count).toBe(anchorIds.length - DEFAULT_MAX_ANCHORS_PER_CANDIDATE);
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
      expect.objectContaining({ anchor_ref: 'product:a3', errors: ['candidate_fan_in_cap'] }),
    ]);
    expect(out.max_fan_in_before_cap).toBe(3);
  });
});

describe('social-proof copy is stripped from the snapshot text an edge stores', () => {
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

  test('the builder and the audit share one detector', () => {
    expect(audit.SOCIAL_CLAIM_PATTERN).toBe(claimPhrases.SOCIAL_CLAIM_PATTERN);
    expect(audit.claimTextFragments({
      candidate_snapshot: Object.fromEntries(claimPhrases.CANDIDATE_CLAIM_FIELDS.map((f) => [f, `${f} text`])),
      anchor_snapshot: Object.fromEntries(claimPhrases.ANCHOR_CLAIM_FIELDS.map((f) => [f, `${f} text`])),
    }).map((fragment) => fragment.path).sort()).toEqual([
      ...claimPhrases.CANDIDATE_CLAIM_FIELDS.map((f) => `candidate_snapshot.${f}`),
      ...claimPhrases.ANCHOR_CLAIM_FIELDS.map((f) => `anchor_snapshot.${f}`),
    ].sort());
  });

  test('a viral sentence is dropped and the rest of the copy stays; the audit then passes the edge', () => {
    const edge = edgeFor({ description: VIRAL });

    expect(edge.candidate_snapshot.description).toBe('Introducing Neo Blurring Powder for the ultimate natural finish.');
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
        tradeoffs: ['Smaller size', 'Best seller so it sells out'],
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
    expect(niche.edge.candidate_snapshot.description).toBe('Peptide serum. Introducing Neo Blurring Powder for the ultimate natural finish.');
  });

  test('every phrase the audit flags is a phrase the builder strips', () => {
    const phrases = [
      'A viral bestseller',
      'Best seller in Australia',
      'Our #1 serum',
      'No. 1 cushion in Japan',
      'Award-winning formula',
      'As seen on TikTok',
      'Influencer favourite',
      'Cult classic',
    ];
    for (const phrase of phrases) {
      expect(claimPhrases.hasSocialProofClaim(phrase)).toBe(true);
      const edge = edgeFor({ description: `${phrase}. Formulated with niacinamide.` });
      expect(edge.candidate_snapshot.description).toBe('Formulated with niacinamide.');
      expect(audit.auditUnsupportedClaims(edge, 0)).toEqual([]);
    }
  });

  test('accepts: ordinary copy with numbers and product words is stored unchanged', () => {
    const copy = 'Contains 1% niacinamide and 3 ceramides. Use 1-2 pumps morning and night. Trend-neutral shade.';
    const edge = edgeFor({ description: copy });

    expect(claimPhrases.hasSocialProofClaim(copy)).toBe(false);
    expect(edge.candidate_snapshot.description).toBe(copy);
  });

  test('accepts: social proof that a source_ref supports is still audited as supported', () => {
    // The audit exempts social claims when a social/review source backs them; the builder's strip is
    // upstream of that and simply leaves nothing for the audit to weigh.
    const edge = edgeFor({ description: 'Trending on Instagram this month.', source_refs: [{ type: 'social_review', name: 'Instagram creator source' }] });
    expect(audit.hasSupportingSocialSource(edge)).toBe(true);
    expect(audit.auditUnsupportedClaims(edge, 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Score spread. 2026-09-26 shard-0 dry run (gateway cecd89171): 764 of 1,184 competitive
// alternatives scored exactly 0.93 and 371 exactly 0.80 — the exact-category floor (0.72) plus
// provenance constants (product-intel +0.05 +0.05 +0.11, external seed +0.08). Name, INCI and
// description agreement changed nothing, and an identical tag list pushed the builder to 1.0.
// ---------------------------------------------------------------------------------------------
const {
  normalizeProductCandidateSnapshot,
  __internal: { scoreCandidateForAnchor },
} = require('../src/auroraBff/productRelationshipGraphSources');
const { __internal: { leafCategoryCompatibility, inferRelationship } } = require('../src/auroraBff/productRelationshipGraphBuilder');

function snap(overrides = {}) {
  const { source_refs, ...rest } = overrides;
  return normalizeProductCandidateSnapshot(
    { product_ref: `product:${rest.name}`, ...rest, ...(source_refs ? { source_refs } : {}) },
    { sourceType: source_refs ? undefined : 'catalog_products' },
  );
}

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

  test('accepts: curated dupe evidence still lifts the pair above the shelf floor', () => {
    const curated = scoreOf(snap({ brand: 'Value', name: 'Value Cream', category: 'cream', tags: ['cream'], price: 20 }), { legacyMatch: true });
    expect(curated).toBeGreaterThan(0.82);
  });

  test('an identical retailer tag list is not a 1.0 edge', () => {
    const anchor = { product_id: 'a', brand: 'Twany', name: 'Twany Century The Cream SP', category: 'cream', tags: ['cream', 'skincare', 'japan', 'new'], price: 120 };
    const cand = snap({ brand: 'X', name: 'Gamma Delta', category: 'cream', tags: ['cream', 'skincare', 'japan', 'new'], price: 40 });
    const score = scoreCandidateForAnchor(snap(anchor), cand);
    expect(score.score_total).toBeLessThan(0.82);

    // The builder takes the sources score as-is instead of re-maxing its components.
    const inferred = inferRelationship(
      { brand: 'Twany', name: anchor.name, category: 'cream', price: 120 },
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
});

// ---------------------------------------------------------------------------------------------
// Leaf-category / area agreement. Each rejected pair is one seen in the 2026-09-26 dry run.
// ---------------------------------------------------------------------------------------------
describe('leaf category agreement for dupe / competitive_alternative', () => {
  const rejects = [
    ['hand cream vs multi-purpose oil', { category: 'Hand Cream', name: 'To/one Frosted Citrus Hand Cream' }, { category: 'care', name: 'NUXE Huile Prodigieuse Or 50 ml' }, 'leaf_area_mismatch:hand_vs_face'],
    ['hand cream vs hair oil', { category: 'Hand Cream', name: 'Frosted Citrus Hand Cream' }, { category: 'Hair Oil', name: 'Moroccanoil Pure Argan Oil' }, 'leaf_area_mismatch:hand_vs_hair'],
    ['lip gloss vs lip balm', { category: 'lips', name: 'MCoBeauty Jelly Gloss' }, { category: 'lips', name: 'Upcircle Lip Balm with Hemp Seed Oil' }, 'leaf_form_mismatch:gloss_vs_balm'],
    ['face cream vs eye emulsion on the same shelf', { category: 'cream', name: 'Ayura Increase Moist Cream' }, { category: 'cream', name: 'Acseine White Emulsion Cell Up Eye' }, 'leaf_area_mismatch:face_vs_eye'],
    ['face cream vs eye cream leaf', { category: 'cream', name: 'Twany Cell Rhythm 2027' }, { category: 'Eye Cream', name: 'INNBEAUTY Bright & Tight Eye Cream' }, 'leaf_area_mismatch:face_vs_eye'],
    ['sunscreen gel vs face wash mislabelled sunscreen', { category: 'sunscreen', name: 'Ayura Water Feel UV Gel' }, { category: 'sunscreen', name: 'Upcircle Powder to Foam Face Wash' }, 'leaf_form_mismatch:sunscreen_vs_cleanser+powder'],
    ['body wash vs face cleanser', { category: 'Body Wash', name: 'Aromatic Body Wash' }, { category: 'cleanser', name: 'Gentle Foaming Cleanser' }, 'leaf_area_mismatch:body_vs_face'],
  ];
  test.each(rejects)('rejects: %s', (_label, anchor, candidate, reason) => {
    expect(leafCategoryCompatibility(anchor, candidate)).toEqual({ compatible: false, reason, evaluated: true });
  });

  const accepts = [
    ['cream vs lotion (preflight alias)', { category: 'skincare/moisturize/cream', name: 'Moist Cream' }, { category: 'skincare > moisturizer', name: 'Hydrating Lotion' }],
    ['cleanser vs cream-to-foam face cleanser', { category: 'cleanser', name: 'FANCL Facial Cleanser 150ml' }, { category: 'Cleanser', name: 'First Aid Beauty Cream-to-Foam Face Cleanser' }],
    ['hand & body milk vs hand and nail cream', { category: 'Hand & Body', name: 'Sweet Bouquet Hand & Body Milk' }, { category: 'Hand Cream', name: 'NUXE Hand and Nail Cream' }],
    ['cheek product vs face product', { category: 'blush', name: 'Cheek Colour' }, { category: 'Blush', name: 'Soft Face Blush' }],
    ['eye shadow vs eye shadow, forms unknown', { category: 'eyeshadow', name: 'Lala Bouquet Eye Color Fresh N' }, { category: 'Eyeshadow', name: 'Liquid Fairy Lights' }],
    ['taxonomy leaf when category is broad', { category: 'skincare', category_taxonomy: ['skincare', 'serum'], name: 'Luxury Barrier Serum' }, { category: 'beauty', category_taxonomy: ['skincare', 'serum'], name: 'Barrier Serum Alternative' }],
    ['no leaf on either side abstains', { category: 'general', name: 'Alpha Beta' }, { category: '', name: 'Gamma Delta' }],
  ];
  test.each(accepts)('accepts: %s', (_label, anchor, candidate) => {
    expect(leafCategoryCompatibility(anchor, candidate).compatible).toBe(true);
  });

  test('description copy does not change the leaf: it is what leaked area and form words before', () => {
    const gloss = { category: 'lips', name: 'MCoBeauty Jelly Gloss', description: 'A hydrating lip balm-like gloss with nourishing oils from our summer collection.' };
    const balm = { category: 'lips', name: 'Upcircle Lip Balm', description: 'Glossy finish balm.' };
    expect(leafCategoryCompatibility(gloss, balm)).toEqual({ compatible: false, reason: 'leaf_form_mismatch:gloss_vs_balm', evaluated: true });

    const faceCream = { category: 'cream', name: 'Ayura Moist Barrier Cream', description: 'Also gentle enough for the eye area and hands.' };
    const otherCream = { category: 'cream', name: 'Twany Century The Cream SP', description: 'Body and hair friendly texture.' };
    expect(leafCategoryCompatibility(faceCream, otherCream).compatible).toBe(true);
  });

  test('the builder rejects a leaf mismatch before it becomes a competitive_alternative', () => {
    const out = build(
      [anchor('hand', { name: 'Frosted Citrus Hand Cream', category: 'Hand Cream' })],
      { 'product:hand': [
        candidate('hair_oil', { brand: 'Moroccanoil', name: 'Pure Argan Oil', category: 'Hair Oil', category_taxonomy: ['hair', 'oil'] }),
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
    expect(report.summary.max_anchors_per_candidate).toBe(3);
    expect(report.summary.edge_count).toBe(3);
    expect(report.summary.fan_in_capped_count).toBe(9);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
