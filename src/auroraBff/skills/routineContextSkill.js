'use strict';

const { runSkill } = require('./contracts');
const {
  detectRoutineLifecycleStage,
  buildRoutineLifecycleContext,
  buildLifecyclePromptInstructions,
  buildSupplementaryPromptInstructions,
  parseRoutineForSupplementary,
} = require('../routineLifecycle');
const { buildKbGroundingForPrompt } = require('../routineKbLoader');

async function runRoutineContextSkill({
  requestContext,
  logger,
  routineCandidate,
  previousRoutine,
  profileSummary,
  routineExpert,
  lastDiagnosisTs,
  lastRoutineUpdateTs,
  intent,
  language,
} = {}) {
  return runSkill({
    skillName: 'routine_context',
    stage: 'routine_context',
    provider: 'local_rules',
    requestContext,
    logger,
    timeoutMs: 3000,
    run: async () => {
      const stage = detectRoutineLifecycleStage({
        routineCandidate,
        previousRoutine,
        routineExpertIssues: routineExpert && routineExpert.key_issues,
        lastRoutineUpdateTs,
        intent,
      });

      if (!stage) {
        return { stage: null, lifecycle_instructions: '', kb_grounding: '' };
      }

      const lifecycleCtx = buildRoutineLifecycleContext({
        stage,
        routineCandidate,
        previousRoutine,
        profileSummary,
        routineExpert,
        lastDiagnosisTs,
        lastRoutineUpdateTs,
        language,
      });

      const lifecycleInstructions = buildLifecyclePromptInstructions(lifecycleCtx, language);

      const supplementary = buildSupplementaryPromptInstructions({
        routineCandidate,
        profileSummary,
        language,
      });

      let kbGrounding = '';
      if (routineCandidate) {
        const { actives } = parseRoutineForSupplementary(routineCandidate);
        const activeConcepts = actives.map((a) => a.toUpperCase());
        if (profileSummary && profileSummary.barrierStatus === 'impaired') activeConcepts.push('BARRIER_COMPROMISED');
        if (profileSummary && profileSummary.sensitivity === 'high') activeConcepts.push('SENSITIVE_SKIN');
        kbGrounding = buildKbGroundingForPrompt({ activeConcepts, profileSummary, language });
      }

      return {
        stage,
        lifecycle_context: lifecycleCtx,
        lifecycle_instructions: lifecycleInstructions + supplementary + kbGrounding,
        kb_grounding: kbGrounding,
      };
    },
  });
}

module.exports = {
  runRoutineContextSkill,
};
