const fs = require('node:fs');
const path = require('node:path');

const {
  GRADE,
  QUERY_RUBRICS,
  classifyForms,
  judgeProduct,
  hasRubric,
} = require('../../scripts/lib/adr020_recall_relevance.cjs');

const CORPUS_PATH = path.join(__dirname, '..', 'fixtures', 'adr020_phase1_recall_corpus.jsonl');

function gradeOf(query, brand, title) {
  const judged = judgeProduct(query, { brand, title });
  return judged ? judged.grade : null;
}

describe('in-domain corpus', () => {
  const corpus = fs
    .readFileSync(CORPUS_PATH, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  test('carries only beauty-domain buckets', () => {
    // The 2026-07-30 corpus was a generic multi-category eval set run against a
    // beauty catalog: "running shoes", "black leather sneakers", "oversized
    // hoodie", "bluetooth earbuds", "aroma diffuser" and "insulated water
    // bottle" had no correct answer in the data, so every seed-lane result for
    // them was noise that the parity diff promoted to an acceptance target.
    for (const entry of corpus) {
      expect(entry.bucket).toMatch(/^(skincare|makeup|fragrance)/);
    }
    expect(corpus).toHaveLength(37);
  });

  test('every corpus query has a relevance rubric', () => {
    // A query with no rubric cannot be judged, and an unjudged query must never
    // be silently graded 0 — the builder reports it instead.
    const missing = corpus.map((e) => e.query).filter((q) => !hasRubric(q));
    expect(missing).toEqual([]);
  });

  test('no rubric grades a form as both relevant and partial', () => {
    for (const [query, rubric] of Object.entries(QUERY_RUBRICS)) {
      const overlap = rubric.relevant.filter((f) => rubric.partial.includes(f));
      expect({ query, overlap }).toEqual({ query, overlap: [] });
    }
  });
});

describe('form classifier reads compound phrases before single tokens', () => {
  test('"fragrance free" is a skincare attribute, never a fragrance', () => {
    const { forms } = classifyForms('TULA', '24-7 Moisture Fragrance Free Hydrating Day & Night Cream');
    expect(forms).toContain('moisturizer');
    expect(forms).not.toContain('fragrance');
  });

  test('"tinted moisturizer" is complexion makeup, not a face moisturizer', () => {
    const { forms } = classifyForms('Fenty Beauty', 'Hydra Vizor Tinted Moisturizer Mineral SPF 30 Sunscreen');
    expect(forms).toEqual(expect.arrayContaining(['foundation', 'sunscreen']));
    expect(forms).not.toContain('moisturizer');
  });

  test('an implement is never the product it applies', () => {
    // Both were graded RELEVANT before the tool arm existed, inflating the
    // measured precision of whichever lane returned them.
    expect(gradeOf('full coverage foundation oily skin', 'kylie cosmetics', 'Foundation Brush 01')).toBe(
      GRADE.IRRELEVANT,
    );
    expect(
      gradeOf(
        'lightweight gel moisturizer for acne-prone skin',
        'Arocell',
        'AROCELL Face Mask Soft Silicone Brush Skin Care Tools Moisturizer Applicator & Skincare Brush for Facials',
      ),
    ).toBe(GRADE.IRRELEVANT);
    // ...but a cushion compact is a product, not an implement.
    expect(gradeOf('cushion foundation', 'TIRTIR Global', 'Mask Fit Red Cushion')).toBe(GRADE.RELEVANT);
  });

  test('a body or hair surface suppresses the face-care read', () => {
    expect(classifyForms('Tom Ford Beauty', 'Oud Wood Hand and Body Moisturizer').forms).not.toContain(
      'moisturizer',
    );
    expect(classifyForms('NUXE', 'Multi-Use Shower Gel Face, Beard, Body, Hair').forms).not.toContain(
      'cleanser',
    );
  });
});

describe('multi-product sets are partial answers, never full ones', () => {
  test('a mixed routine set is not the product it contains', () => {
    // Graded RELEVANT before this rule, on the strength of the word "Cream".
    expect(
      gradeOf(
        'lightweight gel moisturizer for acne-prone skin',
        'EIOM',
        'Korean Acne-prone skin daily care set - Targeting Serum & Cream',
      ),
    ).toBe(GRADE.PARTIAL);
  });

  test('even a same-form set caps at partial', () => {
    expect(gradeOf('mascara', 'Merit', 'The Mascara Duo')).toBe(GRADE.PARTIAL);
    expect(gradeOf('mascara', 'ILIA', 'Mascara is a Moment Set')).toBe(GRADE.PARTIAL);
    expect(gradeOf('mascara', 'ILIA', 'Limitless Lash Mascara')).toBe(GRADE.RELEVANT);
  });

  test('set detection is word-bounded — "Sunset" is not a set', () => {
    expect(classifyForms('Brand', 'Sunset Glow Moisturizer').forms).not.toContain('set_or_collection');
    expect(gradeOf('moisturizer', 'Brand', 'Sunset Glow Moisturizer')).toBe(GRADE.RELEVANT);
  });
});

describe('regression: the 2026-07-30 fixture handed acceptance targets to irrelevant products', () => {
  // Each row is a (query, product) pair the old parity-diff fixture recorded as
  // a recall gap the projection "must close". Every one is graded IRRELEVANT:
  // tuning the ranker to reproduce them would actively degrade results.
  const wrongTargets = [
    ['red lipstick long-lasting', 'SKINTIFIC', 'Glow Bright Day Cream'],
    ['red lipstick long-lasting', 'Round Lab', 'Birch Moisturizing Cleanser'],
    ['red lipstick long-lasting', 'COSRX', 'Hydrium Triple Hyaluronic Moisture Ampoule'],
    ['red lipstick long-lasting', 'Tom Ford Beauty', 'Oud Wood Hand and Body Moisturizer'],
    ['red lipstick long-lasting', 'Glow Recipe', 'Plum Plump Hyaluronic Cream'],
    ['red lipstick long-lasting', 'Beekman 1802', 'Pure Face Wipes'],
    ['vanilla perfume', 'Beekman 1802', 'Lilac Dream Whipped Body Cream'],
    ['vanilla perfume', 'Beekman 1802', 'Almond Honey Cookie Lotion'],
    [
      'vanilla perfume',
      'Tom Ford Beauty',
      'Architecture Radiance Hydrating Foundation Broad Spectrum SPF 50+',
    ],
    ['vanilla perfume', 'Naturium', 'Phyto-Glow Lip Balm Shimmer Solar'],
    ['vanilla perfume', 'Naturium', 'Phyto-Glow Lip Balm Mocha'],
    ['vanilla perfume', 'Naturium', 'Phyto-Glow Lip Balm Petal'],
    [
      'unisex fragrance for daily wear',
      'Haruharu Wonder',
      'Moisture Pure Mineral Relief Sunscreen SPF50+/PA++++ /Unscented',
    ],
    ['unisex fragrance for daily wear', 'Then I Met You', 'Bong² Bounce Cream'],
    ['woody fragrance under $80', 'NUXE', 'Multi-Use Shower Gel Face, Beard, Body, Hair'],
  ];

  test.each(wrongTargets)('%s -> "%s %s" is irrelevant', (query, brand, title) => {
    expect(gradeOf(query, brand, title)).toBe(GRADE.IRRELEVANT);
  });
});

describe('genuinely relevant seed-lane results still grade as gaps-in-waiting', () => {
  const goodTargets = [
    ['gentle cleanser', 'Clinique', 'All About Clean Liquid Facial Soap Cleanser - Mild - 6.7 oz'],
    ['gentle cleanser', 'Beauty of Joseon', 'Beauty of Joseon Ginseng Cleansing Oil'],
    ['gentle cleanser', 'Seresilk', 'Gentle Silk Cleanser'],
    ['hydrating barrier moisturizer fragrance free', 'COSRX', 'Ceramide Skin Barrier Moisturizer'],
    [
      'hydrating barrier moisturizer fragrance free',
      'Olehenriksen',
      'Après Skin Rich Rescue Barrier Moisturizer with Ceramides',
    ],
    ['lightweight gel moisturizer for acne-prone skin', 'Beauty of Joseon', 'Red Bean Water Gel'],
    ['lightweight gel moisturizer for acne-prone skin', 'Neutrogena', 'Evenly Clear Acne Gel Moisturizer'],
    ['waterproof volumizing mascara', 'rare beauty', 'Perfect Strokes Universal Volumizing Mascara'],
    ['neutral eyeshadow palette', 'e.l.f. Cosmetics', 'Bite Size Eyeshadow Palette - Cream & Sugar'],
    ['neutral eyeshadow palette', 'RMS Beauty', 'ReDimension Hydra Eyes Quartet'],
    ['vanilla perfume', 'Tom Ford Beauty', 'Tobacco Vanille Eau de Parfum'],
  ];

  test.each(goodTargets)('%s -> "%s %s" is relevant', (query, brand, title) => {
    expect(gradeOf(query, brand, title)).toBe(GRADE.RELEVANT);
  });
});

describe('regression: CATALOG-lane false positives (the rubric must cut both ways)', () => {
  // Every other pinned case in this file is a seed-lane error from the old
  // corpus. A rubric that only ever catches one lane's mistakes will report
  // that lane as worse regardless of the truth, so these pin the other side.
  const catalogFalsePositives = [
    // Graded RELEVANT until `fragrance` joined the surface-suppressed forms.
    // Five of the six results credited to "vanilla perfume" were these.
    ['vanilla perfume', 'TIELA', 'Perfume Nourishing Body Scrub Pure'],
    ['vanilla perfume', 'TIELA', 'Perfume Nourishing Body Cream Shine'],
    ['vanilla perfume', 'TIELA', 'Perfume Nourishing Body Cream Sunset'],
    // Tools that carry the form word.
    ['moisturizer', 'Arocell', 'AROCELL Face Mask Soft Silicone Brush Skin Care Tools Moisturizer Applicator'],
    ['full coverage foundation oily skin', 'kylie cosmetics', 'Foundation Brush 01'],
    // Wrong sub-form on a skincare query.
    ['lightweight gel moisturizer for acne-prone skin', 'AXIS-Y', 'Heartleaf Skin Soothing Gel Mask'],
    ['lightweight gel moisturizer for acne-prone skin', 'Centellian24', 'Matcha Peeling Gel'],
  ];

  test.each(catalogFalsePositives)('%s -> "%s %s" is not a relevant answer', (query, brand, title) => {
    expect(gradeOf(query, brand, title)).toBe(GRADE.IRRELEVANT);
  });

  test('a body-surface product never answers a fragrance query', () => {
    // The rule the rubric already stated for moisturizers, now applied to
    // perfume: "Hand and Body Moisturizer" is not a barrier moisturizer, and a
    // "Perfume Nourishing Body Scrub" is not a perfume.
    expect(classifyForms('TIELA', 'Perfume Nourishing Body Scrub Pure').forms).not.toContain(
      'fragrance',
    );
    expect(classifyForms('Tom Ford Beauty', 'Tobacco Vanille Eau de Parfum').forms).toContain(
      'fragrance',
    );
  });
});

describe('partial credit for right-family, wrong-sub-form', () => {
  test('a lip liner answers a lipstick query only partially', () => {
    expect(gradeOf('matte lipstick under $30', 'rare beauty', 'Kind Words Matte Lip Liner')).toBe(
      GRADE.PARTIAL,
    );
  });

  test('a barrier serum answers a barrier moisturizer query only partially', () => {
    expect(
      gradeOf(
        'hydrating barrier moisturizer fragrance free',
        'The Ordinary',
        'Soothing & Barrier Support Serum for Sensitive Skin & Hydration',
      ),
    ).toBe(GRADE.PARTIAL);
  });

  test('a fragrance layering balm answers a perfume query only partially', () => {
    expect(gradeOf('vanilla perfume', 'rare beauty', 'Fragrance Layering Balm - Amber Vanilla')).toBe(
      GRADE.PARTIAL,
    );
  });
});

describe('acceptance-corpus builder rules', () => {
  const { collapseQuery } = require('../../scripts/build-adr020-phase1-acceptance-corpus.cjs');

  const seedItem = (title, brand = 'Acme', id = title) => ({
    external_product_id: id,
    brand,
    title,
  });
  const row = (seed, catalog) => ({
    seed_count: seed.length,
    catalog_count: catalog.length,
    matches: [],
    only_in_seed: seed,
    only_in_catalog: catalog,
  });

  test('a relevant miss is NOT a gap when the catalog returns as many relevant answers', () => {
    // The trap the old corpus fell into one level up: the lanes barely overlap,
    // so a relevant seed result that the catalog missed is only a defect when
    // the catalog is also SHORT.
    const result = collapseQuery(
      'vanilla perfume',
      {},
      [
        row(
          [seedItem('Tobacco Vanille Eau de Parfum')],
          [seedItem('Black Orchid Eau de Parfum'), seedItem('Rose Eau de Parfum')],
        ),
      ],
    );
    expect(result.acceptance_target).toBe(false);
    expect(result.true_gaps).toEqual([]);
    expect(result.substitutable_misses).toHaveLength(1);
  });

  test('a relevant miss IS a gap when the catalog returns fewer relevant answers', () => {
    const result = collapseQuery(
      'gentle cleanser',
      {},
      [row([seedItem('Gentle Silk Cleanser'), seedItem('Ginseng Cleansing Oil')], [seedItem('Gua Sha Tool')])],
    );
    expect(result.acceptance_target).toBe(true);
    expect(result.relevance_deficit).toBe(2);
    expect(result.true_gaps.map((p) => p.title)).toEqual([
      'Gentle Silk Cleanser',
      'Ginseng Cleansing Oil',
    ]);
  });

  test('an irrelevant miss is never a gap, even on a deficit query', () => {
    const result = collapseQuery(
      'gentle cleanser',
      {},
      [row([seedItem('Gentle Silk Cleanser'), seedItem('Ombré Leather Eau de Parfum')], [])],
    );
    expect(result.true_gaps.map((p) => p.title)).toEqual(['Gentle Silk Cleanser']);
    expect(result.rejected_by_relevance.map((p) => p.title)).toEqual(['Ombré Leather Eau de Parfum']);
  });

  test('a stalled pass returning an empty lane is dropped, not averaged in', () => {
    // Observed 2026-08-07: the same query returned 8/8 in a healthy pass and
    // 0/0 in one stalling at 35-40s. Averaging manufactures a fake deficit.
    const healthy = row([seedItem('Gentle Silk Cleanser')], [seedItem('Birch Moisturizing Cleanser')]);
    const stalled = row([], []);
    const result = collapseQuery('gentle cleanser', {}, [healthy, stalled]);
    expect(result.passes_clean).toBe(1);
    expect(result.passes_dropped_as_stalled).toBe(1);
    expect(result.catalog_relevant_avg).toBe(1);
    expect(result.acceptance_target).toBe(false);
  });

  test('a unanimous zero is believed — it is the Chinese-query case, not a stall', () => {
    const result = collapseQuery('口红', {}, [row([], []), row([], [])]);
    expect(result.passes_clean).toBe(2);
    expect(result.passes_dropped_as_stalled).toBe(0);
    expect(result.catalog_returned_avg).toBe(0);
    expect(result.acceptance_target).toBe(false);
  });
});

describe('judgement contract', () => {
  test('attributes are recorded for review but never decide the grade', () => {
    // "long-lasting" is not settleable from a title. A real lipstick stays
    // RELEVANT even though the attribute is unverified — judging marketing copy
    // from a title is how the first corpus went wrong.
    const judged = judgeProduct('red lipstick long-lasting', {
      brand: 'rare beauty',
      title: 'Kind Words Matte Lipstick',
    });
    expect(judged.grade).toBe(GRADE.RELEVANT);
    expect(judged.unverified_attributes).toEqual(['red', 'long-lasting']);
  });

  test('an unknown query yields no judgement rather than a zero', () => {
    expect(judgeProduct('running shoes', { brand: 'Nike', title: 'Pegasus 41' })).toBeNull();
    expect(hasRubric('running shoes')).toBe(false);
  });

  test('every judgement carries the forms and reason that produced it', () => {
    const judged = judgeProduct('gentle cleanser', {
      brand: 'Seresilk',
      title: 'Gentle Silk Cleanser',
    });
    expect(judged.forms).toContain('cleanser');
    expect(judged.matched_forms).toEqual(['cleanser']);
    expect(judged.reason).toMatch(/directly answers/);
    expect(judged.resolved_text).toContain('cleanser');
  });
});
