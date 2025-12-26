const { techniqueMetrics, ruleMetrics, gapClusters, priorityCandidates } = require('./metrics');

function analyzeKBHealthUS(samples) {
  const list = Array.isArray(samples) ? samples : [];

  const techniques = techniqueMetrics(list);
  const rules = ruleMetrics(list);
  const clusters = gapClusters(list);
  const candidates = priorityCandidates(clusters, list);

  return {
    schemaVersion: 'v0',
    market: 'US',
    generatedAt: new Date().toISOString(),
    totals: {
      samples: list.length,
      samples_with_rating: list.filter((s) => typeof s.signals?.rating === 'number').length,
      samples_with_issue_tags: list.filter((s) => Array.isArray(s.signals?.issueTags) && s.signals.issueTags.length > 0).length,
    },
    technique_metrics: techniques,
    rule_metrics: rules,
    gap_clusters: clusters.slice(0, 50),
    gap_candidates: candidates,
  };
}

module.exports = {
  analyzeKBHealthUS,
};

