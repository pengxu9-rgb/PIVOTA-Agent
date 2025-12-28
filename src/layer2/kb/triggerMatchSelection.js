const { matchTechniques } = require("./evalTechniqueTriggers");

function parseList(v) {
  return Array.isArray(v) ? v : [];
}

function scoreTechniqueCard(card) {
  const triggers = card?.triggers || {};
  const all = parseList(triggers.all);
  const any = parseList(triggers.any);
  const none = parseList(triggers.none);
  return all.length * 2 + any.length + none.length;
}

function rankMatchedTechniqueIds({ ctx, cards }) {
  const list = Array.isArray(cards) ? cards : [];
  const matched = matchTechniques(ctx, list);
  return matched
    .map((c) => ({ id: String(c.id || ""), score: scoreTechniqueCard(c) }))
    .filter((x) => x.id)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function selectBestTechniqueId({ ctx, cards, fallbackId }) {
  const ranked = rankMatchedTechniqueIds({ ctx, cards });
  if (ranked.length) return { selectedId: ranked[0].id, ranked };
  return { selectedId: String(fallbackId || ""), ranked: [] };
}

module.exports = {
  scoreTechniqueCard,
  rankMatchedTechniqueIds,
  selectBestTechniqueId,
};

