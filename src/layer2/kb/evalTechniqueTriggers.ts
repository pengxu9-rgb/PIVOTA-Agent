import { TechniqueCardV0, TechniqueConditionV0 } from "../schemas/techniqueCardV0";

export type TechniqueMatchContext = {
  userFaceProfile?: unknown | null;
  refFaceProfile?: unknown | null;
  similarityReport?: unknown | null;
  lookSpec: unknown;
  // NOTE: Despite the name, KB triggers use this as a generic routing knob.
  // Today it may represent either a UX style mode (structure/vibe/ease) OR a language mode (en/zh).
  preferenceMode: string;
};

function getByPath(root: unknown, pathKey: string): unknown {
  const parts = String(pathKey || "")
    .split(".")
    .map((p) => p.trim())
    .filter(Boolean);
  let cur: any = root;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function resolveKey(ctx: TechniqueMatchContext, key: string): unknown {
  // Defensive default: some call sites may omit preferenceMode. In that case, treat it as "structure"
  // so trigger matching does not silently degrade to "no matches" and fallbackId ordering.
  if (key === "preferenceMode") return String(ctx.preferenceMode || "structure");
  if (key.startsWith("userFaceProfile.")) return getByPath(ctx.userFaceProfile, key.slice("userFaceProfile.".length));
  if (key.startsWith("refFaceProfile.")) return getByPath(ctx.refFaceProfile, key.slice("refFaceProfile.".length));
  if (key.startsWith("similarityReport.")) return getByPath(ctx.similarityReport, key.slice("similarityReport.".length));
  if (key.startsWith("lookSpec.")) return getByPath(ctx.lookSpec, key.slice("lookSpec.".length));
  return undefined;
}

function asNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function evalCondition(ctx: TechniqueMatchContext, c: TechniqueConditionV0): boolean {
  const got = resolveKey(ctx, c.key);

  switch (c.op) {
    case "exists":
      return got !== undefined && got !== null;
    case "lt": {
      const n = asNumber(got);
      const v = asNumber(c.value);
      return n != null && v != null && n < v;
    }
    case "lte": {
      const n = asNumber(got);
      const v = asNumber(c.value);
      return n != null && v != null && n <= v;
    }
    case "gt": {
      const n = asNumber(got);
      const v = asNumber(c.value);
      return n != null && v != null && n > v;
    }
    case "gte": {
      const n = asNumber(got);
      const v = asNumber(c.value);
      return n != null && v != null && n >= v;
    }
    case "between": {
      const n = asNumber(got);
      if (n == null) return false;
      if (!Number.isFinite(c.min) || !Number.isFinite(c.max)) return false;
      return n >= (c.min as number) && n <= (c.max as number);
    }
    case "eq":
      return got === c.value;
    case "neq":
      return got !== c.value;
    case "in": {
      const list = Array.isArray(c.value) ? c.value : [];
      if (Array.isArray(got)) {
        return got.some((x) => list.includes(x as any));
      }
      return list.includes(got as any);
    }
    default:
      return false;
  }
}

function evalTriggers(ctx: TechniqueMatchContext, card: TechniqueCardV0): boolean {
  const { triggers } = card;
  const all = triggers.all ?? [];
  const any = triggers.any ?? [];
  const none = triggers.none ?? [];

  if (all.length && !all.every((c) => evalCondition(ctx, c))) return false;
  if (any.length && !any.some((c) => evalCondition(ctx, c))) return false;
  if (none.length && none.some((c) => evalCondition(ctx, c))) return false;
  return true;
}

export function matchTechniques(ctx: TechniqueMatchContext, cards: readonly TechniqueCardV0[]): TechniqueCardV0[] {
  return cards.filter((c) => evalTriggers(ctx, c));
}
