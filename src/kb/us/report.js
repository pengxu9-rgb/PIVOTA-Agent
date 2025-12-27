function fmtPct(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '0%';
  return `${Math.round(n * 100)}%`;
}

function fmtNum(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '—';
  return String(Math.round(n * 100) / 100);
}

function renderKBHealthReportMD(summary) {
  const totals = summary?.totals || {};
  const candidates = Array.isArray(summary?.gap_candidates) ? summary.gap_candidates : [];
  const topTech = Array.isArray(summary?.technique_metrics) ? summary.technique_metrics.slice(0, 10) : [];
  const topRules = Array.isArray(summary?.rule_metrics) ? summary.rule_metrics.slice(0, 10) : [];

  const lines = [];
  lines.push(`# KB Health Report (${summary?.market || 'US'})`);
  lines.push(``);
  lines.push(`Generated: ${summary?.generatedAt || ''}`);
  lines.push(``);
  lines.push(`## Totals`);
  lines.push(`- samples: ${totals.samples || 0}`);
  lines.push(`- samples with rating: ${totals.samples_with_rating || 0}`);
  lines.push(`- samples with issue tags: ${totals.samples_with_issue_tags || 0}`);
  lines.push(``);

  lines.push(`## Top Gap Candidates`);
  if (!candidates.length) {
    lines.push(`(none)`);
  } else {
    for (const c of candidates.slice(0, 10)) {
      lines.push(
        `- priority=${fmtNum(c.priority)} count=${c.count} avgRating=${fmtNum(c.avgRating)} fallbackRate=${fmtPct(c.fallbackRate)} key=${c.key}`,
      );
    }
  }
  lines.push(``);

  lines.push(`## Top Techniques (by usage)`);
  if (!topTech.length) {
    lines.push(`(none)`);
  } else {
    for (const t of topTech) {
      lines.push(
        `- ${t.area}:${t.id} usage=${t.usage_count} rating=${fmtNum(t.rating_mean)} fallbackAssoc=${fmtPct(
          t.fallback_association_rate,
        )} lowConf=${fmtPct(t.low_confidence_rate)}`,
      );
    }
  }
  lines.push(``);

  lines.push(`## Top Rules (by usage)`);
  if (!topRules.length) {
    lines.push(`(none)`);
  } else {
    for (const r of topRules) {
      lines.push(
        `- ${r.area}:${r.ruleId} usage=${r.usage_count} rating=${fmtNum(r.rating_mean)} fallbackAssoc=${fmtPct(
          r.fallback_association_rate,
        )} lowConf=${fmtPct(r.low_confidence_rate)}`,
      );
    }
  }
  lines.push(``);

  lines.push(`## Notes`);
  lines.push(`- This report uses derived-only outcome samples (no raw images).`);
  lines.push(`- "fallbackRate" is the fraction of painful samples in the cluster with any fallback used.`);

  return lines.join('\n');
}

module.exports = {
  renderKBHealthReportMD,
};
