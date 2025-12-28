#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");

const { TechniqueCardV0Schema } = require("../src/layer2/schemas/techniqueCardV0");
const { loadTriggerKeysV1, isTriggerKeyAllowed } = require("../src/layer2/dicts/triggerKeys");
const { loadRolesV1 } = require("../src/layer2/dicts/roles");
const { readDictJson } = require("../src/layer2/dicts/loadDicts");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const m = String(a || "").match(/^--([^=]+)=(.*)$/);
    if (m) {
      out[m[1]] = m[2];
      continue;
    }
    const m2 = String(a || "").match(/^--(.+)$/);
    if (m2) {
      const key = m2[1];
      const next = argv[i + 1];
      if (next && !String(next).startsWith("--")) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function normalizeMarketArg(v) {
  const s = String(v || "").trim().toUpperCase();
  if (s === "US" || s === "JP" || s === "ALL") return s;
  return null;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function stableJsonStringify(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function writeCardFile(outDir, card) {
  const filePath = path.join(outDir, `${card.id}.json`);
  fs.writeFileSync(filePath, stableJsonStringify(card), "utf8");
}

function cleanDirJson(outDir) {
  if (!fs.existsSync(outDir)) return;
  for (const f of fs.readdirSync(outDir)) {
    if (f.endsWith(".json")) fs.unlinkSync(path.join(outDir, f));
  }
}

function intentShort(intentId) {
  return String(intentId || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function stepClamp(steps) {
  const trimmed = (steps || [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  const bounded = trimmed.slice(0, 6);
  return bounded.map((s) => (s.length > 120 ? `${s.slice(0, 117).trimEnd()}…` : s));
}

function buildStepsByArea(area) {
  if (area === "prep") {
    return stepClamp([
      "Cleanse and moisturize, then let it settle.",
      "Apply a small amount of primer where you want the base to grip or blur.",
      "Mist lightly to re-hydrate if skin feels tight before base.",
    ]);
  }
  if (area === "base") {
    return stepClamp([
      "Apply a thin, even base layer.",
      "Spot-correct only where needed and re-blend.",
      "Set only where needed to keep the intended finish.",
    ]);
  }
  if (area === "brow") {
    return stepClamp([
      "Brush brows up to see the natural shape.",
      "Fill sparse areas with light strokes, then soften with a spoolie.",
      "Set hairs with a small amount of brow gel.",
    ]);
  }
  if (area === "eye") {
    return stepClamp([
      "Start detail work from the outer third and build gradually.",
      "Keep lines thin first, then adjust the outer corner.",
      "Fill small gaps along the lash line for a clean edge.",
    ]);
  }
  if (area === "blush") {
    return stepClamp([
      "Place blush on the cheeks, then blend outward.",
      "Keep edges soft and build in thin layers.",
      "If needed, tap a small amount of base over edges to soften.",
    ]);
  }
  if (area === "contour") {
    return stepClamp([
      "Apply contour lightly, then blend until edges disappear.",
      'Keep placement tight and avoid dragging product too low.',
      "Add a subtle highlight only after blending is complete.",
    ]);
  }
  return stepClamp([
    "Match the reference finish first (matte/satin/gloss).",
    "Stay in a close shade family and adjust intensity with a light blot.",
    "Concentrate color slightly more in the center if needed.",
  ]);
}

function buildTitleForAreaIntent(area, intentId) {
  const pretty = String(intentId || "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  const areaLabel = String(area || "").trim();
  return `${pretty || "Starter technique"} (${areaLabel})`;
}

function pickRoleHintsByArea(area, roleIds) {
  const sorted = [...roleIds].sort((a, b) => a.localeCompare(b));
  const byArea = {
    prep: sorted.filter((id) => /(hydrating|mist|moisturizer|primer)/.test(id)),
    base: sorted.filter((id) => /(foundation|base|concealer|powder|puff|sponge|setting_spray)/.test(id)),
    brow: sorted.filter((id) => /(^|_)brow(_|$)/.test(id)),
    eye: sorted.filter((id) => /(liner|mascara|lash|shadow|brush)/.test(id)),
    blush: sorted.filter((id) => /(blush)/.test(id)),
    contour: sorted.filter((id) => /(contour|highlighter|fan_brush|angled_brush)/.test(id)),
    lip: sorted.filter((id) => /(lip_|gloss|tissue)/.test(id)),
  };
  const pool = byArea[area] && byArea[area].length ? byArea[area] : sorted;
  return pool.slice(0, 3);
}

function loadIntentsV1() {
  const raw = readDictJson("intents_v1.json");
  if (!raw || typeof raw !== "object") throw new Error("Failed to read intents_v1.json");
  if (raw.schemaVersion !== "v1") throw new Error(`intents_v1.json schemaVersion must be v1 (got ${raw.schemaVersion})`);
  if (!Array.isArray(raw.intents)) throw new Error("intents_v1.json missing intents array");
  return raw;
}

function buildStarterCardsForMarket({ market }) {
  const triggerKeys = loadTriggerKeysV1();
  const roles = loadRolesV1();
  const intents = loadIntentsV1();
  const roleIds = new Set((roles.roles || []).map((r) => r.id));

  const desiredCounts = {
    prep: 3,
    base: 5,
    brow: 3,
    eye: 5,
    blush: 2,
    contour: 1,
    lip: 1,
  };

  const intentsByArea = {};
  for (const it of intents.intents || []) {
    if (!it || !it.id || !it.area || !it.markets) continue;
    if (!it.markets[market]) continue;
    intentsByArea[it.area] = intentsByArea[it.area] || [];
    intentsByArea[it.area].push(it);
  }
  for (const area of Object.keys(intentsByArea)) {
    intentsByArea[area].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  const cards = [];
  const seenIds = new Set();

  const areaOrder = ["prep", "base", "brow", "eye", "blush", "contour", "lip"];
  for (const area of areaOrder) {
    const target = desiredCounts[area];
    if (!target) continue;

    const list = intentsByArea[area] && intentsByArea[area].length ? intentsByArea[area] : [];
    const fallbackIntentId = `STARTER_${area.toUpperCase()}`;

    for (let i = 0; i < target; i += 1) {
      const intent = list.length
        ? list[i % list.length]
        : { id: fallbackIntentId, area, markets: { [market]: { techniqueIds: [] } } };

      const variantSuffix = target > 1 ? `_V${i + 1}` : "";
      const prefix = market === "JP" ? "TJP_STARTER" : "T_STARTER";
      const id = `${prefix}_${area.toUpperCase()}_${intentShort(intent.id)}${variantSuffix}`;
      if (seenIds.has(id)) continue;

      const primaryKey = `lookSpec.breakdown.${area}.intent`;
      const triggers = {
        any: [
          { key: primaryKey, op: "exists" },
          { key: "preferenceMode", op: "exists" },
        ],
      };

      const conditions = [...(triggers.all || []), ...(triggers.any || []), ...(triggers.none || [])];
      for (const c of conditions) {
        if (!isTriggerKeyAllowed(c.key, triggerKeys)) throw new Error(`Generated disallowed trigger key: ${c.key}`);
      }

      const card = {
        schemaVersion: "v0",
        market,
        id,
        area,
        difficulty: "easy",
        triggers,
        actionTemplate: {
          title: `${buildTitleForAreaIntent(area, intent.id)} (starter)`,
          steps: buildStepsByArea(area),
        },
        rationaleTemplate: ["Starter steps are generic defaults and can be refined once more context is available."],
        productRoleHints: pickRoleHintsByArea(area, roleIds),
        safetyNotes: ["Avoid identity or celebrity comparisons."],
        sourceId: "INTERNAL_STARTER",
        sourcePointer: "generated",
        tags: ["starter", "reviewStatus:approved"],
      };

      const parsed = TechniqueCardV0Schema.parse(card);
      seenIds.add(parsed.id);
      cards.push(parsed);
    }
  }

  cards.sort((a, b) => a.id.localeCompare(b.id));
  return cards;
}

function usageAndExit(code) {
  console.log(`Usage:
  npm run kb:starter:generate -- --market US|JP|ALL --count 20

Outputs:
  - src/layer2/kb/us/starter/*.json
  - src/layer2/kb/jp/starter/*.json
`);
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const marketArg = normalizeMarketArg(args.market);
  const count = Number(args.count || 20) || 20;
  if (!marketArg) usageAndExit(1);
  if (count !== 20) {
    console.error(`[kb:starter] --count must be exactly 20 (got ${count})`);
    process.exit(1);
  }

  const markets = marketArg === "ALL" ? ["US", "JP"] : [marketArg];
  for (const m of markets) {
    const outDir = path.join(__dirname, "..", "src", "layer2", "kb", m.toLowerCase(), "starter");
    ensureDir(outDir);
    cleanDirJson(outDir);
    const cards = buildStarterCardsForMarket({ market: m });
    for (const c of cards) writeCardFile(outDir, c);
    console.log(`[kb:starter] market=${m} wrote ${cards.length} card(s) to ${outDir}`);
  }
}

main();
