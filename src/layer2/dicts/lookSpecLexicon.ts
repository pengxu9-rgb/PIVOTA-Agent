import { z } from "zod";

import { readDictJson } from "./loadDicts";

export type Market = "US" | "JP";

const LinerDirectionSchema = z
  .object({
    direction: z.array(z.string().min(1)).min(1),
    degreeMin: z.number(),
    degreeMax: z.number(),
  })
  .strict();

const LookSpecLexiconMarketSchema = z
  .object({
    base: z
      .object({
        finish: z.array(z.string().min(1)).min(1),
        coverage: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    eye: z
      .object({
        shadowShape: z.array(z.string().min(1)).min(1),
        linerDirection: LinerDirectionSchema,
        lashIntensity: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    lip: z
      .object({
        finish: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  })
  .strict();

const LookSpecLexiconV0Schema = z
  .object({
    schemaVersion: z.literal("v0"),
    markets: z
      .object({
        US: LookSpecLexiconMarketSchema,
        JP: LookSpecLexiconMarketSchema,
      })
      .strict(),
  })
  .strict();

const VibeTagsV0Schema = z
  .object({
    schemaVersion: z.literal("v0"),
    market: z.enum(["US", "JP"]),
    tags: z
      .array(
        z
          .object({
            id: z.string().min(1),
            display: z.record(z.string().min(1), z.string().min(1)).optional(),
          })
          .strict()
      )
      .min(1),
  })
  .strict();

export type LookSpecLexicon = {
  market: Market;
  base: { finish: string[]; coverage: string[] };
  eye: { shadowShape: string[]; linerDirection: { direction: string[]; degreeMin: number; degreeMax: number }; lashIntensity: string[] };
  lip: { finish: string[] };
  vibeTags: { ids: string[]; display?: Record<string, Record<string, string>> };
};

function loadVibeTagsForMarket(market: Market) {
  const file = market === "US" ? "vibe_tags_us_v0.json" : "vibe_tags_jp_v0.json";
  return VibeTagsV0Schema.parse(readDictJson(file as any));
}

export function loadLookSpecLexiconV0(market: Market): LookSpecLexicon {
  const lex = LookSpecLexiconV0Schema.parse(readDictJson("lookspec_lexicon_v0.json"));
  const m = lex.markets[market];

  const vibe = loadVibeTagsForMarket(market);
  const ids = vibe.tags.map((t) => t.id);
  const display: Record<string, Record<string, string>> = {};
  for (const t of vibe.tags) {
    if (t.display) display[t.id] = t.display as any;
  }

  return {
    market,
    base: m.base,
    eye: m.eye,
    lip: m.lip,
    vibeTags: Object.keys(display).length ? { ids, display } : { ids },
  };
}

export function normalizeVibeTagsForMarket(input: unknown, market: Market): string[] {
  const tags = Array.isArray(input) ? input : [];
  const lex = loadLookSpecLexiconV0(market);
  const allowed = new Set(lex.vibeTags.ids);
  const out: string[] = [];
  for (const t of tags) {
    const s = String(t || "").trim();
    if (!s) continue;
    if (allowed.has(s) && !out.includes(s)) out.push(s);
  }
  return out;
}
