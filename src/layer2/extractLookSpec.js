const fs = require('fs');
const path = require('path');
const { z } = require('zod');

const { createProviderFromEnv, LlmError } = require('../llm/provider');
const { LookSpecBreakdownAreaV0Schema, LookSpecBreakdownEyeV0Schema, LookSpecV0Schema } = require('./schemas/lookSpecV0');
const { normalizeVibeTagsForMarket } = require('./dicts/lookSpecLexicon');

const UnknownBreakdownAreaV0 = {
  intent: 'unknown',
  finish: 'unknown',
  coverage: 'unknown',
  keyNotes: [],
  evidence: [],
};

const LookSpecExtractCoreSchema = z
  .object({
    lookTitle: z.string().min(1).default('unknown'),
    styleTags: z.array(z.string().min(1)).default([]),
    breakdown: z
      .object({
        base: LookSpecBreakdownAreaV0Schema,
        eye: LookSpecBreakdownEyeV0Schema,
        lip: LookSpecBreakdownAreaV0Schema,
        prep: LookSpecBreakdownAreaV0Schema.default(UnknownBreakdownAreaV0),
        contour: LookSpecBreakdownAreaV0Schema.default(UnknownBreakdownAreaV0),
        brow: LookSpecBreakdownAreaV0Schema.default(UnknownBreakdownAreaV0),
        blush: LookSpecBreakdownAreaV0Schema.default(UnknownBreakdownAreaV0),
      })
      .strict(),
    warnings: z.array(z.string().min(1)).default([]),
  })
  .strict();

let cachedPrompt = null;

function loadPrompt() {
  if (cachedPrompt) return cachedPrompt;
  const p = path.join(__dirname, 'prompts', 'lookSpec_extract_en.txt');
  cachedPrompt = fs.readFileSync(p, 'utf8');
  return cachedPrompt;
}

function engineVersionFor(market) {
  const m = String(market || 'US').toLowerCase();
  return {
    layer2: `l2-${m}-0.1.0`,
    layer3: `l3-${m}-0.1.0`,
    orchestrator: `orchestrator-${m}-0.1.0`,
  };
}

function unknownLookSpec(market, locale, warnings) {
  const versions = engineVersionFor(market);
  return LookSpecV0Schema.parse({
    schemaVersion: 'v0',
    market,
    locale,
    layer2EngineVersion: versions.layer2,
    layer3EngineVersion: versions.layer3,
    orchestratorVersion: versions.orchestrator,
    lookTitle: 'unknown',
    styleTags: [],
    breakdown: {
      base: { intent: 'unknown', finish: 'unknown', coverage: 'unknown', keyNotes: [], evidence: [] },
      eye: { intent: 'unknown', finish: 'unknown', coverage: 'unknown', keyNotes: [], evidence: [] },
      lip: { intent: 'unknown', finish: 'unknown', coverage: 'unknown', keyNotes: [], evidence: [] },
    },
    warnings,
  });
}

function providerMetaSuffix(provider) {
  if (!provider || typeof provider !== 'object') return '';
  const meta = provider.__meta;
  if (!meta || typeof meta !== 'object') return '';
  const p = String(meta.provider || '').trim();
  const m = String(meta.model || '').trim();
  const rawBaseUrl = String(meta.baseUrl || '').trim();
  let baseUrl = '';
  if (rawBaseUrl) {
    try {
      const u = new URL(rawBaseUrl);
      baseUrl = `${u.protocol}//${u.host}`;
    } catch {
      baseUrl = rawBaseUrl;
    }
  }
  if (!p && !m && !baseUrl) return '';
  return ` [provider=${p || 'unknown'}${m ? ` model=${m}` : ''}${baseUrl ? ` baseUrl=${baseUrl}` : ''}]`;
}

function toWarning(err, provider) {
  if (err instanceof LlmError) {
    const msg = String(err.message || '').trim();
    const suffix = msg ? `: ${msg.slice(0, 220)}` : '';
    return [`LookSpec extraction failed (${err.code})${suffix}${providerMetaSuffix(provider)}`];
  }
  return [`LookSpec extraction failed (UNEXPECTED_ERROR).${providerMetaSuffix(provider)}`];
}

async function extractLookSpec(input) {
  const { market, locale, referenceImage } = input;
  if (market !== 'US' && market !== 'JP') throw new Error('MARKET_NOT_SUPPORTED');

  const prompt = input?.promptPack?.lookSpecExtract || loadPrompt();
  const versions = engineVersionFor(market);
  let provider = input.provider ?? null;
  if (!provider) {
    try {
      provider = createProviderFromEnv('layer2_lookspec');
    } catch (err) {
      return unknownLookSpec(market, String(locale || 'en').trim() || 'en', toWarning(err, null));
    }
  }

  try {
    const core = await provider.analyzeImageToJson({
      prompt,
      image: referenceImage,
      schema: LookSpecExtractCoreSchema,
    });

    return LookSpecV0Schema.parse({
      schemaVersion: 'v0',
      market,
      locale,
      layer2EngineVersion: versions.layer2,
      layer3EngineVersion: versions.layer3,
      orchestratorVersion: versions.orchestrator,
      lookTitle: core.lookTitle,
      styleTags: normalizeVibeTagsForMarket(core.styleTags, market),
      breakdown: core.breakdown,
      warnings: core.warnings,
    });
  } catch (err) {
    return unknownLookSpec(market, String(locale || 'en').trim() || 'en', toWarning(err, provider));
  }
}

module.exports = {
  extractLookSpec,
};
