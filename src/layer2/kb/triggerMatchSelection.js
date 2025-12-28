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
  const indexById = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const id = String(list[i]?.id || "");
    if (!id) continue;
    if (!indexById.has(id)) indexById.set(id, i);
  }
  const matched = matchTechniques(ctx, list);
  return matched
    .map((c) => {
      const id = String(c.id || "");
      return { id, score: scoreTechniqueCard(c), originalIndex: indexById.get(id) ?? Number.MAX_SAFE_INTEGER };
    })
    .filter((x) => x.id)
    .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex || a.id.localeCompare(b.id))
    .map((x) => ({ id: x.id, score: x.score }));
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
