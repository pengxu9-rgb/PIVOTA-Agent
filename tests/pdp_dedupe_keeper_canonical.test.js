jest.mock('../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(),
}));

jest.mock('../src/services/catalogEntityResolution', () => ({
  resolveCanonicalCatalogEntityGroup: jest.fn(),
}));

const ORIGINAL_ENV = process.env;

function loadServer(envOverrides = {}) {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: '',
    PIVOTA_API_KEY: '',
    ...envOverrides,
  };
  const db = require('../src/db');
  db.query.mockReset();
  const app = require('../src/server');
  return { app, debug: app._debug, db };
}

const MIRROR_SIG = 'sig_896c979cc15718bbcba72421cc34b067';
const KEEPER_SIG = 'sig_31e1e9fb2325ed7293a6fe71339d0b18';

function mirrorProduct(overrides = {}) {
  return {
    id: 'merit:7dde4d5c44aa57ba',
    product_id: 'merit:7dde4d5c44aa57ba',
    source_product_id: 'merit:7dde4d5c44aa57ba',
    title: 'The Color Duo',
    destination_url: 'https://meritbeauty.com/products/the-color-duo',
    ...overrides,
  };
}

// Regression guard for the 431 tombstoned step-5 dedupe losers measured in
// prod on 2026-07-25. Each one renders HTTP 200 and, before this change,
// declared ITSELF canonical — up to 6 self-canonical duplicate 200s for a
// single product, splitting its index equity. The row layer had already
// elected a keeper (suppression_metadata.keeper_product_key, minted row,
// 431/431); the render layer just never read it.
describe('dedupe-keeper canonical on tombstoned mirror PDPs', () => {
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('keeper sig moves rel=canonical without moving the page URL', () => {
    const { debug } = loadServer();

    const out = debug.applyRequestedPivotaSignatureToPdpProduct(
      mirrorProduct(),
      MIRROR_SIG,
      'merit:7dde4d5c44aa57ba',
      '',
      KEEPER_SIG,
    );

    // Canonical consolidates onto the keeper...
    expect(out.canonical_url).toBe(`https://agent.pivota.cc/products/${KEEPER_SIG}`);
    expect(out.pivota_canonical_url).toBe(`https://agent.pivota.cc/products/${KEEPER_SIG}`);
    expect(out.canonical_route_basis).toBe('dedupe_keeper');
    expect(out.canonical_route_sig_id).toBe(KEEPER_SIG);

    // ...while the page keeps its own identity and its own URL. Moving `id`
    // or `url` here would change which variant preselects and which URL the
    // sitemap's incumbency pick still points at — neither is this step's job.
    expect(out.id).toBe(MIRROR_SIG);
    expect(out.product_id).toBe(MIRROR_SIG);
    expect(out.url).toBe(`https://agent.pivota.cc/products/${MIRROR_SIG}`);
  });

  test('no keeper sig leaves the row self-canonical (untombstoned default)', () => {
    const { debug } = loadServer();

    const out = debug.applyRequestedPivotaSignatureToPdpProduct(
      mirrorProduct(),
      KEEPER_SIG,
      'merit:7dde4d5c44aa57ba',
      '',
      '',
    );

    expect(out.canonical_url).toBe(`https://agent.pivota.cc/products/${KEEPER_SIG}`);
    expect(out.url).toBe(`https://agent.pivota.cc/products/${KEEPER_SIG}`);
    expect(out.canonical_route_basis).toBeUndefined();
    expect(out.canonical_route_sig_id).toBeUndefined();
  });

  test('a keeper sig equal to the requested sig is a no-op, not a self-loop', () => {
    const { debug } = loadServer();

    const out = debug.applyRequestedPivotaSignatureToPdpProduct(
      mirrorProduct(),
      KEEPER_SIG,
      'merit:7dde4d5c44aa57ba',
      '',
      KEEPER_SIG,
    );

    expect(out.canonical_url).toBe(`https://agent.pivota.cc/products/${KEEPER_SIG}`);
    expect(out.canonical_route_basis).toBeUndefined();
  });

  test('a malformed keeper value never reaches the canonical tag', () => {
    const { debug } = loadServer();

    for (const bad of ['ck_57491440e9dd53a3e9d526b06afa0283', 'not-a-sig', '   ', null]) {
      const out = debug.applyRequestedPivotaSignatureToPdpProduct(
        mirrorProduct(),
        MIRROR_SIG,
        'merit:7dde4d5c44aa57ba',
        '',
        bad,
      );
      // A bare content_key 500s on /products/ — it must never be advertised.
      expect(out.canonical_url).toBe(`https://agent.pivota.cc/products/${MIRROR_SIG}`);
      expect(out.canonical_route_basis).toBeUndefined();
    }
  });

  test('canonical_entity_id public emit keeps precedence over the keeper', () => {
    const { debug } = loadServer({
      CANONICAL_ENTITY_ID_PUBLIC_EMIT_ENABLED: 'true',
    });

    const entityId = 'cent_0123456789abcdef';
    const out = debug.applyRequestedPivotaSignatureToPdpProduct(
      mirrorProduct(),
      MIRROR_SIG,
      'merit:7dde4d5c44aa57ba',
      entityId,
      KEEPER_SIG,
    );

    // The entity-id path already publishes a stronger cross-row canonical;
    // stacking the keeper on top would silently change what it emits.
    expect(out.canonical_url).toBe(`https://agent.pivota.cc/products/${entityId}`);
    expect(out.canonical_route_basis).toBeUndefined();
  });
});
