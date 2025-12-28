import type { TechniqueCardV0 } from "../schemas/techniqueCardV0";
import { matchTechniques, type TechniqueMatchContext } from "./evalTechniqueTriggers";

function parseList<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export function scoreTechniqueCard(card: TechniqueCardV0): number {
  const triggers = (card as any)?.triggers || {};
  const all = parseList(triggers.all);
  const any = parseList(triggers.any);
  const none = parseList(triggers.none);
  return all.length * 2 + any.length + none.length;
}

export function rankMatchedTechniqueIds(input: {
  ctx: TechniqueMatchContext;
  cards: readonly TechniqueCardV0[];
}): Array<{ id: string; score: number }> {
  const indexById = new Map<string, number>();
  for (let i = 0; i < input.cards.length; i += 1) {
    const id = String((input.cards[i] as any)?.id || "");
    if (!id) continue;
    if (!indexById.has(id)) indexById.set(id, i);
  }

  const matched = matchTechniques(input.ctx, input.cards);
  return matched
    .map((c) => {
      const id = String((c as any).id || "");
      return {
        id,
        score: scoreTechniqueCard(c),
        originalIndex: indexById.get(id) ?? Number.MAX_SAFE_INTEGER,
      };
    })
    .filter((x) => x.id)
    .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex || a.id.localeCompare(b.id))
    .map((x) => ({ id: x.id, score: x.score }));
}

export function selectBestTechniqueId(input: {
  ctx: TechniqueMatchContext;
  cards: readonly TechniqueCardV0[];
  fallbackId: string;
}): { selectedId: string; ranked: Array<{ id: string; score: number }> } {
  const ranked = rankMatchedTechniqueIds({ ctx: input.ctx, cards: input.cards });
  if (ranked.length) return { selectedId: ranked[0].id, ranked };
  return { selectedId: String(input.fallbackId || ""), ranked: [] };
}
