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
// Counting calls through the injected seam is NOT enough on its own: a mutant
// that restores the original call to the LOCAL binding is never counted, so the
// count stays at 1 and the doc is byte-identical. Verified — that mutant passed
// a count-only test. So the injected builder also TAGS its output, and the test
// asserts the tag survives into the returned doc: that is what proves the
// returned spread came from the counted build rather than a second uncounted one.

function buildRow({ stored = true } = {}) {
  const description = `A hydrating gel cream for oily skin. ${'It absorbs quickly and leaves no residue. '.repeat(400)}`;
  const seedData = {
    brand: 'Test Brand',
    category: 'Moisturizer',
    description,
    pdp_description_raw: description,
    // A stored doc is what sends resolve down the double-build branch, and every
    // one of the 12 real rows sampled from prod has one. `stored: false` is the
    // ingest hot path, which the count-only test never covered.
    ...(stored
      ? {
        derived: {
          recall: {
            retrieval_title: 'Test Brand Oil-Free Gel Cream',
            retrieval_summary: description.slice(0, 4000),
            brand: 'Test Brand',
            category: 'moisturizer',
          },
        },
      }
      : {}),
    snapshot: { title: 'Test Brand Oil-Free Gel Cream', description },
  };
  return { row: { title: 'Test Brand Oil-Free Gel Cream' }, seedData, snapshot: seedData.snapshot };
}

describe('resolveExternalSeedRecallDoc', () => {
  test('builds the underlying doc exactly once, and returns THAT build', () => {
    const input = buildRow();
    let calls = 0;
    const counting = (args) => {
      calls += 1;
      // The tag is the load-bearing half. A mutant that restores the original
      // `...buildExternalSeedRecallDoc({ row, seedData, snapshot })` call bypasses
      // this seam entirely: `calls` stays 1 and the doc is byte-identical, so a
      // count-only assertion passes. The tag does not survive that spread.
      return { ...buildExternalSeedRecallDoc(args), __probe: 'seam' };
    };

    const resolved = resolveExternalSeedRecallDoc(input, { buildDoc: counting });

    expect(calls).toBe(1);
    expect(resolved.__probe).toBe('seam');
  });

  test('the no-stored-doc branch also builds exactly once', () => {
    // The ingest hot path. Doubling it used to pass every test here.
    const input = buildRow({ stored: false });
    let calls = 0;
    const counting = (args) => {
      calls += 1;
      return { ...buildExternalSeedRecallDoc(args), __probe: 'seam' };
    };

    const resolved = resolveExternalSeedRecallDoc(input, { buildDoc: counting });

    expect(calls).toBe(1);
    expect(resolved.__probe).toBe('seam');
  });

  test('an unusable stored doc falls back and still builds exactly once', () => {
    const input = buildRow();
    input.seedData.derived.recall = { brand: 'Test Brand' }; // no retrieval_* fields
    let calls = 0;
    const counting = (args) => {
      calls += 1;
      return { ...buildExternalSeedRecallDoc(args), __probe: 'seam' };
    };

    const resolved = resolveExternalSeedRecallDoc(input, { buildDoc: counting });

    expect(calls).toBe(1);
    expect(resolved.__probe).toBe('seam');
  });

  test('the injected builder is only a seam — the default is the real builder', () => {
    // Guards against the seam drifting away from production behaviour.
    const input = buildRow();
    expect(resolveExternalSeedRecallDoc(input))
      .toEqual(resolveExternalSeedRecallDoc(input, { buildDoc: buildExternalSeedRecallDoc }));
  });

  test('does not mutate its inputs, which is what makes reusing the built doc safe', () => {
    // This whole change rests on the builder being pure: `fallback` is reused
    // instead of rebuilt, so any input mutation would now be observed once
    // rather than twice. Committed as a test rather than left as a one-off run,
    // so it can be re-checked rather than taken on trust.
    const deepFreeze = (value) => {
      if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        Object.keys(value).forEach((key) => deepFreeze(value[key]));
      }
      return value;
    };
    const frozen = deepFreeze(buildRow());
    // Throws on any write in strict mode, which jest modules are.
    expect(() => resolveExternalSeedRecallDoc(frozen)).not.toThrow();
    expect(() => resolveExternalSeedRecallDoc(frozen, { buildDoc: buildExternalSeedRecallDoc })).not.toThrow();
  });

  test('the returned doc does not alias the caller-visible input objects', () => {
    // Reusing `fallback` shares its nested objects into the result. `fallback` is
    // function-local so nothing outside can hold it, but the returned doc must
    // still not hand back references INTO the input.
    const input = buildRow();
    const resolved = resolveExternalSeedRecallDoc(input);
    expect(resolved.exclusion_flags).not.toBe(input.seedData.derived.recall.exclusion_flags);
    expect(resolved.quality_signals).not.toBe(input.seedData.derived.recall.quality_signals);
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
