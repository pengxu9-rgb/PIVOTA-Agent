import fs from "fs";
import path from "path";

import type { Market } from "../../markets/market";
import { TechniqueCardV0, TechniqueCardV0Schema } from "../schemas/techniqueCardV0";

export type TechniqueKB = {
  byId: Map<string, TechniqueCardV0>;
  list: TechniqueCardV0[];
};

const cacheByKey = new Map<string, TechniqueKB>();

function parseEnvBool(v: unknown): boolean | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return null;
}

function isStarterKbEnabled(): boolean {
  const fromEnv = parseEnvBool(process.env.ENABLE_STARTER_KB);
  if (fromEnv !== null) return fromEnv;
  return process.env.NODE_ENV !== "production";
}

export function loadTechniqueKB(market: Market): TechniqueKB {
  const starterEnabled = isStarterKbEnabled();
  const cacheKey = `${market}:${starterEnabled ? 1 : 0}`;
  const cached = cacheByKey.get(cacheKey);
  if (cached) return cached;

  const marketDir = path.join(__dirname, market.toLowerCase());
  const primaryDir = path.join(marketDir, "techniques");
  const starterDir = path.join(marketDir, "starter");

  const listJsonFiles = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort((a, b) => a.localeCompare(b))
      .map((f) => path.join(dir, f));
  };

  const byId = new Map<string, TechniqueCardV0>();
  const list: TechniqueCardV0[] = [];

  for (const filePath of listJsonFiles(primaryDir)) {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
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

  if (starterEnabled) {
    for (const filePath of listJsonFiles(starterDir)) {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const parsed = TechniqueCardV0Schema.parse(raw);
      if (parsed.market !== market) {
        throw new Error(`Technique card ${parsed.id} market must be ${market} (got ${parsed.market}).`);
      }
      if (byId.has(parsed.id)) continue;
      byId.set(parsed.id, parsed);
      list.push(parsed);
    }
  }

  const kb = { byId, list };
  cacheByKey.set(cacheKey, kb);
  return kb;
}
