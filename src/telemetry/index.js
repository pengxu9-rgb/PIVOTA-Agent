const { OutcomeEventV0Schema } = require('./schemas/outcomeEventV0');
const { ingestOutcomeEventV0 } = require('./outcomeStore');

function mountOutcomeTelemetryRoutes(app, { logger } = {}) {
  app.post('/api/telemetry/outcome', async (req, res) => {
    const parsed = OutcomeEventV0Schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.format() });
    }
    if (parsed.data.market !== 'US') {
      return res.status(400).json({ error: 'MARKET_NOT_SUPPORTED' });
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

