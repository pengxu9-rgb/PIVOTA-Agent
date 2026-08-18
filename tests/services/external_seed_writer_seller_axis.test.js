// ADR-009 — the WRITER side of the seed lane.
//
// Every ADR-009 test so far pins a READER: some branch that compares a seller
// against the retired sentinel. This one pins the two places the seed lane
// used to MINT that seller, which no reader test and no literal ratchet could
// see. Both are the same defect in different clothes: sourcing information
// ("we discovered this by crawling") written into the seller field.
//
// Both changes under test are inert on today's data — that is precisely why
// they need mock-driven tests. A fixture that only asserted the observable
// output would pass identically before and after, and would pin nothing.

const path = require('path');

const PRODUCTS_MODULE = path.join(__dirname, '../../src/services/externalSeedProducts');
const AUTHORITY_MODULE = path.join(__dirname, '../../src/services/pdpIngredientAuthority');
const DETAIL_MODULE = path.join(__dirname, '../../src/services/externalSeedDetail');

// Wrap, don't replace: the real authority implementation still runs, so the
// captured argument is the genuine call and every downstream assertion below
// is about real behaviour rather than a stub's.
jest.mock(AUTHORITY_MODULE, () => {
  const actual = jest.requireActual(
    require('path').join(__dirname, '../../src/services/pdpIngredientAuthority'),
  );
  return {
    ...actual,
    buildAuthoritativeIngredientView: jest.fn((...args) =>
      actual.buildAuthoritativeIngredientView(...args),
    ),
  };
});

const { buildAuthoritativeIngredientView } = require(AUTHORITY_MODULE);
const actualAuthority = jest.requireActual(AUTHORITY_MODULE);
const { buildExternalSeedProduct } = require(PRODUCTS_MODULE);

const SERUM_SEED_ROW = {
  id: 'eps_writer_axis_1',
  external_product_id: 'ext_writer_axis_1',
  canonical_url: 'https://brand.example/products/barrier-serum',
  destination_url: 'https://brand.example/products/barrier-serum',
  domain: 'brand.example',
  title: 'Barrier Repair Serum',
  price_amount: 32,
  price_currency: 'USD',
  availability: 'in stock',
  seed_data: {
    category: 'skincare',
    raw_ingredient_text_clean: 'Water, Glycerin, Niacinamide, Panthenol, Ceramide NP.',
    ingredient_intel: {
      raw_ingredient_text_clean: 'Water, Glycerin, Niacinamide, Panthenol, Ceramide NP.',
      inci_list: 'Water, Glycerin, Niacinamide, Panthenol, Ceramide NP',
    },
    snapshot: {
      title: 'Barrier Repair Serum',
      canonical_url: 'https://brand.example/products/barrier-serum',
    },
  },
};

describe('ADR-009 writer side: buildExternalSeedProduct does not fabricate a seller for the ingredient authority', () => {
  beforeEach(() => {
    buildAuthoritativeIngredientView.mockClear();
  });

  test('the ingredient-authority input carries no seller axis at all', () => {
    const product = buildExternalSeedProduct(SERUM_SEED_ROW);

    // CONJUNCT PROOF, not an afterthought: an absence assertion is worthless if
    // the branch never ran. Pin that the authority was actually consulted for
    // THIS fixture before asking what it was handed.
    expect(buildAuthoritativeIngredientView).toHaveBeenCalledTimes(1);
    const [authorityInput] = buildAuthoritativeIngredientView.mock.calls[0];
    expect(authorityInput.product_id).toBe('ext_writer_axis_1');
    expect(authorityInput.title).toBe('Barrier Repair Serum');

    // The assertion under test.
    expect(Object.prototype.hasOwnProperty.call(authorityInput, 'merchant_id')).toBe(false);
    expect(authorityInput.merchant_id).toBeUndefined();

    // CONTROL 1 — the sentinel is still perfectly producible in this fixture.
    // Without this, the absence above would also pass if the constant had been
    // renamed, deleted, or spelled differently everywhere.
    expect(product.merchant_id).toBe('external_seed');

    // CONTROL 2 — the SOURCING axis is deliberately kept. ADR-009 removes the
    // seller conflation, not the lane label, and this is the field the
    // ingredient module's seed detector actually reads.
    expect(authorityInput.source).toBe('external_seed');
  });

  test('dropping the seller axis is inert for the only consumer that reads it', () => {
    buildExternalSeedProduct(SERUM_SEED_ROW);
    const [authorityInput] = buildAuthoritativeIngredientView.mock.calls[0];

    // The seller axis reaches exactly one reader inside the authority module,
    // and this proves that reader's verdict is byte-identical with and without
    // it — i.e. the removal cannot have blinded the seed detector.
    //
    // Both operands are CONSTRUCTED here rather than taken as captured. Reusing
    // the captured object for the "without" side would make this test compare
    // an object to itself the moment the seller came back, which is exactly the
    // shape of a test that passes for an unrelated reason.
    const strippedOfSeller = { ...authorityInput };
    delete strippedOfSeller.merchant_id;
    const withSentinelSeller = { ...authorityInput, merchant_id: 'external_seed' };

    // The two operands genuinely differ on the axis under test.
    expect(Object.prototype.hasOwnProperty.call(strippedOfSeller, 'merchant_id')).toBe(false);
    expect(withSentinelSeller.merchant_id).toBe('external_seed');

    // Pinning the timestamp is what makes the two records comparable at all.
    const generatedAt = '2026-08-18T00:00:00.000Z';
    const withoutSellerView = actualAuthority.buildAuthoritativeIngredientView(strippedOfSeller, {
      generatedAt,
    });
    const withSellerView = actualAuthority.buildAuthoritativeIngredientView(withSentinelSeller, {
      generatedAt,
    });

    expect(withoutSellerView).toEqual(withSellerView);

    // CONTROL — the comparison above must not be two empty objects agreeing
    // with each other. Prove the authority actually resolved this fixture.
    expect(withoutSellerView.items.length).toBeGreaterThan(0);
  });
});

describe('ADR-009 writer side: the seed detail lane passes the seller through instead of re-minting it', () => {
  const loadDetailWithBuilder = (buildImpl) => {
    let mod;
    jest.isolateModules(() => {
      jest.doMock(PRODUCTS_MODULE, () => {
        const actual = jest.requireActual(PRODUCTS_MODULE);
        return { ...actual, buildExternalSeedProduct: buildImpl };
      });
      mod = require(DETAIL_MODULE);
    });
    return mod;
  };

  afterEach(() => {
    jest.dontMock(PRODUCTS_MODULE);
    jest.resetModules();
  });

  const DETAIL_ROW = { id: 'eps_detail_axis_1', market: 'US', tool: 'creator_agents' };

  test('an observed seller decided by the builder survives materialization', () => {
    // The row-level fix A9-4 already applied to the data: seed supply lives
    // under a per-brand observed seller. If the builder ever learns to read it,
    // this lane must not quietly stamp the retired sentinel back on top.
    const { materializeExternalSeedProduct } = loadDetailWithBuilder(() => ({
      product_id: 'ext_detail_axis_1',
      merchant_id: 'merch_obs_brandexample',
      market: 'JP',
      tool: 'legacy_tool',
    }));

    const product = materializeExternalSeedProduct(DETAIL_ROW);

    expect(product.merchant_id).toBe('merch_obs_brandexample');

    // CONJUNCT PROOF: the pass-through above would also be satisfied if this
    // function had degenerated into an identity that overrides nothing. Pin,
    // in the SAME fixture, that the columns this lane genuinely owns are still
    // layered over the builder's values — so the seller is the one field it
    // stopped claiming, not the only field it ever touched.
    expect(product.market).toBe('US');
    expect(product.tool).toBe('creator_agents');
    expect(product.external_seed_id).toBe('eps_detail_axis_1');
  });

  test('CONTROL: the sentinel still flows through when the builder is the one producing it', () => {
    const { materializeExternalSeedProduct } = loadDetailWithBuilder(() => ({
      product_id: 'ext_detail_axis_1',
      merchant_id: 'external_seed',
    }));

    // Paired with the test above: together they show materialization reports
    // whatever the single producer decided, rather than dropping the field or
    // hardcoding either answer.
    expect(materializeExternalSeedProduct(DETAIL_ROW).merchant_id).toBe('external_seed');
  });
});
