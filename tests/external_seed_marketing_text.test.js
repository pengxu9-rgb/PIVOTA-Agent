'use strict';

const {
  stripExternalSeedMarketingBannerPrefix,
} = require('../src/services/externalSeedMarketingText');
// Inputs are real product descriptions pulled from active seeds (truncated to
// 3000 chars); each `expected` was produced by the PRE-CHANGE function on
// origin/main, so this is a genuine golden and not a snapshot of the new code
// agreeing with itself.
const golden = require('./fixtures/external_seed_marketing_text_golden.json');

describe('stripExternalSeedMarketingBannerPrefix', () => {
  // Behaviour first: the bound added for cost must not change what gets stripped.
  test('strips a colon-led marketing banner', () => {
    expect(stripExternalSeedMarketingBannerPrefix(
      'STRAIGHT UP: A lightweight gel cream that hydrates oily skin without any greasy finish at all.',
    )).toBe('A lightweight gel cream that hydrates oily skin without any greasy finish at all.');
  });

  test('strips an uppercase run before the body', () => {
    expect(stripExternalSeedMarketingBannerPrefix(
      'NEW LIMITED EDITION BESTSELLER GLOW DROP SET A hydrating gel cream for oily and combination skin that absorbs fast.',
    )).toBe('A hydrating gel cream for oily and combination skin that absorbs fast.');
  });

  test('keeps text that has no banner', () => {
    const text = 'A hydrating gel cream for oily and combination skin that absorbs quickly and leaves no residue.';
    expect(stripExternalSeedMarketingBannerPrefix(text)).toBe(text);
  });

  test('leaves short text alone', () => {
    expect(stripExternalSeedMarketingBannerPrefix('Gel cream.')).toBe('Gel cream.');
  });

  test('a banner in front of a very long body is still stripped, and the whole body survives', () => {
    const body = `A hydrating gel cream for oily skin. ${'It absorbs quickly and leaves no residue. '.repeat(2000)}`.trim();
    const out = stripExternalSeedMarketingBannerPrefix(`THE LOWDOWN: ${body}`);
    expect(out.startsWith('A hydrating gel cream for oily skin.')).toBe(true);
    // The bound applies to the SCAN, never to the returned text.
    expect(out.length).toBeGreaterThan(80000);
  });

  test('an uppercase-run banner returns the whole body, not just the scanned window', () => {
    // The colon branch returns early; this exercises the token loop, where the
    // prefix comes from the bounded window but the body must come from the full
    // text. Returning the window here would truncate the description to 1000
    // characters and quietly destroy the recall text.
    const body = `A hydrating gel cream for oily skin. ${'It absorbs quickly and leaves no residue. '.repeat(2000)}`.trim();
    const out = stripExternalSeedMarketingBannerPrefix(
      `NEW LIMITED EDITION BESTSELLER GLOW DROP SET ${body}`,
    );
    expect(out.startsWith('A hydrating gel cream for oily skin.')).toBe(true);
    expect(out.length).toBeGreaterThan(80000);
  });

  test('an all-caps run longer than the scan bound is still stripped', () => {
    // The scan bound alone would stop before this body ever appears. The window
    // extends to the first lowercase-bearing token precisely so a leading INCI
    // list cannot survive as the start of the text -- see the dropped-field test
    // below for what that costs downstream.
    const text = `${'HYDRATION '.repeat(400)}extraordinarily hydrating gel cream for oily skin types.`;
    // `toBe`, not `endsWith`: the old 56-char fragment also ends this way, so
    // `endsWith` passed for both the bug and the fix and proved nothing.
    expect(stripExternalSeedMarketingBannerPrefix(text))
      .toBe('extraordinarily hydrating gel cream for oily skin types.');
  });

  test('a leading all-caps INCI list past the bound does not become a dropped field', () => {
    // `stripRecallNarrativeNoise` cuts to '' when a cut pattern matches before
    // index 24. So leaving the text opening with "INGREDIENTS" does not merely
    // fail to strip a banner -- it destroys the whole recall field. Constructed
    // at 1100 chars of caps, past the 1000 bound; 5 of 10,136 active rows have a
    // leading no-lowercase run that long.
    let block = 'INGREDIENTS: WATER, GLYCERIN, BUTYLENE GLYCOL, SQUALANE, NIACINAMIDE, ADENOSINE, CARBOMER, XANTHAN GUM, TOCOPHEROL, ';
    while (block.length < 1100) {
      block += 'WATER, GLYCERIN, BUTYLENE GLYCOL, SQUALANE, NIACINAMIDE, ADENOSINE, CARBOMER, TOCOPHEROL, ';
    }
    const body = 'A hydrating gel cream for oily skin that absorbs quickly and leaves no residue on the face.';
    const out = stripExternalSeedMarketingBannerPrefix(`${block.slice(0, 1100).trim()} ${body}`);
    // The body must lead, or the cut patterns downstream match at index 0.
    expect(out).toBe(body);
  });

  test('a qualifying token past a short early lowercase word is still found', () => {
    // This is what BANNER_SCAN_LIMIT's floor actually controls. The extension
    // guarantees the FIRST lowercase token is always reachable, so a plain
    // "banner then body" case survives even a limit of 100. Only when an early
    // lowercase word cannot qualify (its prefix is under 6 tokens) does the real
    // boundary sit further out, where the limit decides whether we look at all.
    // Without this, lowering the limit to 100 passes every other test here.
    const head = 'NEW ab ';
    const caps = 'LIMITED EDITION BESTSELLER GLOW DROP SET EXCLUSIVE OFFER SHOP NOW '.repeat(6);
    const body = 'a hydrating gel cream for oily and combination skin that absorbs quickly.';
    expect(stripExternalSeedMarketingBannerPrefix(`${head}${caps}${body}`)).toBe(body);
  });

  test('a caps ingredient block later in the text cannot swallow the description', () => {
    // The real shape, reduced: prose description, then a long uppercase
    // INGREDIENTS list carrying stray lowercase joiners. Scanning the whole
    // string let that list dominate the "uppercase prefix" test, and one of the
    // lowercase joiners became the split point -- so the old code returned a
    // fragment of the ingredients AS the body and threw the description away.
    // Two live rows did exactly this; verified this input reproduces it against
    // the pre-change function.
    const description = 'Egg cream is an all-in-one firming moisturizer that works as a serum and sleeping mask.';
    const caps = 'WATER, GLYCERIN, DIPROPYLENE GLYCOL, CETEARYL ALCOHOL, POLYGLYCERYL-2 DIPOLYHYDROXYSTEARATE, SODIUM STEAROYL GLUTAMATE, PANTHENOL, CHOLESTEROL, ';
    const tail = 'and LUMDI, TROMETHAMINE, FOLIC ACID, CHOLESTEROL, DISODIUM STEAROYL GLUTAMATE, PULLULAN, PANTHENOL.';
    const out = stripExternalSeedMarketingBannerPrefix(
      `${description} INGREDIENTS: ${caps.repeat(9)}${tail}`,
    );
    expect(out.startsWith('Egg cream is an all-in-one firming moisturizer')).toBe(true);
  });

  test('a surrogate pair split by the scan bound never reaches the output', () => {
    // The window is cut at a fixed number of code UNITS, so it can land inside a
    // surrogate pair. That is survivable only because the window is used for
    // ANALYSIS while the body is sliced from the full normalised string. These
    // inputs put a banner early (so a split really is taken) and a surrogate pair
    // astride code unit 1000 (so a window-sliced body would be cut through it and
    // emit a lone surrogate into the recall text).
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const banner = 'SHOP NOW FREE SHIPPING TODAY ONLY BIG SALE LIMITED EDITION ';
    for (const pad of [903, 904, 905]) {
      const text = `${banner}a hydrating gel cream for oily skin ${'y'.repeat(pad)}\u{1F48E} and it absorbs quickly leaving no residue.`;
      const out = stripExternalSeedMarketingBannerPrefix(text);
      // A split was genuinely taken, or this proves nothing.
      expect(out.startsWith('a hydrating gel cream')).toBe(true);
      expect(loneSurrogate.test(out)).toBe(false);
    }
  });

  // The regression that matters: this was O(n^2). A 52KB description cost ~2.4s
  // of synchronous work and blocked the event loop for seconds, which is what
  // emptied the aurora acne recall (measured 2026-09-09). The old code needs
  // ~40s for the input below, so this bound is not tight — it only has to fail
  // if the quadratic scan ever comes back.
  test('cost does not grow with the length of the text', () => {
    const text = 'Hydrating gel cream for oily skin with niacinamide and squalane. '.repeat(3200);
    expect(text.length).toBeGreaterThan(200000);
    const startedAt = Date.now();
    stripExternalSeedMarketingBannerPrefix(text);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  test('matches the pre-change function on every real description in the golden', () => {
    // The behaviour claim in the PR rests on this. Without the fixture in the
    // repo, "byte-identical on 51 real cases" was unverifiable from the PR.
    expect(golden.length).toBeGreaterThan(40);
    const mismatches = golden
      .filter((row) => stripExternalSeedMarketingBannerPrefix(row.input) !== row.expected)
      .map((row) => row.name);
    expect(mismatches).toEqual([]);
  });
});
