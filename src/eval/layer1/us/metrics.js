function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function computeMetrics(rows) {
  const fitScores = rows.map((r) => r.fitScore).slice().sort((a, b) => a - b);
  const confidences = rows.reduce((acc, r) => {
    acc[r.confidence] = (acc[r.confidence] || 0) + 1;
    return acc;
  }, {});

  return {
    n: rows.length,
    fitScore: {
      min: fitScores[0],
      p50: percentile(fitScores, 0.5),
      p90: percentile(fitScores, 0.9),
      max: fitScores[fitScores.length - 1],
    },
    confidenceCounts: confidences,
  };
}

module.exports = {
  computeMetrics,
};

