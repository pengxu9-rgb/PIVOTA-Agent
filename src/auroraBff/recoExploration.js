const { buildCandidateKey } = require('./recoInterleave');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function getScore(row) {
  if (!isPlainObject(row)) return 0;
  const fromBreakdown = Number(row?.score_breakdown?.score_total);
  if (Number.isFinite(fromBreakdown)) return clamp01(fromBreakdown);
  const fromSimilarity = Number(row.similarity_score ?? row.similarityScore);
  if (!Number.isFinite(fromSimilarity)) return 0;
  return fromSimilarity > 1 ? clamp01(fromSimilarity / 100) : clamp01(fromSimilarity);
}

function computeUncertainty(row) {
  const score = getScore(row);
  const uncertainty = 1 - Math.abs(score - 0.5) * 2;
  const newItemBoost = row && (row.new_item === true || row.newItem === true) ? 0.2 : 0;
  return clamp01(uncertainty + newItemBoost);
}

function selectExplorationCandidates({
  block,
  ranked,
  gatedPool,
  ratePerBlock,
  maxExploreItems,
} = {}) {
  const rankList = Array.isArray(ranked) ? ranked : [];
  const pool = Array.isArray(gatedPool) ? gatedPool : [];
  const rate = clamp01(ratePerBlock == null ? 0.2 : ratePerBlock);
  const cap = Math.max(0, Math.min(5, Number.isFinite(Number(maxExploreItems)) ? Math.trunc(Number(maxExploreItems)) : 0));
  if (!cap || !rate || !pool.length) {
    return { list: rankList.slice(), explorationKeys: new Set(), insertedCount: 0 };
  }

  const existingKeys = new Set(rankList.map((x, idx) => buildCandidateKey(x, idx)));

  const candidates = [];
  for (let i = 0; i < pool.length; i += 1) {
    const row = pool[i];
    if (!isPlainObject(row)) continue;
    const key = buildCandidateKey(row, i);
    if (!key || existingKeys.has(key)) continue;
    const uncertainty = computeUncertainty(row);
    if (uncertainty < Math.max(0.35, rate * 0.5)) continue;
    candidates.push({ key, row, uncertainty, score: getScore(row) });
  }

  candidates.sort((a, b) => {
    if (b.uncertainty !== a.uncertainty) return b.uncertainty - a.uncertainty;
    if (a.score !== b.score) return a.score - b.score;
    return a.key.localeCompare(b.key);
  });

  const selected = candidates.slice(0, cap);
  const explorationKeys = new Set(selected.map((x) => x.key));
  if (!selected.length) {
    return { list: rankList.slice(), explorationKeys, insertedCount: 0 };
  }

  const inserted = selected.map((x) => ({ ...x.row }));
  const list = [...rankList, ...inserted];
  return {
    list,
    explorationKeys,
    insertedCount: selected.length,
    block: String(block || '').trim() || 'unknown',
  };
}

module.exports = {
  selectExplorationCandidates,
  computeUncertainty,
};
