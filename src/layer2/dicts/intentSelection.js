const { z } = require('zod');
const { readDictJson } = require('./loadDicts');

const IntentSelectionSchema = z.enum(['sequence', 'choose_one']);
const IntentSelectionMappingSchema = z.object({}).catchall(IntentSelectionSchema);

const IntentSelectionV0Schema = z
  .object({
    schemaVersion: z.literal('v0'),
    markets: z
      .object({
        US: IntentSelectionMappingSchema.optional(),
        JP: IntentSelectionMappingSchema.optional(),
      })
      .strict(),
  })
  .strict();

function loadIntentSelectionV0() {
  return IntentSelectionV0Schema.parse(readDictJson('intent_selection_v0.json'));
}

function getIntentSelection(intentId, market, dict) {
  const m = String(market || '').toUpperCase();
  if (m !== 'US' && m !== 'JP') throw new Error('MARKET_NOT_SUPPORTED');
  const d = dict ?? loadIntentSelectionV0();
  const hit = (d?.markets?.[m] ?? {})[intentId];
  return hit === 'choose_one' ? 'choose_one' : 'sequence';
}

module.exports = {
  loadIntentSelectionV0,
  getIntentSelection,
};
