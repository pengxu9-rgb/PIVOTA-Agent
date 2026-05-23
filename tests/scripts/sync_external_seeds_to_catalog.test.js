const {
  _internals: { inferCatalogMirrorCategory },
} = require('../../scripts/sync-external-seeds-to-catalog.cjs');

describe('sync-external-seeds-to-catalog category inference', () => {
  test('classifies mineral highlighters as makeup instead of generic beauty', () => {
    const category = inferCatalogMirrorCategory({
      title: 'King Kylie Loose Powder Highlighter',
      domain: 'kyliecosmetics.com',
      seed_data: {
        description:
          'A loose powder highlighter with a warm champagne shade and pearlescent glow.',
        snapshot: {},
      },
    });

    expect(category).toEqual({
      productType: 'Highlighter',
      category: 'Highlighter',
      categoryPath: 'beauty/makeup/cheek/highlighter',
    });
  });

  test('keeps lipstick-style products in lip makeup for canonical recall', () => {
    const category = inferCatalogMirrorCategory({
      title: 'Matte Liquid Lipstick',
      domain: 'kyliecosmetics.com',
      seed_data: {
        snapshot: {
          description: 'A long-wearing liquid lip color.',
        },
      },
    });

    expect(category).toEqual({
      productType: 'Lip Color',
      category: 'Lip Color',
      categoryPath: 'beauty/makeup/lip',
    });
  });
});
