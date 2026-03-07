'use strict';

const { runSkill } = require('./contracts');

async function runRoutineExpertSkill({
  requestContext,
  logger,
  buildRoutineExpertFn,
  routineCandidate,
  profileSummary,
  recentLogs,
  language,
} = {}) {
  return runSkill({
    skillName: 'routine_expert',
    stage: 'routine_expert',
    provider: 'local_rules',
    requestContext,
    logger,
    timeoutMs: 5000,
    run: async () => {
      if (!buildRoutineExpertFn || typeof buildRoutineExpertFn !== 'function') {
        return { expert: null, reason: 'no_builder_fn' };
      }

      const expert = buildRoutineExpertFn({
        routineCandidate,
        profileSummary,
        recentLogs,
        language,
      });

      if (!expert) {
        return { expert: null, reason: 'empty_input' };
      }

      return {
        expert,
        issue_count: Array.isArray(expert.key_issues) ? expert.key_issues.length : 0,
        has_plan_7d: Boolean(expert.plan_7d),
        has_upgrade_path: Boolean(expert.upgrade_path && expert.upgrade_path.length),
      };
    },
  });
}

module.exports = {
  runRoutineExpertSkill,
};
