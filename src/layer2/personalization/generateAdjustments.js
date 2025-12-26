const fs = require('fs');
const path = require('path');
const { z } = require('zod');

const { createProviderFromEnv, LlmError } = require('../../llm/provider');
const { hintsFromLayer1 } = require('./hintsFromLayer1');
const { LookSpecV0Schema } = require('../schemas/lookSpecV0');

const { FaceProfileV0Schema } = require('../../layer1/schemas/faceProfileV0');
const { SimilarityReportV0Schema } = require('../../layer1/schemas/similarityReportV0');

const Layer2AdjustmentV0Schema = z
  .object({
    impactArea: z.enum(['base', 'eye', 'lip']),
    title: z.string().min(1),
    because: z.string().min(1),
    do: z.string().min(1),
    confidence: z.enum(['high', 'medium', 'low']),
    evidence: z.array(z.string().min(1)).min(1),
  })
  .strict();

const AdjustmentsCoreSchema = z
  .object({
    adjustments: z.array(Layer2AdjustmentV0Schema).min(1),
    warnings: z.array(z.string().min(1)).default([]),
  })
  .strict();

let cachedPrompt = null;

function loadPrompt() {
  if (cachedPrompt) return cachedPrompt;
  const p = path.join(__dirname, '..', 'prompts', 'adjustments_generate_en.txt');
  cachedPrompt = fs.readFileSync(p, 'utf8');
  return cachedPrompt;
}

function fallbackAdjustment(area, lowConfidence) {
  if (area === 'base') {
    return {
      impactArea: 'base',
      title: 'Keep base thin',
      because: lowConfidence
        ? 'To match the reference look reliably, a thin base preserves finish and texture.'
        : 'A thin base preserves finish and makes matching easier.',
      do: 'Apply a light layer first, then spot-conceal only where needed and re-blend.',
      confidence: lowConfidence ? 'low' : 'medium',
      evidence: ['fallback:base', 'lookSpec.breakdown.base.finish'],
    };
  }
  if (area === 'eye') {
    return {
      impactArea: 'eye',
      title: 'Control liner direction',
      because: lowConfidence
        ? 'To match the reference look, a shorter controlled wing is safer without exact geometry.'
        : 'Wing direction strongly affects the eye emphasis.',
      do: 'Start liner from the outer third, keep the wing shorter, and connect back with a thin stroke.',
      confidence: lowConfidence ? 'low' : 'medium',
      evidence: ['fallback:eye', 'lookSpec.breakdown.eye.intent'],
    };
  }
  return {
    impactArea: 'lip',
    title: 'Match lip finish',
    because: lowConfidence
      ? 'To match the reference look, finish (gloss vs satin) is more reliable than chasing exact shape.'
      : 'Finish changes the lip mood more reliably than shape tweaks.',
    do: 'Match gloss vs satin and stay in a close shade family; adjust intensity with a light blot if needed.',
    confidence: lowConfidence ? 'low' : 'medium',
    evidence: ['fallback:lip', 'lookSpec.breakdown.lip.finish'],
  };
}

function ensureExactlyThree(candidate, lowConfidence, warnings) {
  const byArea = {};
  for (const a of candidate) {
    if (!a || typeof a !== 'object') continue;
    if (a.impactArea !== 'base' && a.impactArea !== 'eye' && a.impactArea !== 'lip') continue;
    if (!byArea[a.impactArea]) byArea[a.impactArea] = a;
  }

  const areas = ['base', 'eye', 'lip'];
  for (const area of areas) {
    if (!byArea[area]) {
      byArea[area] = fallbackAdjustment(area, lowConfidence);
      warnings.push(`Filled missing ${area} adjustment with fallback.`);
    }
  }

  const out = [byArea.base, byArea.eye, byArea.lip];

  if (lowConfidence) {
    for (const a of out) {
      a.confidence = 'low';
      if (!/reference look/i.test(a.because)) a.because = `To match the reference look, ${a.because}`;
    }
  }

  return out;
}

async function generateAdjustments(input) {
  if (input.market !== 'US') throw new Error('Only market=US is supported for Layer2 personalization.');

  const locale = String(input.locale || 'en').trim() || 'en';
  const lookSpec = LookSpecV0Schema.parse(input.lookSpec);
  const userFace = input.userFaceProfile == null ? null : FaceProfileV0Schema.parse(input.userFaceProfile);
  const refFace = input.refFaceProfile == null ? null : FaceProfileV0Schema.parse(input.refFaceProfile);
  const similarityReport =
    input.similarityReport == null ? null : SimilarityReportV0Schema.parse(input.similarityReport);
  const hints = hintsFromLayer1(similarityReport);

  const lowConfidence = userFace == null || refFace == null;
  const warnings = [];
  if (refFace == null) warnings.push('Missing refFaceProfile: using safer defaults.');

  let provider = input.provider ?? null;
  if (!provider) {
    try {
      provider = createProviderFromEnv('layer2_lookspec');
    } catch (err) {
      warnings.push('LLM config missing: using fallback adjustments.');
      const fixed = ensureExactlyThree([], lowConfidence, warnings);
      return { adjustments: fixed, warnings };
    }
  }

  const promptTemplate = loadPrompt();
  const prompt =
    `${promptTemplate}\n\n` +
    `INPUT_JSON:\n` +
    JSON.stringify(
      {
        market: 'US',
        locale,
        userFaceProfile: userFace,
        refFaceProfile: refFace,
        similarityReport,
        layer1Hints: hints,
        lookSpec,
      },
      null,
      2
    );

  try {
    const parsed = await provider.analyzeTextToJson({ prompt, schema: AdjustmentsCoreSchema });
    const candidate = Array.isArray(parsed.adjustments) ? parsed.adjustments : [];
    const fixed = ensureExactlyThree(candidate, lowConfidence, warnings);
    return { adjustments: fixed, warnings: [...(parsed.warnings || []), ...warnings] };
  } catch (err) {
    if (err instanceof LlmError) {
      warnings.push(`LLM failed (${err.code}): ${String(err.message || '').slice(0, 220)}`);
    } else {
      warnings.push('LLM failed: using fallback adjustments.');
    }
    const fixed = ensureExactlyThree([], lowConfidence, warnings);
    return { adjustments: fixed, warnings };
  }
}

module.exports = {
  Layer2AdjustmentV0Schema,
  generateAdjustments,
};
