const fs = require('fs');
const path = require('path');
const { z } = require('zod');

const { createProviderFromEnv } = require('../../llm/provider');
const { LookSpecV0Schema } = require('../schemas/lookSpecV0');
const { StepPlanV0Schema, StepImpactAreaSchema } = require('../schemas/stepPlanV0');
const { Layer2AdjustmentV0Schema } = require('./generateAdjustments');

const StepsCoreSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            impactArea: StepImpactAreaSchema,
            title: z.string().min(1),
            instruction: z.string().min(1),
            tips: z.array(z.string().min(1)).default([]),
            cautions: z.array(z.string().min(1)).default([]),
            fitConditions: z.array(z.string().min(1)).default([]),
            evidence: z.array(z.string().min(1)).min(1),
          })
          .strict()
      )
      .min(8)
      .max(12),
    warnings: z.array(z.string().min(1)).default([]),
  })
  .strict();

let cachedPrompt = null;

function loadPrompt() {
  if (cachedPrompt) return cachedPrompt;
  const p = path.join(__dirname, '..', 'prompts', 'steps_generate_en.txt');
  cachedPrompt = fs.readFileSync(p, 'utf8');
  return cachedPrompt;
}

function fallbackSteps(locale, adjustments, lowConfidence) {
  const baseLead = lowConfidence ? 'To match the reference look, ' : '';
  const core = [
    { impactArea: 'base', title: 'Prep base', instruction: `${baseLead}prep skin and apply primer as needed.`, evidence: ['lookSpec.breakdown.base.intent'] },
    { impactArea: 'base', title: 'Apply base', instruction: `${baseLead}${adjustments.find((a) => a.impactArea === 'base')?.do || 'apply a thin base layer.'}`, evidence: ['adjustments[base].do'] },
    { impactArea: 'base', title: 'Set strategically', instruction: `${baseLead}set only where needed to keep the intended finish.`, evidence: ['lookSpec.breakdown.base.finish'] },
    { impactArea: 'eye', title: 'Map eye shape', instruction: `${baseLead}map the eye emphasis based on the reference intent.`, evidence: ['lookSpec.breakdown.eye.intent'] },
    { impactArea: 'eye', title: 'Apply liner/shadow', instruction: `${baseLead}${adjustments.find((a) => a.impactArea === 'eye')?.do || 'apply a controlled liner.'}`, evidence: ['adjustments[eye].do'] },
    { impactArea: 'eye', title: 'Blend edges', instruction: `${baseLead}blend edges softly to match the reference finish.`, evidence: ['lookSpec.breakdown.eye.finish'] },
    { impactArea: 'lip', title: 'Prep lips', instruction: `${baseLead}prep lips and remove excess balm before color.`, evidence: ['lookSpec.breakdown.lip.intent'] },
    { impactArea: 'lip', title: 'Apply lip', instruction: `${baseLead}${adjustments.find((a) => a.impactArea === 'lip')?.do || 'match lip finish and shade family.'}`, evidence: ['adjustments[lip].do'] },
  ];

  return core.map((s, idx) =>
    StepPlanV0Schema.parse({
      schemaVersion: 'v0',
      market: 'US',
      locale,
      layer2EngineVersion: 'l2-us-0.1.0',
      layer3EngineVersion: 'l3-us-0.1.0',
      orchestratorVersion: 'orchestrator-us-0.1.0',
      stepId: `l2_step_${idx}`,
      order: idx,
      impactArea: s.impactArea,
      title: s.title,
      instruction: s.instruction,
      tips: [],
      cautions: [],
      fitConditions: [],
      evidence: s.evidence,
    })
  );
}

async function generateSteps(input) {
  if (input.market !== 'US') throw new Error('Only market=US is supported for Layer2 personalization.');

  const locale = String(input.locale || 'en').trim() || 'en';
  const lookSpec = LookSpecV0Schema.parse(input.lookSpec);
  const adjustments = (input.adjustments || []).map((a) => Layer2AdjustmentV0Schema.parse(a));
  const lowConfidence = input.userFaceProfile == null;

  const warnings = [];

  let provider = input.provider ?? null;
  if (!provider) {
    try {
      provider = createProviderFromEnv('generic');
    } catch (err) {
      warnings.push('LLM config missing: using fallback steps.');
      return { steps: fallbackSteps(locale, adjustments, lowConfidence), warnings };
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
        lookSpec,
        adjustments,
        userFaceProfilePresent: !lowConfidence,
      },
      null,
      2
    );

  try {
    const parsed = await provider.analyzeTextToJson({ prompt, schema: StepsCoreSchema });
    const steps = parsed.steps.map((s, idx) =>
      StepPlanV0Schema.parse({
        schemaVersion: 'v0',
        market: 'US',
        locale,
        layer2EngineVersion: 'l2-us-0.1.0',
        layer3EngineVersion: 'l3-us-0.1.0',
        orchestratorVersion: 'orchestrator-us-0.1.0',
        stepId: `l2_step_${idx}`,
        order: idx,
        impactArea: s.impactArea,
        title: s.title,
        instruction: s.instruction,
        tips: s.tips ?? [],
        cautions: s.cautions ?? [],
        fitConditions: s.fitConditions ?? [],
        evidence: s.evidence,
      })
    );
    return { steps, warnings: [...(parsed.warnings || []), ...warnings] };
  } catch (err) {
    warnings.push('LLM failed: using fallback steps.');
    return { steps: fallbackSteps(locale, adjustments, lowConfidence), warnings };
  }
}

module.exports = {
  generateSteps,
};
