'use strict';

const {
  stripExternalSeedMarketingBannerPrefix,
} = require('../src/services/externalSeedMarketingText');

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

  test('a long all-caps run with no lowercase body start is left whole', () => {
    // The body starts well past the scan window, so no boundary should be found
    // there and the text must come back whole.
    const text = `${'HYDRATION '.repeat(400)}extraordinarily hydrating gel cream for oily skin types.`;
    const out = stripExternalSeedMarketingBannerPrefix(text);
    expect(out.endsWith('extraordinarily hydrating gel cream for oily skin types.')).toBe(true);
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
});
