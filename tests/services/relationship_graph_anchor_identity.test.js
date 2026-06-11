// Anchor-identity hydration for the relationship-graph read path: resolves a queried product to its
// full identity set (sig + grouped source ids) so get_alternatives matches sig-keyed AND source-keyed
// edges. Covers the make-or-break sig-ref string form, member arrays, no-regression, flag-off, fail-open.

describe('relationship-graph anchor-identity hydration', () => {
  const ORIGINAL_ENV = process.env;
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.resetModules();
  });

  describe('buildAnchorRefsFromProduct (additive sig/member refs)', () => {
    const { buildAnchorRefsFromProduct } = require('../../src/auroraBff/productRelationshipGraph');

    test('emits product:sig_<hash> from a pivota_signature_id WITHOUT double-prefixing sig_', () => {
      const refs = buildAnchorRefsFromProduct({ product_id: 'ulta:abc', pivota_signature_id: 'sig_xyz' });
      const lower = refs.map((r) => r.toLowerCase());
      // make-or-break: the value already carries sig_, so the ref is product:sig_xyz (NOT product:sig_sig_xyz)
      expect(lower).toContain('product:sig_xyz');
      expect(lower).toContain('sig_xyz');
      expect(lower).not.toContain('product:sig_sig_xyz');
      // source id still present
      expect(lower).toContain('product:ulta:abc');
    });

    test('emits refs for every member_sig_id and member_source_id', () => {
      const refs = buildAnchorRefsFromProduct({
        product_id: 'ulta:abc',
        member_sig_ids: ['sig_one', 'sig_two'],
        member_source_ids: ['ext_w', 'ulta:abc'],
      });
      const lower = refs.map((r) => r.toLowerCase());
      expect(lower).toEqual(expect.arrayContaining(['product:sig_one', 'product:sig_two', 'product:ext_w']));
    });

    test('NO REGRESSION: a thin anchor (no sig) yields the same source refs and no sig refs', () => {
      const refs = buildAnchorRefsFromProduct({ product_id: 'ext_a', merchant_id: 'external_seed' });
      const lower = refs.map((r) => r.toLowerCase());
      expect(lower).toContain('product:ext_a');
      expect(lower).toContain('ext_a');
      expect(lower.some((r) => r.includes('sig_'))).toBe(false);
      expect(lower.some((r) => r.startsWith('product:pg_'))).toBe(false);
    });

    test('emits product:<canonical_entity_id> (pg_*) when present — the stable canonical anchor', () => {
      const refs = buildAnchorRefsFromProduct({ product_id: 'ulta:abc', canonical_entity_id: 'pg_catalog_123' });
      const lower = refs.map((r) => r.toLowerCase());
      expect(lower).toContain('product:pg_catalog_123');
      expect(lower).toContain('pg_catalog_123');
      // value already prefixed (pg_) — pushed raw, not double-prefixed
      expect(lower).not.toContain('product:pg_pg_catalog_123');
    });

    test('NO REGRESSION: no canonical_entity_id => no pg_ ref', () => {
      const refs = buildAnchorRefsFromProduct({ product_id: 'ext_a' });
      expect(refs.map((r) => r.toLowerCase()).some((r) => r.startsWith('product:pg_'))).toBe(false);
    });
  });

  describe('isAnchorIdentityHydrationEnabled', () => {
    test('only true when flag === "true"', () => {
      const { isAnchorIdentityHydrationEnabled } = require('../../src/services/catalogEntityResolution');
      expect(isAnchorIdentityHydrationEnabled({})).toBe(false);
      expect(isAnchorIdentityHydrationEnabled({ AURORA_BFF_RELATIONSHIP_GRAPH_ANCHOR_IDENTITY_HYDRATION_ENABLED: 'false' })).toBe(false);
      expect(isAnchorIdentityHydrationEnabled({ AURORA_BFF_RELATIONSHIP_GRAPH_ANCHOR_IDENTITY_HYDRATION_ENABLED: 'true' })).toBe(true);
    });
  });

  describe('applyAnchorIdentity', () => {
    test('merges identity onto a COPY (never mutates input)', () => {
      const { applyAnchorIdentity } = require('../../src/services/catalogEntityResolution');
      const anchor = { product_id: 'ulta:abc', merchant_id: null };
      const out = applyAnchorIdentity(anchor, {
        pivota_signature_id: 'sig_xyz',
        member_sig_ids: ['sig_xyz'],
        member_source_ids: ['ext_w'],
        canonical_entity_id: 'pg_catalog_123',
        brand: 'Naturium',
        title: 'Glycolic Acid',
        canonical_url: 'https://x',
      });
      expect(out).not.toBe(anchor);
      expect(anchor.pivota_signature_id).toBeUndefined(); // input untouched
      expect(out.pivota_signature_id).toBe('sig_xyz');
      expect(out.member_sig_ids).toEqual(['sig_xyz']);
      expect(out.member_source_ids).toEqual(['ext_w']);
      expect(out.canonical_entity_id).toBe('pg_catalog_123');
    });

    test('null identity is a no-op (returns input)', () => {
      const { applyAnchorIdentity } = require('../../src/services/catalogEntityResolution');
      const anchor = { product_id: 'ext_a' };
      expect(applyAnchorIdentity(anchor, null)).toBe(anchor);
    });
  });

  describe('resolveAnchorIdentityForRelationshipGraph', () => {
    test('flag-off: returns null and does ZERO db work (queryFn not called)', async () => {
      process.env = { ...ORIGINAL_ENV, DATABASE_URL: 'postgres://test' };
      const { resolveAnchorIdentityForRelationshipGraph } = require('../../src/services/catalogEntityResolution');
      const queryFn = jest.fn();
      const out = await resolveAnchorIdentityForRelationshipGraph({ product_id: 'ulta:abc', queryFn });
      expect(out).toBeNull();
      expect(queryFn).not.toHaveBeenCalled();
    });

    test('flag-on: resolves a ulta: product to its full sig + source id set', async () => {
      process.env = {
        ...ORIGINAL_ENV,
        DATABASE_URL: 'postgres://test',
        AURORA_BFF_RELATIONSHIP_GRAPH_ANCHOR_IDENTITY_HYDRATION_ENABLED: 'true',
      };
      const { resolveAnchorIdentityForRelationshipGraph } = require('../../src/services/catalogEntityResolution');
      const queryFn = jest.fn(async () => ({
        rows: [
          { content_key: 'ck', product_key: 'prod::external_seed::external_seed::ext_w', merchant_id: 'external_seed',
            platform: 'external_seed', source_product_id: 'ext_w', product_title: 'Glycolic Acid', brand: 'Naturium',
            pivota_signature_id: 'sig_primary', internal_product_group_id: 'pg_a', is_primary: true, offer_count: 1,
            pdp_lifecycle_stage: 'published', canonical_url: 'https://x' },
          { content_key: 'ck', product_key: 'prod::external_seed::external_seed::ulta:abc', merchant_id: 'external_seed',
            platform: 'external_seed', source_product_id: 'ulta:abc', product_title: 'Glycolic Acid', brand: 'Naturium',
            pivota_signature_id: 'sig_member', internal_product_group_id: 'pg_a', is_primary: false, offer_count: 1,
            pdp_lifecycle_stage: 'validated' },
        ],
      }));
      const out = await resolveAnchorIdentityForRelationshipGraph({ product_id: 'ulta:abc', merchant_id: null, queryFn });
      expect(queryFn).toHaveBeenCalled();
      expect(out.pivota_signature_id).toBe('sig_primary');
      // full member set (drift-safe: non-primary listing still gets the canonical + its own sig)
      expect(out.member_sig_ids).toEqual(expect.arrayContaining(['sig_primary', 'sig_member']));
      expect(out.member_source_ids).toEqual(expect.arrayContaining(['ext_w', 'ulta:abc']));
      // stable canonical id = the content-derived product group id (survives primary flips)
      expect(out.canonical_entity_id).toBe('pg_a');
    });

    test('flag-on: malformed canonical_entity_id (pg:auto:...) is filtered to null', async () => {
      process.env = {
        ...ORIGINAL_ENV,
        DATABASE_URL: 'postgres://test',
        AURORA_BFF_RELATIONSHIP_GRAPH_ANCHOR_IDENTITY_HYDRATION_ENABLED: 'true',
      };
      const { resolveAnchorIdentityForRelationshipGraph } = require('../../src/services/catalogEntityResolution');
      const queryFn = jest.fn(async () => ({
        rows: [
          { content_key: 'ck', product_key: 'prod::external_seed::external_seed::ext_w', merchant_id: 'external_seed',
            platform: 'external_seed', source_product_id: 'ext_w', product_title: 'X', brand: 'B',
            pivota_signature_id: 'sig_primary', internal_product_group_id: 'pg:auto:title:v1:b::x', is_primary: true,
            offer_count: 1, pdp_lifecycle_stage: 'published' },
        ],
      }));
      const out = await resolveAnchorIdentityForRelationshipGraph({ product_id: 'ext_w', queryFn });
      // canonical_entity_id falls back to a malformed pg:auto family => must NOT be emitted as a ref
      expect(out.canonical_entity_id).toBeNull();
    });

    test('fail-open: returns null when the resolver throws (no throw to caller)', async () => {
      process.env = {
        ...ORIGINAL_ENV,
        DATABASE_URL: 'postgres://test',
        AURORA_BFF_RELATIONSHIP_GRAPH_ANCHOR_IDENTITY_HYDRATION_ENABLED: 'true',
      };
      const { resolveAnchorIdentityForRelationshipGraph } = require('../../src/services/catalogEntityResolution');
      const queryFn = jest.fn(async () => {
        throw new Error('connection terminated unexpectedly');
      });
      await expect(
        resolveAnchorIdentityForRelationshipGraph({ product_id: 'ulta:abc', queryFn }),
      ).resolves.toBeNull();
    });
  });
});
