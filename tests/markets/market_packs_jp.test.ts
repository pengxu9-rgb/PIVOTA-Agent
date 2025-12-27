import fs from "fs";
import path from "path";

import { buildKitPlan } from "../../src/layer3/buildKitPlan";
import { LookSpecV0Schema } from "../../src/layer2/schemas/lookSpecV0";
import { parseMarketFromRequest, requireMarketEnabled } from "../../src/markets/market";

// Runtime implementation is in JS; the TS file is types-only.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getMarketPack } = require("../../src/markets/getMarketPack");

function readJson(relPath: string) {
  const full = path.join(__dirname, "..", "..", relPath);
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

describe("Market Packs (JP)", () => {
  const prevEnableJp = process.env.ENABLE_MARKET_JP;

  afterEach(() => {
    if (prevEnableJp === undefined) delete process.env.ENABLE_MARKET_JP;
    else process.env.ENABLE_MARKET_JP = prevEnableJp;
  });

  test("invalid market is rejected (request parser)", () => {
    expect(() => parseMarketFromRequest("NA" as any, "US" as any)).toThrow(/not supported/i);
  });

  test("JP is disabled unless ENABLE_MARKET_JP is set", () => {
    delete process.env.ENABLE_MARKET_JP;
    expect(() => requireMarketEnabled("JP" as any)).toThrow(/disabled/i);
    expect(() => getMarketPack({ market: "JP", locale: "ja" })).toThrow(/disabled/i);
  });

  test("JP pack is isolated and commerce disabled when enabled", () => {
    process.env.ENABLE_MARKET_JP = "1";
    const pack = getMarketPack({ market: "JP", locale: "ja" });
    expect(pack.market).toBe("JP");
    expect(pack.commerceEnabled).toBe(false);
    expect(pack.getLookSpecLexicon().market).toBe("JP");

    const kb = pack.loadTechniqueKB();
    expect(kb.list.length).toBeGreaterThan(0);
    for (const c of kb.list) {
      expect(c.market).toBe("JP");
    }
  });

  test("JP kit plan returns placeholders with purchaseEnabled=false", async () => {
    const lookSpec = LookSpecV0Schema.parse(readJson("fixtures/contracts/jp/lookSpecV0.sample.json"));
    const kit = await buildKitPlan({ market: "JP", locale: "ja", lookSpec, commerceEnabled: false });

    expect(kit.market).toBe("JP");
    expect(kit.warnings).toContain("COMMERCE_DISABLED:JP");
    for (const area of ["base", "eye", "lip"] as const) {
      expect(kit.kit[area].best.purchaseEnabled).toBe(false);
      expect(kit.kit[area].dupe.purchaseEnabled).toBe(false);
    }
  });
});
