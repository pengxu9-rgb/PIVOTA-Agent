const fs = require('fs');
const path = require('path');
const { z } = require('zod');

const { createProviderFromEnv, LlmError } = require('../llm/provider');
const { LookSpecBreakdownAreaV0Schema, LookSpecV0Schema } = require('./schemas/lookSpecV0');

const LookSpecExtractCoreSchema = z
  .object({
    lookTitle: z.string().min(1).default('unknown'),
    styleTags: z.array(z.string().min(1)).default([]),
    breakdown: z
      .object({
        base: LookSpecBreakdownAreaV0Schema,
        eye: LookSpecBreakdownAreaV0Schema,
        lip: LookSpecBreakdownAreaV0Schema,
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

function unknownLookSpec(locale, warnings) {
  return LookSpecV0Schema.parse({
    schemaVersion: 'v0',
    market: 'US',
    locale,
    layer2EngineVersion: 'l2-us-0.1.0',
    layer3EngineVersion: 'l3-us-0.1.0',
    orchestratorVersion: 'orchestrator-us-0.1.0',
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

function toWarning(err) {
  if (err instanceof LlmError) {
    const msg = String(err.message || '').trim();
    const suffix = msg ? `: ${msg.slice(0, 220)}` : '';
    return [`LookSpec extraction failed (${err.code})${suffix}`];
  }
  return ['LookSpec extraction failed (UNEXPECTED_ERROR).'];
}

async function extractLookSpec(input) {
  const { market, locale, referenceImage } = input;
  if (market !== 'US') throw new Error('Only market=US is supported for LookSpec extraction.');

  const prompt = loadPrompt();

  try {
    const provider = input.provider ?? createProviderFromEnv('layer2_lookspec');
    const core = await provider.analyzeImageToJson({
      prompt,
      image: referenceImage,
      schema: LookSpecExtractCoreSchema,
    });

    return LookSpecV0Schema.parse({
      schemaVersion: 'v0',
      market: 'US',
      locale,
      layer2EngineVersion: 'l2-us-0.1.0',
      layer3EngineVersion: 'l3-us-0.1.0',
      orchestratorVersion: 'orchestrator-us-0.1.0',
      lookTitle: core.lookTitle,
      styleTags: core.styleTags,
      breakdown: core.breakdown,
      warnings: core.warnings,
    });
  } catch (err) {
    return unknownLookSpec(String(locale || 'en').trim() || 'en', toWarning(err));
  }
}

module.exports = {
  extractLookSpec,
};
