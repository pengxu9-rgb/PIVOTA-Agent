const { z } = require('zod');
const { readDictJson } = require('./loadDicts');

const LinerDirectionSchema = z
  .object({
    direction: z.array(z.string().min(1)).min(1),
    degreeMin: z.number(),
    degreeMax: z.number(),
  })
  .strict();

const LookSpecLexiconMarketSchema = z
  .object({
    base: z
      .object({
        finish: z.array(z.string().min(1)).min(1),
        coverage: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    eye: z
      .object({
        shadowShape: z.array(z.string().min(1)).min(1),
        linerDirection: LinerDirectionSchema,
        lashIntensity: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    lip: z
      .object({
        finish: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  })
  .strict();

const LookSpecLexiconV0Schema = z
  .object({
    schemaVersion: z.literal('v0'),
    markets: z
      .object({
        US: LookSpecLexiconMarketSchema,
        JP: LookSpecLexiconMarketSchema,
      })
      .strict(),
  })
  .strict();

const VibeTagsV0Schema = z
  .object({
    schemaVersion: z.literal('v0'),
    market: z.enum(['US', 'JP']),
    tags: z
      .array(
        z
          .object({
            id: z.string().min(1),
            display: z.record(z.string().min(1), z.string().min(1)).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

function loadVibeTagsForMarket(market) {
  const m = String(market || '').toUpperCase();
  const file = m === 'US' ? 'vibe_tags_us_v0.json' : 'vibe_tags_jp_v0.json';
  return VibeTagsV0Schema.parse(readDictJson(file));
}

function loadLookSpecLexiconV0(market) {
  const m = String(market || '').toUpperCase();
  if (m !== 'US' && m !== 'JP') throw new Error('MARKET_NOT_SUPPORTED');

  const lex = LookSpecLexiconV0Schema.parse(readDictJson('lookspec_lexicon_v0.json'));
  const bucket = lex.markets[m];

  const vibe = loadVibeTagsForMarket(m);
  const ids = vibe.tags.map((t) => t.id);
  const display = {};
  for (const t of vibe.tags) {
    if (t.display) display[t.id] = t.display;
  }

  return {
    market: m,
    base: bucket.base,
    eye: bucket.eye,
    lip: bucket.lip,
    vibeTags: Object.keys(display).length ? { ids, display } : { ids },
  };
}

function normalizeVibeTagsForMarket(input, market) {
  const tags = Array.isArray(input) ? input : [];
  const lex = loadLookSpecLexiconV0(market);
  const allowed = new Set(lex.vibeTags.ids);
  const out = [];
  for (const t of tags) {
    const s = String(t || '').trim();
    if (!s) continue;
    if (allowed.has(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

module.exports = {
  loadLookSpecLexiconV0,
  normalizeVibeTagsForMarket,
};
