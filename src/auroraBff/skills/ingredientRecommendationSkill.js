const { mapIngredientActions } = require('../ingredientActionsV1');
const { runSkill } = require('./contracts');

function normalizeIssueType(raw) {
  return String(raw || '').trim().toLowerCase();
}

function collectIssueTypes(issues, maxItems = 3) {
  const source = Array.isArray(issues) ? issues : [];
  const out = [];
  const seen = new Set();
  for (const item of source) {
    let token = '';
    if (typeof item === 'string') token = normalizeIssueType(item);
    else if (item && typeof item === 'object') token = normalizeIssueType(item.issue_type || item.id || item.type);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= maxItems) break;
  }
  return out;
}

function dedupeActions(actions, maxItems = 12) {
  const source = Array.isArray(actions) ? actions : [];
  const out = [];
  const seen = new Set();
  for (const item of source) {
    if (!item || typeof item !== 'object') continue;
    const key = String(item.ingredient_canonical_id || item.ingredient_id || item.ingredient_name || '')
      .trim()
      .toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

async function runIngredientRecommendationSkill({
  requestContext,
  logger,
  issues,
  language,
  barrierStatus,
  sensitivity,
  market,
  contraindications,
  internalTestMode = false,
} = {}) {
  return runSkill({
    skillName: 'ingredient_recommendation',
    stage: 'ingredient_recommendation',
    provider: 'ingredient_actions_v1',
    requestContext,
    logger,
    run: async () => {
      const issueTypes = collectIssueTypes(issues, 3);
      const issueActions = [];
      for (const issueType of issueTypes) {
        const actions = mapIngredientActions({
          issueType,
          evidenceRegionIds: [],
          language,
          barrierStatus,
          sensitivity,
          market,
          contraindications,
          internalTestMode,
        });
        issueActions.push({
          issue_type: issueType,
          actions: Array.isArray(actions) ? actions : [],
        });
      }

      const actionsFlat = dedupeActions(
        issueActions.reduce((acc, row) => {
          if (Array.isArray(row.actions)) acc.push(...row.actions);
          return acc;
        }, []),
      );

      return {
        issue_types: issueTypes,
        issue_actions: issueActions,
        actions_flat: actionsFlat,
        total_actions: actionsFlat.length,
      };
    },
  });
}

module.exports = {
  runIngredientRecommendationSkill,
};

