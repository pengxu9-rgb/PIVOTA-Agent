const { OutcomeEventV0Schema } = require('./schemas/outcomeEventV0');
const { ingestOutcomeEventV0 } = require('./outcomeStore');
const { requireMarketEnabled } = require('../markets/market');

function mountOutcomeTelemetryRoutes(app, { logger } = {}) {
  app.post('/api/telemetry/outcome', async (req, res) => {
    const parsed = OutcomeEventV0Schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.format() });
    }
    try {
      requireMarketEnabled(parsed.data.market);
    } catch (err) {
      return res
        .status(Number(err?.httpStatus) || 403)
        .json({ error: err?.code || 'MARKET_DISABLED', message: err?.message || 'Market disabled' });
    }

    try {
      await ingestOutcomeEventV0(parsed.data);
      return res.json({ ok: true });
    } catch (err) {
      logger?.warn?.({ err: err?.message || String(err) }, 'outcome telemetry ingestion failed');
      return res.status(500).json({ error: 'OUTCOME_INGEST_FAILED' });
    }
  });
}

module.exports = {
  mountOutcomeTelemetryRoutes,
};
