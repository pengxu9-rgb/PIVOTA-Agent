import fs from "fs";
import path from "path";

import type { Market } from "../../markets/market";
import { TechniqueCardV0, TechniqueCardV0Schema } from "../schemas/techniqueCardV0";

export type TechniqueKB = {
  byId: Map<string, TechniqueCardV0>;
  list: TechniqueCardV0[];
};

const cacheByMarket = new Map<Market, TechniqueKB>();

export function loadTechniqueKB(market: Market): TechniqueKB {
  const cached = cacheByMarket.get(market);
  if (cached) return cached;

  const dir = path.join(__dirname, market.toLowerCase(), "techniques");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));

  const byId = new Map<string, TechniqueCardV0>();
  const list: TechniqueCardV0[] = [];

  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const parsed = TechniqueCardV0Schema.parse(raw);
    if (parsed.market !== market) {
      throw new Error(`Technique card ${parsed.id} market must be ${market} (got ${parsed.market}).`);
    }
    if (byId.has(parsed.id)) {
      throw new Error(`Duplicate technique id: ${parsed.id}`);
    }
    byId.set(parsed.id, parsed);
    list.push(parsed);
  }

  const kb = { byId, list };
  cacheByMarket.set(market, kb);
  return kb;
}

