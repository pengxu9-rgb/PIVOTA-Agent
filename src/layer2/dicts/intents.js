const { z } = require('zod');
const { readDictJson } = require('./loadDicts');

const IntentMarketMappingSchema = z
  .object({
    techniqueIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

const IntentV0Schema = z
  .object({
    id: z.string().min(1),
    area: z.enum(['base', 'eye', 'lip']),
    markets: z
      .object({
        US: IntentMarketMappingSchema,
        JP: IntentMarketMappingSchema,
      })
      .strict(),
  })
  .strict();

const IntentsV0Schema = z
  .object({
    schemaVersion: z.literal('v0'),
    placeholders: z.array(z.string().min(1)).default([]),
    intents: z.array(IntentV0Schema).min(1),
  })
  .strict();

function loadIntentsV0() {
  return IntentsV0Schema.parse(readDictJson('intents_v0.json'));
}

function getTechniqueIdsForIntent(intentId, market, dict) {
  const m = String(market || '').toUpperCase();
  if (m !== 'US' && m !== 'JP') throw new Error('MARKET_NOT_SUPPORTED');

  const d = dict ?? loadIntentsV0();
  const hit = (d.intents || []).find((i) => i.id === intentId);
  if (!hit) return null;
  const bucket = hit.markets[m];
  return Array.isArray(bucket.techniqueIds) ? [...bucket.techniqueIds] : null;
}

module.exports = {
  loadIntentsV0,
  getTechniqueIdsForIntent,
};

