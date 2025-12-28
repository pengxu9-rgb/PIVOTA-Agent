const express = require('express');
const request = require('supertest');
const nock = require('nock');

const { canonicalizeUrl, stableOfferIdFromCanonicalUrl } = require('../../src/layer3/external/urlUtils');
const { resolveExternalOffer } = require('../../src/layer3/external/externalOfferResolver');
const { mountExternalOfferRoutes } = require('../../src/layer3/routes/externalOffers');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountExternalOfferRoutes(app);
  return app;
}

describe('Layer3 external offers', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Note: we intentionally do not disable all network in this suite because
    // supertest(app) spins up an ephemeral localhost listener under the hood.
    process.env = { ...originalEnv };
    delete process.env.DATABASE_URL;
    process.env.EXTERNAL_OFFER_ALLOWED_DOMAINS_US = 'example.com';
    process.env.EXTERNAL_OFFER_ALLOWED_DOMAINS_JP = 'example.jp';
  });

  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('canonicalizeUrl strips tracking params and stabilizes offerId', () => {
    const input = new URL('https://Example.com/product?id=123&utm_source=newsletter&fbclid=abc#frag');
    const canonical = canonicalizeUrl(input);
    expect(canonical).toBe('https://example.com/product?id=123');
    expect(stableOfferIdFromCanonicalUrl(canonical)).toMatch(/^offer_[a-f0-9]{24}$/);
  });

  test('resolveExternalOffer parses JSON-LD product name + price (prefers JSON-LD over OG)', async () => {
    const rawUrl = 'https://example.com/product?id=123&utm_campaign=abc';
    const canonical = 'https://example.com/product?id=123';

    const html = `
      <html><head>
        <meta property="og:title" content="OG Title"/>
        <meta property="og:image" content="https://cdn.example.com/og.png"/>
        <meta property="product:price:amount" content="19.99"/>
        <meta property="product:price:currency" content="USD"/>
        <script type="application/ld+json">
          {
            "@context":"https://schema.org",
            "@type":"Product",
            "name":"JSONLD Title",
            "image":"https://cdn.example.com/jsonld.png",
            "offers": {
              "@type":"Offer",
              "price":"12.34",
              "priceCurrency":"USD",
              "availability":"http://schema.org/InStock"
            }
          }
        </script>
      </head><body></body></html>
    `;

    const scope = nock('https://example.com').get('/product').query({ id: '123' }).reply(200, html);

    const offer = await resolveExternalOffer({ url: rawUrl, market: 'US', locale: 'en-US' });
    expect(offer.canonicalUrl).toBe(canonical);
    expect(offer.domain).toBe('example.com');
    expect(offer.title).toBe('JSONLD Title');
    expect(offer.imageUrl).toBe('https://cdn.example.com/jsonld.png');
    expect(offer.price).toEqual({ amount: 12.34, currency: 'USD' });
    expect(offer.availability).toBe('in_stock');
    expect(offer.offerId).toBe(stableOfferIdFromCanonicalUrl(canonical));
    expect(scope.isDone()).toBe(true);
  });

  test('resolveExternalOffer uses in-memory cache for repeated calls', async () => {
    const url = 'https://example.com/product?id=999&utm_source=x';
    const canonical = 'https://example.com/product?id=999';
    const html = `<html><head><meta property="og:title" content="Cache Test"/></head></html>`;

    const scope = nock('https://example.com').get('/product').query({ id: '999' }).reply(200, html);

    const offer1 = await resolveExternalOffer({ url, market: 'US' });
    const offer2 = await resolveExternalOffer({ url, market: 'US' });

    expect(offer1.offerId).toBe(stableOfferIdFromCanonicalUrl(canonical));
    expect(offer2.offerId).toBe(offer1.offerId);
    expect(scope.isDone()).toBe(true); // only one HTTP call
  });

  test('POST /v1/offers/external/resolve returns 403 for disallowed domain', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/v1/offers/external/resolve')
      .send({ url: 'https://not-allowed.com/x', market: 'US' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('DOMAIN_NOT_ALLOWED');
  });

  test('POST /v1/offers/external/batchResolve enforces max 10 urls', async () => {
    const app = makeApp();
    const urls = Array.from({ length: 11 }, (_, i) => `https://example.com/p?i=${i}`);
    const res = await request(app)
      .post('/v1/offers/external/batchResolve')
      .send({ urls, market: 'US' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('BAD_REQUEST');
  });
});
