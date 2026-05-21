const { titleCaseBrand, buildPdpPayload } = require('../src/pdpBuilder');

describe('titleCaseBrand', () => {
  test('Title-cases fully lowercase input', () => {
    expect(titleCaseBrand('fenty beauty')).toBe('Fenty Beauty');
    expect(titleCaseBrand('huda beauty')).toBe('Huda Beauty');
    expect(titleCaseBrand('rare beauty')).toBe('Rare Beauty');
  });

  test('Leaves already-cased input untouched', () => {
    expect(titleCaseBrand('Fenty Beauty')).toBe('Fenty Beauty');
    expect(titleCaseBrand('ColourPop')).toBe('ColourPop');
    expect(titleCaseBrand("L'Oréal Paris")).toBe("L'Oréal Paris");
  });

  test('Leaves all-uppercase input untouched (acronyms / stylized brands)', () => {
    expect(titleCaseBrand('NARS')).toBe('NARS');
    expect(titleCaseBrand('MAC')).toBe('MAC');
    expect(titleCaseBrand('GLAMGLOW')).toBe('GLAMGLOW');
  });

  test('Applies allow-list overrides for known mixed-case brands', () => {
    expect(titleCaseBrand('colourpop')).toBe('ColourPop');
    expect(titleCaseBrand('kvd beauty')).toBe('KVD Beauty');
    expect(titleCaseBrand('kvd vegan beauty')).toBe('KVD Vegan Beauty');
    expect(titleCaseBrand('mac')).toBe('MAC');
    expect(titleCaseBrand('nars')).toBe('NARS');
  });

  test('Handles whitespace and empty values', () => {
    expect(titleCaseBrand('')).toBe('');
    expect(titleCaseBrand(null)).toBe('');
    expect(titleCaseBrand(undefined)).toBe('');
    expect(titleCaseBrand('  fenty beauty  ')).toBe('Fenty Beauty');
  });

  test('Single-word lowercase input', () => {
    expect(titleCaseBrand('glossier')).toBe('Glossier');
    expect(titleCaseBrand('sephora')).toBe('Sephora');
  });
});

describe('buildPdpPayload integrates titleCaseBrand into product.brand', () => {
  test('upgrades a lowercase product.brand.name to Title Case', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_fenty_demo',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: "Fenty Skin Travel-Size Start'r Set",
        brand: { name: 'fenty beauty' },
        image_url: 'https://cdn.example.com/fenty-startr.jpg',
        price: 39.9,
        in_stock: true,
      },
    });
    expect(payload.product.brand).toEqual({ name: 'Fenty Beauty' });
  });

  test('preserves already-cased brand from upstream', () => {
    const payload = buildPdpPayload({
      product: {
        product_id: 'ext_nars_demo',
        merchant_id: 'external_seed',
        source: 'external_seed',
        title: 'NARS Blush',
        brand: { name: 'NARS' },
        image_url: 'https://cdn.example.com/nars-blush.jpg',
        price: 32,
        in_stock: true,
      },
    });
    expect(payload.product.brand).toEqual({ name: 'NARS' });
  });
});
