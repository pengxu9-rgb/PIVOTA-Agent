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
            // Present so the aliasing walk has real input nodes to find in the
            // output; without them the old comparison was `(object) !== undefined`.
            exclusion_flags: { gift_card: false },
            quality_signals: { template_polluted: false },
            ingredient_tokens: 'niacinamide squalane',
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
    // Clone-compare, NOT `expect(...).not.toThrow()` on a frozen input. This
    // module is non-strict CJS, so writes to a frozen object silently no-op
    // instead of throwing — verified: a planted `seedData.__planted = true`
    // passed the frozen-input version of this test.
    const input = buildRow();
    const before = JSON.parse(JSON.stringify(input));
    resolveExternalSeedRecallDoc(input);
    resolveExternalSeedRecallDoc(input, { buildDoc: buildExternalSeedRecallDoc });
    expect(JSON.parse(JSON.stringify(input))).toEqual(before);
  });

  test('builds exactly once even counting through paths the seam cannot see', () => {
    // Belt-and-braces beside the tag test, and it needs no production seam: a
    // counting getter on a field the builder reads exactly once and resolve's
    // stored-doc branch never reads. The tag proves the RETURNED doc came from
    // the counted build; this proves no build happened anywhere at all, through
    // the seam or around it.
    const input = buildRow();
    let builds = 0;
    Object.defineProperty(input.seedData, 'seed_description_origin', {
      get() {
        builds += 1;
        return 'crawl';
      },
      enumerable: true,
      configurable: true,
    });

    resolveExternalSeedRecallDoc(input);

    expect(builds).toBe(1);
  });

  test('the returned doc shares no object with the inputs', () => {
    // The previous version compared two fields the fixture never set, so both
    // sides were `undefined` and it reduced to `(object) !== undefined`. A live
    // reference INTO the input passed it. This walks both graphs instead.
    const collectNodes = (value, seen = new Set()) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return seen;
      seen.add(value);
      Object.values(value).forEach((child) => collectNodes(child, seen));
      return seen;
    };

    const input = buildRow();
    const inputNodes = collectNodes(input);
    const resolved = resolveExternalSeedRecallDoc(input);

    const shared = [];
    const walk = (value, path, seen = new Set()) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (inputNodes.has(value)) shared.push(path);
      Object.entries(value).forEach(([key, child]) => walk(child, `${path}.${key}`, seen));
    };
    walk(resolved, 'resolved');

    expect(shared).toEqual([]);
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
