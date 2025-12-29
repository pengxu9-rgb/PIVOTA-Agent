const fs = require('fs');
const path = require('path');
const { z } = require('zod');

const { createProviderFromEnv, LlmError } = require('../../llm/provider');
const { normalizeLookSpecToV1 } = require('../schemas/lookSpecV1');
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

function engineVersionFor(market) {
  const m = String(market || 'US').toLowerCase();
  return {
    layer2: `l2-${m}-0.1.0`,
    layer3: `l3-${m}-0.1.0`,
    orchestrator: `orchestrator-${m}-0.1.0`,
  };
}

function fallbackSteps(market, locale, adjustments, lowConfidence) {
  const baseLead = lowConfidence ? 'To match the reference look, ' : '';
  const zh = String(locale || '').trim().toLowerCase().replace(/_/g, '-').startsWith('zh');
  if (zh) {
    const lead = lowConfidence ? '为了更贴近参考妆容，' : '';
    const core = [
      { impactArea: 'base', title: '妆前打底', instruction: `${lead}按需清洁与保湿，并视情况使用妆前乳。`, evidence: ['lookSpec.breakdown.base.intent'] },
      { impactArea: 'base', title: '上底妆', instruction: `${lead}${adjustments.find((a) => a.impactArea === 'base')?.do || '薄涂底妆并分区叠加。'}`, evidence: ['adjustments[base].do'] },
      { impactArea: 'base', title: '局部定妆', instruction: `${lead}只在需要的区域轻扫定妆，以保持目标妆效。`, evidence: ['lookSpec.breakdown.base.finish'] },
      { impactArea: 'eye', title: '确定眼妆重心', instruction: `${lead}根据参考妆容的意图确定眼妆重心与走向。`, evidence: ['lookSpec.breakdown.eye.intent'] },
      { impactArea: 'eye', title: '上眼影/眼线', instruction: `${lead}${adjustments.find((a) => a.impactArea === 'eye')?.do || '用可控的线条完成眼线与阴影。'}`, evidence: ['adjustments[eye].do'] },
      { impactArea: 'eye', title: '晕染边缘', instruction: `${lead}把边缘晕染柔和，贴近参考妆效。`, evidence: ['lookSpec.breakdown.eye.finish'] },
      { impactArea: 'lip', title: '唇部打底', instruction: `${lead}上色前先润唇并擦去多余油分。`, evidence: ['lookSpec.breakdown.lip.intent'] },
      { impactArea: 'lip', title: '上唇妆', instruction: `${lead}${adjustments.find((a) => a.impactArea === 'lip')?.do || '对齐参考的唇部质感与色系。'}`, evidence: ['adjustments[lip].do'] },
    ];

    const versions = engineVersionFor(market);
    return core.map((s, idx) =>
      StepPlanV0Schema.parse({
        schemaVersion: 'v0',
        market,
        locale,
        layer2EngineVersion: versions.layer2,
        layer3EngineVersion: versions.layer3,
        orchestratorVersion: versions.orchestrator,
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

  const versions = engineVersionFor(market);
  return core.map((s, idx) =>
    StepPlanV0Schema.parse({
      schemaVersion: 'v0',
      market,
      locale,
      layer2EngineVersion: versions.layer2,
      layer3EngineVersion: versions.layer3,
      orchestratorVersion: versions.orchestrator,
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
  if (input.market !== 'US' && input.market !== 'JP') throw new Error('MARKET_NOT_SUPPORTED');

  const locale = String(input.locale || 'en').trim() || 'en';
  const lookSpec = normalizeLookSpecToV1(input.lookSpec);
  const adjustments = (input.adjustments || []).map((a) => Layer2AdjustmentV0Schema.parse(a));
  const lowConfidence = input.userFaceProfile == null;

  const warnings = [];

  let provider = input.provider ?? null;
  if (!provider) {
    try {
      provider = createProviderFromEnv('layer2_lookspec');
    } catch (err) {
      warnings.push('LLM config missing: using fallback steps.');
      return { steps: fallbackSteps(input.market, locale, adjustments, lowConfidence), warnings };
    }
  }

  const promptTemplate = input?.promptPack?.stepsGenerate || loadPrompt();
  const prompt =
    `${promptTemplate}\n\n` +
    `INPUT_JSON:\n` +
    JSON.stringify(
      {
        market: input.market,
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
    const versions = engineVersionFor(input.market);
    const steps = parsed.steps.map((s, idx) =>
      StepPlanV0Schema.parse({
        schemaVersion: 'v0',
        market: input.market,
        locale,
        layer2EngineVersion: versions.layer2,
        layer3EngineVersion: versions.layer3,
        orchestratorVersion: versions.orchestrator,
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
    if (err instanceof LlmError) {
      warnings.push(`LLM failed (${err.code}): ${String(err.message || '').slice(0, 220)}`);
    } else {
      warnings.push('LLM failed: using fallback steps.');
    }
    return { steps: fallbackSteps(input.market, locale, adjustments, lowConfidence), warnings };
  }
}

module.exports = {
  generateSteps,
};
