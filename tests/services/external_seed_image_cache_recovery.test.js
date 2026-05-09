const nock = require('nock');

const {
  recoverImageUrlsFromCanonicalPage,
} = require('../../src/services/externalSeedImageCache');

const FENTY_PRODUCT_URL = 'https://fentybeauty.com/products/test-product';
const TF_PRODUCT_URL = 'https://www.tomfordbeauty.com/products/fucking-fabulous-lip-color';


describe('recoverImageUrlsFromCanonicalPage', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  test('extracts og:image from typical Shopify-style HTML', async () => {
    const html = `
      <html><head>
        <meta property="og:image" content="https://cdn.shopify.com/s/files/1/x/y/files/new-image_2000x2000.png">
        <title>Test Product</title>
      </head></html>
    `;
    nock('https://fentybeauty.com').get('/products/test-product').reply(200, html, {
      'content-type': 'text/html',
    });

    const out = await recoverImageUrlsFromCanonicalPage(FENTY_PRODUCT_URL);
    expect(out).toContain('https://cdn.shopify.com/s/files/1/x/y/files/new-image_2000x2000.png');
  });

  test('extracts og:image when attribute order is reversed', async () => {
    // Some sites emit `<meta content="..." property="og:image">` instead.
    const html = `
      <html><head>
        <meta content="https://cdn.shopify.com/s/files/reversed.png" property="og:image">
      </head></html>
    `;
    nock('https://fentybeauty.com').get('/products/test-product').reply(200, html);
    const out = await recoverImageUrlsFromCanonicalPage(FENTY_PRODUCT_URL);
    expect(out).toContain('https://cdn.shopify.com/s/files/reversed.png');
  });

  test('extracts twitter:image as fallback when og:image is absent', async () => {
    const html = `
      <html><head>
        <meta name="twitter:image" content="https://cdn.shopify.com/s/files/twitter.png">
      </head></html>
    `;
    nock('https://fentybeauty.com').get('/products/test-product').reply(200, html);
    const out = await recoverImageUrlsFromCanonicalPage(FENTY_PRODUCT_URL);
    expect(out).toContain('https://cdn.shopify.com/s/files/twitter.png');
  });

  test('extracts schema.org Product.image string from JSON-LD', async () => {
    const html = `
      <html><head><script type="application/ld+json">
        {"@context":"https://schema.org","@type":"Product","name":"X","image":"https://cdn.shopify.com/s/files/jsonld-string.png"}
      </script></head></html>
    `;
    nock('https://www.tomfordbeauty.com').get('/products/fucking-fabulous-lip-color').reply(200, html);
    const out = await recoverImageUrlsFromCanonicalPage(TF_PRODUCT_URL);
    expect(out).toContain('https://cdn.shopify.com/s/files/jsonld-string.png');
  });

  test('extracts first image from schema.org Product.image array', async () => {
    const html = `
      <html><head><script type="application/ld+json">
        {"@type":"Product","image":["https://cdn.shopify.com/s/files/jsonld-array-1.png","https://cdn.shopify.com/s/files/jsonld-array-2.png"]}
      </script></head></html>
    `;
    nock('https://www.tomfordbeauty.com').get('/products/fucking-fabulous-lip-color').reply(200, html);
    const out = await recoverImageUrlsFromCanonicalPage(TF_PRODUCT_URL);
    expect(out).toContain('https://cdn.shopify.com/s/files/jsonld-array-1.png');
  });

  test('combines og:image + twitter:image + JSON-LD into a deduped list', async () => {
    const html = `
      <html><head>
        <meta property="og:image" content="https://cdn.shopify.com/s/files/og.png">
        <meta name="twitter:image" content="https://cdn.shopify.com/s/files/twitter.png">
        <script type="application/ld+json">
          {"@type":"Product","image":["https://cdn.shopify.com/s/files/jsonld.png","https://cdn.shopify.com/s/files/og.png"]}
        </script>
      </head></html>
    `;
    nock('https://fentybeauty.com').get('/products/test-product').reply(200, html);
    const out = await recoverImageUrlsFromCanonicalPage(FENTY_PRODUCT_URL);
    expect(out).toContain('https://cdn.shopify.com/s/files/og.png');
    expect(out).toContain('https://cdn.shopify.com/s/files/twitter.png');
    expect(out).toContain('https://cdn.shopify.com/s/files/jsonld.png');
    // Deduped: og.png appears in both og:image and JSON-LD array but only once in output
    const occurrences = out.filter((u) => u === 'https://cdn.shopify.com/s/files/og.png');
    expect(occurrences).toHaveLength(1);
  });

  test('returns empty list when canonical page 404s', async () => {
    nock('https://fentybeauty.com').get('/products/test-product').reply(404);
    const out = await recoverImageUrlsFromCanonicalPage(FENTY_PRODUCT_URL);
    expect(out).toEqual([]);
  });

  test('returns empty list when network request throws', async () => {
    nock('https://fentybeauty.com').get('/products/test-product').replyWithError('ENOTFOUND');
    const out = await recoverImageUrlsFromCanonicalPage(FENTY_PRODUCT_URL);
    expect(out).toEqual([]);
  });

  test('returns empty list when no recognized image patterns are present', async () => {
    const html = '<html><head><title>Boring page</title></head><body><p>No images here</p></body></html>';
    nock('https://fentybeauty.com').get('/products/test-product').reply(200, html);
    const out = await recoverImageUrlsFromCanonicalPage(FENTY_PRODUCT_URL);
    expect(out).toEqual([]);
  });

  test('returns empty list for invalid canonical URL inputs', async () => {
    expect(await recoverImageUrlsFromCanonicalPage('')).toEqual([]);
    expect(await recoverImageUrlsFromCanonicalPage(null)).toEqual([]);
    expect(await recoverImageUrlsFromCanonicalPage('not a url')).toEqual([]);
    expect(await recoverImageUrlsFromCanonicalPage('ftp://example.com/x')).toEqual([]);
  });

  test('drops malformed image URL values without crashing', async () => {
    // Some sites put empty / relative / data: URIs in og:image. The
    // recovery should skip those rather than emit invalid URLs.
    const html = `
      <html><head>
        <meta property="og:image" content="">
        <meta name="twitter:image" content="data:image/png;base64,iVBORw==">
        <script type="application/ld+json">
          {"@type":"Product","image":"https://cdn.shopify.com/s/files/valid.png"}
        </script>
      </head></html>
    `;
    nock('https://fentybeauty.com').get('/products/test-product').reply(200, html);
    const out = await recoverImageUrlsFromCanonicalPage(FENTY_PRODUCT_URL);
    expect(out).toEqual(['https://cdn.shopify.com/s/files/valid.png']);
  });
});
