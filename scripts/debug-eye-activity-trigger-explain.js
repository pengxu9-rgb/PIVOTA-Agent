/* eslint-disable no-console */

const fs = require("node:fs");
const path = require("node:path");

const { loadTechniqueKBUS } = require("../src/layer2/kb/loadTechniqueKBUS");
const { getTechniqueIdsForIntent } = require("../src/layer2/dicts/intents");
const { matchTechniques } = require("../src/layer2/kb/evalTechniqueTriggers");

function repoRoot() {
  return path.join(__dirname, "..");
}

function readJson(relPathFromRepoRoot) {
  const abs = path.join(repoRoot(), relPathFromRepoRoot);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

function getByPath(root, pathKey) {
  const parts = String(pathKey || "")
    .split(".")
    .map((p) => p.trim())
    .filter(Boolean);
  let cur = root;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function resolveKey(ctx, key) {
  if (key === "preferenceMode") return ctx.preferenceMode;
  if (key.startsWith("userFaceProfile.")) return getByPath(ctx.userFaceProfile, key.slice("userFaceProfile.".length));
  if (key.startsWith("refFaceProfile.")) return getByPath(ctx.refFaceProfile, key.slice("refFaceProfile.".length));
  if (key.startsWith("similarityReport.")) return getByPath(ctx.similarityReport, key.slice("similarityReport.".length));
  if (key.startsWith("lookSpec.")) return getByPath(ctx.lookSpec, key.slice("lookSpec.".length));
  return undefined;
}

function asNumber(v) {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function evalCondition(ctx, c) {
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
      return n >= c.min && n <= c.max;
    }
    case "eq":
      return got === c.value;
    case "neq":
      return got !== c.value;
    case "in": {
      const list = Array.isArray(c.value) ? c.value : [];
      if (Array.isArray(got)) return got.some((x) => list.includes(x));
      return list.includes(got);
    }
    default:
      return false;
  }
}

function explainTriggers(ctx, card) {
  const triggers = card?.triggers || {};
  const all = Array.isArray(triggers.all) ? triggers.all : [];
  const any = Array.isArray(triggers.any) ? triggers.any : [];
  const none = Array.isArray(triggers.none) ? triggers.none : [];

  const evalList = (list) =>
    list.map((c) => ({
      condition: c,
      ok: evalCondition(ctx, c),
      got: resolveKey(ctx, c.key),
    }));

  const allEval = evalList(all);
  const anyEval = evalList(any);
  const noneEval = evalList(none);

  const allOk = !allEval.length || allEval.every((x) => x.ok);
  const anyOk = !anyEval.length || anyEval.some((x) => x.ok);
  const noneOk = !noneEval.length || noneEval.every((x) => !x.ok);

  const matched = allOk && anyOk && noneOk;

  const failed = [];
  if (!allOk) failed.push({ clause: "all", failed: allEval.filter((x) => !x.ok).map((x) => x.condition) });
  if (!anyOk) failed.push({ clause: "any", failed: anyEval.filter((x) => !x.ok).map((x) => x.condition) });
  if (!noneOk) failed.push({ clause: "none", failed: noneEval.filter((x) => x.ok).map((x) => x.condition) });

  const allKeys = [...new Set([...allEval, ...anyEval, ...noneEval].map((x) => x.condition?.key).filter(Boolean))];
  const keyValues = Object.fromEntries(
    allKeys.map((k) => {
      const v = resolveKey(ctx, k);
      return [k, v === undefined ? "(missing)" : v === null ? null : v];
    }),
  );

  return { matched, failed, keyValues, allEval, anyEval, noneEval };
}

function printEvalGroup(label, list) {
  if (!list.length) return;
  console.log(`${label}:`);
  for (const x of list) {
    const c = x.condition;
    const got = x.got === undefined ? "(missing)" : x.got;
    console.log(`  - ${c.key} ${c.op}${c.value !== undefined ? ` ${JSON.stringify(c.value)}` : ""} => ok=${x.ok} got=${JSON.stringify(got)}`);
  }
}

function buildCtx({ locale }) {
  const lookSpec = readJson("fixtures/look_replicator/lookspec_eye_liner_up.json");
  const layer1Bundle = readJson("fixtures/contracts/us/layer1BundleV0.sample.json");

  const clonedLookSpec = JSON.parse(JSON.stringify(lookSpec));
  clonedLookSpec.locale = locale;

  return {
    lookSpec: clonedLookSpec,
    preferenceMode: "structure",
    userFaceProfile: layer1Bundle?.userFaceProfile ?? null,
    refFaceProfile: layer1Bundle?.refFaceProfile ?? null,
    similarityReport: layer1Bundle?.similarityReport ?? null,
  };
}

function main() {
  process.env.ENABLE_STARTER_KB = "0";

  const kb = loadTechniqueKBUS();
  const candidateIds = getTechniqueIdsForIntent("EYE_LINER_ACTIVITY_PICK", "US") ?? [];
  const candidates = candidateIds.map((id) => kb.byId.get(id)).filter(Boolean);

  console.log(`intentId=EYE_LINER_ACTIVITY_PICK candidates=[${candidateIds.join(", ")}] foundCards=${candidates.length}`);

  for (const locale of ["en-US", "zh-CN"]) {
    console.log(`\n=== LOCALE ${locale} ===`);
    const ctx = buildCtx({ locale });

    console.log("ctx.lookSpec.breakdown.eye:");
    console.log(JSON.stringify(getByPath(ctx.lookSpec, "breakdown.eye") ?? null, null, 2));

    const matched = matchTechniques(ctx, candidates);
    console.log(`matchTechniques matchedIds=[${matched.map((c) => c.id).join(", ") || ""}]`);

    for (const card of candidates) {
      console.log(`\n--- ${card.id} ---`);
      const triggers = card.triggers || {};
      console.log("triggers:");
      console.log(JSON.stringify({ all: triggers.all ?? [], any: triggers.any ?? [], none: triggers.none ?? [] }, null, 2));

      const explained = explainTriggers(ctx, card);
      console.log("resolved_key_values:");
      console.log(JSON.stringify(explained.keyValues, null, 2));

      printEvalGroup("all_eval", explained.allEval);
      printEvalGroup("any_eval", explained.anyEval);
      printEvalGroup("none_eval", explained.noneEval);

      console.log(`matched=${explained.matched}`);
      if (!explained.matched) {
        console.log("failed_clauses:");
        console.log(JSON.stringify(explained.failed, null, 2));
      }
    }
  }
}

main();

