const {
  expandAnchorRefsWithGroupSiblings,
} = require('../src/auroraBff/productRelationshipGraph');

function makeQueryFn(siblingsByExt = {}) {
  // Responds to the sibling-expansion query: given anchor ext keys, returns all
  // siblings sharing a group.
  return jest.fn(async (sql, params) => {
    if (/product_group_members/.test(sql)) {
      const anchorKeys = Array.isArray(params?.[0]) ? params[0] : [];
      const siblings = new Set();
      for (const k of anchorKeys) {
        for (const s of (siblingsByExt[k] || [])) siblings.add(s);
      }
      return { rows: Array.from(siblings).map((sibling) => ({ sibling })) };
    }
    return { rows: [] };
  });
}

describe('expandAnchorRefsWithGroupSiblings', () => {
  test('adds sibling ext refs (product: and bare) for a grouped product', async () => {
    // ext_a is grouped with ext_b and ext_c
    const qFn = makeQueryFn({ ext_a: ['ext_a', 'ext_b', 'ext_c'] });
    const out = await expandAnchorRefsWithGroupSiblings(['product:ext_a', 'ext_a'], { queryFn: qFn });
    expect(out).toEqual(expect.arrayContaining([
      'product:ext_a', 'ext_a',
      'product:ext_b', 'ext_b',
      'product:ext_c', 'ext_c',
    ]));
  });

  test('non-primary listing now matches sibling-anchored edges', async () => {
    // user views ext_b; edges live on ext_a (the primary). Group: a,b,c
    const qFn = makeQueryFn({ ext_b: ['ext_a', 'ext_b', 'ext_c'] });
    const out = await expandAnchorRefsWithGroupSiblings(['product:ext_b'], { queryFn: qFn });
    expect(out).toContain('product:ext_a'); // ← the primary's anchor is now in the ref list
  });

  test('standalone product (no group) is a no-op', async () => {
    const qFn = makeQueryFn({}); // no siblings for anything
    const out = await expandAnchorRefsWithGroupSiblings(['product:ext_lonely'], { queryFn: qFn });
    expect(out).toEqual(['product:ext_lonely']);
  });

  test('no ext keys → no query, returns base refs unchanged', async () => {
    const qFn = jest.fn(async () => ({ rows: [] }));
    const out = await expandAnchorRefsWithGroupSiblings(['text:Glow:Serum', 'url:https://x'], { queryFn: qFn });
    expect(out).toEqual(['text:Glow:Serum', 'url:https://x']);
    expect(qFn).not.toHaveBeenCalled();
  });

  test('does not duplicate refs already present', async () => {
    const qFn = makeQueryFn({ ext_a: ['ext_a', 'ext_b'] });
    const out = await expandAnchorRefsWithGroupSiblings(['product:ext_a', 'product:ext_b'], { queryFn: qFn });
    const count = out.filter((r) => r === 'product:ext_b').length;
    expect(count).toBe(1);
  });

  test('missing product_group_members table → graceful no-op (serves base refs)', async () => {
    const qFn = jest.fn(async () => { const e = new Error('relation does not exist'); e.code = '42P01'; throw e; });
    const out = await expandAnchorRefsWithGroupSiblings(['product:ext_a'], { queryFn: qFn });
    expect(out).toEqual(['product:ext_a']);
  });

  test('non-recoverable DB error propagates', async () => {
    const qFn = jest.fn(async () => { const e = new Error('boom'); e.code = '57014'; throw e; });
    await expect(expandAnchorRefsWithGroupSiblings(['product:ext_a'], { queryFn: qFn })).rejects.toThrow();
  });
});
