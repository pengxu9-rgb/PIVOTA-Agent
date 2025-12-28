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
  const matched = matchTechniques(input.ctx, input.cards);
  return matched
    .map((c) => ({ id: String((c as any).id || ""), score: scoreTechniqueCard(c) }))
    .filter((x) => x.id)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
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

