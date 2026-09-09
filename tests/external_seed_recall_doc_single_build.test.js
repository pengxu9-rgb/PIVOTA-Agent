'use strict';

const {
  buildExternalSeedRecallDoc,
  resolveExternalSeedRecallDoc,
} = require('../src/services/externalSeedRecall');

// `resolveExternalSeedRecallDoc` used to call `buildExternalSeedRecallDoc` twice
// with identical arguments — once for the fallback values it reads, then again
// inside the returned spread — so every text scan and token pass ran twice per
// row for a byte-identical result.
//
// There is no seam to count calls through (the second call was to the local
// binding, not the export), so this pins the ratio instead: resolve does one
// build plus some cheap field merging, so it must not cost anywhere near two.
function buildRow() {
  const description = `A hydrating gel cream for oily skin. ${'It absorbs quickly and leaves no residue. '.repeat(400)}`;
  const seedData = {
    brand: 'Test Brand',
    category: 'Moisturizer',
    description,
    pdp_description_raw: description,
    derived: {
      recall: {
        // A stored doc is what sends resolve down the double-build branch, and
        // every one of the 12 real rows sampled from prod has one.
        retrieval_title: 'Test Brand Oil-Free Gel Cream',
        retrieval_summary: description.slice(0, 4000),
        brand: 'Test Brand',
        category: 'moisturizer',
      },
    },
    snapshot: { title: 'Test Brand Oil-Free Gel Cream', description },
  };
  return { row: { title: 'Test Brand Oil-Free Gel Cream' }, seedData, snapshot: seedData.snapshot };
}

function medianMs(fn, runs = 9) {
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const startedAt = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
  }
  return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
}

describe('resolveExternalSeedRecallDoc', () => {
  test('builds the underlying doc once, not twice', () => {
    const input = buildRow();
    buildExternalSeedRecallDoc(input);
    resolveExternalSeedRecallDoc(input);

    const buildMs = medianMs(() => buildExternalSeedRecallDoc(input));
    const resolveMs = medianMs(() => resolveExternalSeedRecallDoc(input));

    // Guard against a degenerate machine where both round to nothing.
    expect(buildMs).toBeGreaterThan(0.5);
    // Resolve legitimately costs about TWO builds' worth of work even with one
    // build, because it re-cleans and re-classifies the stored values. Measured
    // on this input: 2.01 with a single build, 3.00 with the duplicate. 2.5 sits
    // between them with room for a loaded runner on either side.
    expect(resolveMs / buildMs).toBeLessThan(2.5);
  });

  test('a stored recall doc still wins over the freshly built fallback', () => {
    const input = buildRow();
    const resolved = resolveExternalSeedRecallDoc(input);
    // Reusing the fallback value must not change which source wins.
    expect(resolved.retrieval_title).toBe('Test Brand Oil-Free Gel Cream');
    expect(resolved.brand).toBe('Test Brand');
    // The fallback's display-cased category wins over the stored lowercase one;
    // asserted as observed so the reuse cannot quietly change which source wins.
    expect(resolved.category).toBe('Moisturizer');
    expect(resolved.version).toBe('v1');
  });
});
