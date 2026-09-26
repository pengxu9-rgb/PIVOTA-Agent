// matchesBrandScopeCandidate used to build every candidate's brand aliases up front, including
// detectBrandEntities - a brand-lexicon scan over the title, name AND FULL DESCRIPTION - and only then
// ask whether any alias matched. Measured 2026-09-17 at ~3ms per candidate (1,074ms for 360), almost all
// of it that scan, synchronous, and ~491ms of a brand page's p50. It now consults the cheap direct
// fields first and runs the scan only when they do not already match.
//
// Two properties matter, and they are tested separately:
//   1. SAME ANSWER. `some` over (direct ∪ detected) is `some` over direct OR `some` over detected, so the
//      short-circuit must never change the boolean. Checked against the ORIGINAL decision logic, frozen
//      below, over a corpus that includes detection-only matches and near-misses.
//   2. THE SCAN IS ACTUALLY SKIPPED. A refactor that still builds the detected aliases eagerly returns the
//      same answers and saves nothing, so the scan is counted.

describe('brand-scope matching consults direct fields before the brand-detection scan', () => {
  afterEach(() => {
    jest.dontMock('../src/findProductsMulti/brandLexicon');
    jest.resetModules();
  });

  const loadWithCountingDetector = () => {
    jest.resetModules();
    const counter = { calls: 0 };
    jest.doMock('../src/findProductsMulti/brandLexicon', () => {
      const actual = jest.requireActual('../src/findProductsMulti/brandLexicon');
      return {
        ...actual,
        detectBrandEntities: (...args) => {
          counter.calls += 1;
          return actual.detectBrandEntities(...args);
        },
      };
    });
    const { _internals } = require('../src/services/discoveryFeed');
    return { internals: _internals, counter };
  };

  // The ORIGINAL decision logic, verbatim in shape: build the union of direct and detected aliases, then
  // ask whether any requested alias matches any of them. Frozen here on purpose so a later edit to the
  // production function cannot quietly move the reference with it.
  const originalMatches = (internals, normalizeBrandText, candidate, aliases = []) => {
    if (!Array.isArray(aliases) || aliases.length === 0) return true;
    const candidateAliases = Array.from(new Set([
      ...internals.buildCandidateDirectBrandAliases(candidate),
      ...internals.buildCandidateDetectedBrandAliases(candidate),
    ]));
    if (candidateAliases.length === 0) return false;
    return aliases.some((alias) => {
      const normalizedAlias = normalizeBrandText(alias);
      if (!normalizedAlias) return false;
      return candidateAliases.some((candidateBrand) => internals.matchesNormalizedBrandAlias(candidateBrand, normalizedAlias));
    });
  };

  const product = (overrides) => ({
    brand: undefined,
    raw: { title: '', name: '', description: '' },
    ...overrides,
    raw: { title: '', name: '', description: '', ...(overrides.raw || {}) },
  });

  const CORPUS = [
    ['direct brand field', product({ brand: 'Mixsoon', raw: { title: 'Bean Essence 50ml' } })],
    ['vendor only', product({ raw: { vendor: 'Mixsoon', title: 'Bean Essence' } })],
    ['brand_name only, mixed case', product({ raw: { brand_name: 'MIXSOON', title: 'Toner' } })],
    ['manufacturer only', product({ raw: { manufacturer: 'Round Lab', title: 'Dokdo Toner' } })],
    // Detection-ONLY matches must use brands the lexicon actually knows. It detects Tatcha, The Ordinary
    // and CeraVe but not Mixsoon, Round Lab or Cosrx - a detection-only case built on those would never
    // match through the scan, and the equivalence test would silently never exercise that branch.
    ['no brand field, brand only in the title', product({ raw: { title: 'Tatcha The Water Cream' } })],
    ['no brand field, brand only in the description', product({ raw: { title: 'Serum', description: 'By The Ordinary, a niacinamide serum' } })],
    ['no brand field, a two-token brand in the title', product({ raw: { title: 'CeraVe Moisturizing Cream' } })],
    ['a store in vendor, the real brand in the title', product({ raw: { vendor: 'Ulta Beauty', title: 'Tatcha The Water Cream' } })],
    ['a different brand in every field', product({ brand: 'Cosrx', raw: { vendor: 'Cosrx', title: 'Cosrx Snail Mucin' } })],
    ['compact-spelling brand', product({ brand: 'Round-Lab', raw: { title: 'Toner' } })],
    ['prefix of a longer brand', product({ brand: 'Mixsoon Official', raw: { title: 'Essence' } })],
    ['nothing at all', product({})],
    ['empty strings everywhere', product({ brand: '', raw: { brand: '', vendor: '', title: '', description: '' } })],
  ];
  const ALIAS_SETS = [['Mixsoon'], ['Round Lab'], ['round lab', 'roundlab'], ['Tatcha'], ['The Ordinary'], ['CeraVe'], ['Cosrx'], ['Nonexistent Brand'], ['', '   '], []];

  test('returns exactly what the original union-then-match logic returned', () => {
    const { internals } = loadWithCountingDetector();
    const { normalizeBrandText } = jest.requireActual('../src/findProductsMulti/brandLexicon');
    const disagreements = [];
    for (const [label, candidate] of CORPUS) {
      for (const aliases of ALIAS_SETS) {
        const expected = originalMatches(internals, normalizeBrandText, candidate, aliases);
        const actual = internals.matchesBrandScopeCandidate(candidate, aliases);
        if (expected !== actual) disagreements.push({ label, aliases, expected, actual });
      }
    }
    expect(disagreements).toEqual([]);
  });

  test('the corpus exercises both branches, so the equivalence above is not vacuous', () => {
    const { internals } = loadWithCountingDetector();
    const results = CORPUS.flatMap(([, candidate]) => ALIAS_SETS.map((aliases) => internals.matchesBrandScopeCandidate(candidate, aliases)));
    expect(results).toContain(true);
    expect(results).toContain(false);
    // A detection-ONLY match: no direct field names the brand, only the title does.
    const titleOnly = CORPUS.find(([label]) => label === 'no brand field, brand only in the title')[1];
    expect(internals.buildCandidateDirectBrandAliases(titleOnly)).toEqual([]);
    expect(internals.matchesBrandScopeCandidate(titleOnly, ['Tatcha'])).toBe(true);
    // ...and a store in vendor with the real brand only detectable from the title.
    const storeVendor = CORPUS.find(([label]) => label === 'a store in vendor, the real brand in the title')[1];
    expect(internals.matchesBrandScopeCandidate(storeVendor, ['Tatcha'])).toBe(true);
  });

  test('the detection scan does not run when a direct field already matches', () => {
    const { internals, counter } = loadWithCountingDetector();
    const brandDirectPool = Array.from({ length: 50 }, (_, i) =>
      product({ brand: 'Mixsoon', raw: { title: `Mixsoon Bean Essence ${i}`, description: 'A long fermented essence. '.repeat(30) } }));
    counter.calls = 0;
    const kept = brandDirectPool.filter((candidate) => internals.matchesBrandScopeCandidate(candidate, ['Mixsoon']));
    expect(kept).toHaveLength(50);
    // The whole point: a pool fetched BY brand never pays for the scan.
    expect(counter.calls).toBe(0);
  });

  test('the detection scan still runs when the direct fields do not match', () => {
    const { internals, counter } = loadWithCountingDetector();
    const titleOnly = product({ raw: { title: 'Tatcha The Water Cream' } });
    counter.calls = 0;
    expect(internals.matchesBrandScopeCandidate(titleOnly, ['Tatcha'])).toBe(true);
    expect(counter.calls).toBe(1);
  });

  // The equivalence test compares against a reference built from the SAME direct-alias helper, so a field
  // dropped from that helper changes both sides at once and passes. Each direct field is pinned on its
  // own here, with a brand the lexicon does NOT detect (Mixsoon) and an unrelated title - so the scan
  // cannot rescue a lost field and hide the regression.
  test.each([
    ['brand', { brand: 'Mixsoon' }],
    ['raw.brand', { raw: { brand: 'Mixsoon' } }],
    ['raw.brand_name', { raw: { brand_name: 'Mixsoon' } }],
    ['raw.vendor', { raw: { vendor: 'Mixsoon' } }],
    ['raw.vendor_name', { raw: { vendor_name: 'Mixsoon' } }],
    ['raw.manufacturer', { raw: { manufacturer: 'Mixsoon' } }],
  ])('a candidate named only by %s still matches its brand page', (_field, fields) => {
    const { internals, counter } = loadWithCountingDetector();
    const candidate = product({ ...fields, raw: { title: 'Bean Essence 50ml', ...(fields.raw || {}) } });
    counter.calls = 0;
    expect(internals.buildCandidateDirectBrandAliases(candidate)).toContain('mixsoon');
    expect(internals.matchesBrandScopeCandidate(candidate, ['Mixsoon'])).toBe(true);
    // Answered by the direct field, so the scan never ran.
    expect(counter.calls).toBe(0);
  });
});
