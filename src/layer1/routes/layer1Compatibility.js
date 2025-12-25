const { z } = require('zod');
const { FaceProfileV0Schema } = require('../schemas/faceProfileV0');
const { PreferenceModeSchema } = require('../schemas/similarityReportV0');
const { runCompatibilityEngineUS } = require('../compatibility/us/runCompatibilityEngineUS');
const { recordCompatibilitySampleUS } = require('../storage/compatibilitySamplesUS');

const CompatibilityRequestSchema = z
  .object({
    market: z.literal('US'),
    locale: z.string().min(1),
    preferenceMode: PreferenceModeSchema,
    userFaceProfile: FaceProfileV0Schema.nullable().optional(),
    refFaceProfile: FaceProfileV0Schema,
    optInTraining: z.boolean().optional(),
    sessionId: z.string().min(1).optional(),
  })
  .strict();

function mountLayer1CompatibilityRoutes(app, { logger }) {
  app.post('/api/layer1/compatibility', async (req, res) => {
    const parsed = CompatibilityRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.format() });
    }

    const input = parsed.data;
    try {
      const report = runCompatibilityEngineUS({
        market: 'US',
        preferenceMode: input.preferenceMode,
        userFaceProfile: input.userFaceProfile ?? null,
        refFaceProfile: input.refFaceProfile,
        locale: input.locale,
      });

      if (input.optInTraining) {
        if (!input.sessionId) {
          return res.status(400).json({ error: 'INVALID_REQUEST', message: 'sessionId is required when optInTraining=true' });
        }
        await recordCompatibilitySampleUS({
          market: 'US',
          locale: input.locale,
          preferenceMode: input.preferenceMode,
          sessionId: input.sessionId,
          userFaceProfile: input.userFaceProfile ?? null,
          refFaceProfile: input.refFaceProfile,
          similarityReport: report,
        }).catch((err) => {
          logger?.warn({ err: err?.message || String(err) }, 'compatibility sample store failed');
        });
      }

      return res.json(report);
    } catch (err) {
      const message = err?.message || 'Compatibility engine failed';
      logger?.error({ err: message }, 'layer1 compatibility failed');
      return res.status(500).json({ error: 'COMPATIBILITY_FAILED', message });
    }
  });
}

module.exports = { mountLayer1CompatibilityRoutes };

