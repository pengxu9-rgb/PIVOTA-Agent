const { z } = require('zod');
const { resolveExternalOffer, ExternalOfferError } = require('../external/externalOfferResolver');

const MarketSchema = z.union([z.literal('US'), z.literal('JP')]);

const ResolveBodySchema = z
  .object({
    url: z.string().min(1),
    market: MarketSchema,
    locale: z.string().min(1).optional(),
    context: z
      .object({
        exposureId: z.string().min(1).optional(),
        impressionId: z.string().min(1).optional(),
      })
      .optional(),
  })
  .strict();

const BatchResolveBodySchema = z
  .object({
    urls: z.array(z.string().min(1)).min(1).max(10),
    market: MarketSchema,
    locale: z.string().min(1).optional(),
    context: z
      .object({
        exposureId: z.string().min(1).optional(),
        impressionId: z.string().min(1).optional(),
      })
      .optional(),
  })
  .strict();

function codeFromError(err) {
  if (!err) return 'UNKNOWN';
  if (err instanceof ExternalOfferError) return err.code;
  if (err.code === 'URL_INVALID') return 'URL_INVALID';
  return 'UNKNOWN';
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await mapper(items[i], i);
    }
  }
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function mountExternalOfferRoutes(app) {
  app.post('/v1/offers/external/resolve', async (req, res) => {
    let body;
    try {
      body = ResolveBodySchema.parse(req.body);
    } catch (err) {
      return res.status(400).json({ error: 'BAD_REQUEST', details: String(err) });
    }
    try {
      const offer = await resolveExternalOffer({ url: body.url, market: body.market, locale: body.locale });
      return res.json(offer);
    } catch (err) {
      const code = codeFromError(err);
      const status = code === 'DOMAIN_NOT_ALLOWED' ? 403 : 400;
      return res.status(status).json({ error: code, message: String(err?.message || err) });
    }
  });

  app.post('/v1/offers/external/batchResolve', async (req, res) => {
    let body;
    try {
      body = BatchResolveBodySchema.parse(req.body);
    } catch (err) {
      return res.status(400).json({ error: 'BAD_REQUEST', details: String(err) });
    }

    const offers = [];
    const errors = [];

    const results = await mapWithConcurrency(body.urls, 3, async (url) => {
      try {
        const offer = await resolveExternalOffer({ url, market: body.market, locale: body.locale });
        return { ok: true, offer };
      } catch (err) {
        return { ok: false, error: codeFromError(err), url };
      }
    });

    for (const r of results) {
      if (r.ok) offers.push(r.offer);
      else errors.push({ url: r.url, code: r.error });
    }

    return res.json({ offers, errors });
  });
}

module.exports = { mountExternalOfferRoutes };

