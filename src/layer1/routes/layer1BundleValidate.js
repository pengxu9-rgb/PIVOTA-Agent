const { z } = require('zod');
const { Layer1BundleV0Schema } = require('../schemas/layer1BundleV0');
const { evaluateLayer1Gate } = require('../policy/usGatePolicy');

const BundleValidateRequestSchema = z.object({ bundle: Layer1BundleV0Schema }).strict();

function mountLayer1BundleRoutes(app, { logger }) {
  app.post('/api/layer1/bundle/validate', (req, res) => {
    const parsed = BundleValidateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.format() });
    }

    try {
      const decision = evaluateLayer1Gate(parsed.data.bundle);
      return res.json(decision);
    } catch (err) {
      const message = err?.message || 'Layer1 bundle validation failed';
      logger?.error({ err: message }, 'layer1 bundle validate failed');
      return res.status(500).json({ error: 'BUNDLE_VALIDATE_FAILED', message });
    }
  });
}

module.exports = { mountLayer1BundleRoutes };

