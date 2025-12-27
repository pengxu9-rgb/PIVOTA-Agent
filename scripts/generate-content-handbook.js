#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function tryReadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return readJson(filePath);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath, text) {
  fs.writeFileSync(filePath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function groupPrefix(prefix) {
  if (prefix.startsWith("lookSpec.")) return "lookSpec";
  if (prefix.startsWith("userFaceProfile.")) return "user";
  if (prefix.startsWith("refFaceProfile.")) return "ref";
  if (prefix.startsWith("similarityReport.")) return "similarity";
  if (prefix.toLowerCase().includes("delta")) return "delta";
  return "other";
}

function walkTechniqueDirsForObservedTriggerKeys(repoRoot) {
  const kbRoot = path.join(repoRoot, "src", "layer2", "kb");
  if (!fs.existsSync(kbRoot)) return new Set();

  const out = new Set();
  const markets = ["us", "jp"];
  for (const market of markets) {
    const dir = path.join(kbRoot, market, "techniques");
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    for (const f of files) {
      const card = readJson(path.join(dir, f));
      const triggers = card?.triggers ?? {};
      for (const groupKey of ["all", "any", "none"]) {
        const list = Array.isArray(triggers[groupKey]) ? triggers[groupKey] : [];
        for (const condition of list) {
          const key = condition?.key;
          if (typeof key === "string" && key.trim()) out.add(key.trim());
        }
      }
    }
  }
  return out;
}

function pickLexiconValue(lexicon, market, area, field, fallback = "unknown") {
  const values = lexicon?.markets?.[market]?.[area]?.[field];
  if (!Array.isArray(values) || values.length === 0) return fallback;
  const firstNonUnknown = values.find((v) => v !== "unknown") ?? values[0];
  return firstNonUnknown ?? fallback;
}

function generateTriggerCheatsheet({ triggerDict, lookspecLexicon, observedKeys }) {
  const allowedPrefixes = Array.isArray(triggerDict?.allowedPrefixes) ? triggerDict.allowedPrefixes : [];
  const groups = new Map();
  for (const p of allowedPrefixes) {
    const g = groupPrefix(String(p));
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(String(p));
  }
  for (const [g, list] of groups) list.sort();

  const observed = Array.from(observedKeys ?? new Set()).sort();
  const observedLookSpec = observed.filter((k) => k.startsWith("lookSpec."));
  const observedUser = observed.filter((k) => k.startsWith("userFaceProfile."));
  const observedRef = observed.filter((k) => k.startsWith("refFaceProfile."));
  const observedSim = observed.filter((k) => k.startsWith("similarityReport."));

  const highlightPrefixes = allowedPrefixes.filter((p) => {
    const s = String(p);
    return (
      s.startsWith("lookSpec.") ||
      s.startsWith("userFaceProfile.geometry.") ||
      s.startsWith("userFaceProfile.categorical.") ||
      s.startsWith("similarityReport.")
    );
  });

  const lines = [];
  lines.push("# Trigger Keys Cheatsheet (v0)");
  lines.push("");
  lines.push("This is generated from frozen dicts and KB. Do not edit by hand.");
  lines.push("");

  lines.push("## Most common (highlight)");
  lines.push("");
  lines.push("These are the most commonly used prefixes/patterns:");
  lines.push("");
  for (const p of Array.from(new Set(highlightPrefixes)).sort()) {
    lines.push(`- \`${p}\``);
  }
  lines.push("");

  lines.push("## Allowed prefixes (grouped)");
  lines.push("");
  for (const groupName of ["lookSpec", "user", "ref", "similarity", "delta", "other"]) {
    const list = groups.get(groupName) ?? [];
    if (list.length === 0) continue;
    lines.push(`### ${groupName}`);
    lines.push("");
    for (const p of list) {
      lines.push(`- \`${p}\``);
    }
    lines.push("");
  }

  lines.push("## Observed keys in KB (current repo)");
  lines.push("");
  lines.push("These keys are currently used inside technique card triggers:");
  lines.push("");
  if (observed.length === 0) {
    lines.push("- (none found)");
    lines.push("");
    return `${lines.join("\n")}\n`;
  }

  const renderObservedGroup = (title, keys) => {
    lines.push(`### ${title}`);
    lines.push("");
    if (keys.length === 0) {
      lines.push("- (none)");
      lines.push("");
      return;
    }
    for (const k of keys) lines.push(`- \`${k}\``);
    lines.push("");
  };

  renderObservedGroup("lookSpec.*", observedLookSpec);
  renderObservedGroup("userFaceProfile.*", observedUser);
  renderObservedGroup("refFaceProfile.*", observedRef);
  renderObservedGroup("similarityReport.*", observedSim);

  if (lookspecLexicon) {
    lines.push("## LookSpec value lexicon (optional)");
    lines.push("");
    lines.push("Allowed enum values (from `lookspec_lexicon_v0.json`):");
    lines.push("");
    for (const market of ["US", "JP"]) {
      if (!lookspecLexicon?.markets?.[market]) continue;
      lines.push(`### ${market}`);
      const baseFinish = pickLexiconValue(lookspecLexicon, market, "base", "finish");
      const baseCoverage = pickLexiconValue(lookspecLexicon, market, "base", "coverage");
      const lipFinish = pickLexiconValue(lookspecLexicon, market, "lip", "finish");
      lines.push("");
      lines.push(`- base.finish example: \`${baseFinish}\``);
      lines.push(`- base.coverage example: \`${baseCoverage}\``);
      lines.push(`- lip.finish example: \`${lipFinish}\``);
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

function generateRolesDropdownCsv(rolesDict) {
  const roles = Array.isArray(rolesDict?.roles) ? rolesDict.roles : [];
  const rows = [];
  rows.push(["role_id", "area", "description", "synonyms"].join(","));

  // roles_v0 does not currently define area/description. Keep deterministic placeholders.
  const sorted = roles
    .map((r) => ({ id: String(r?.id ?? "").trim(), synonyms: Array.isArray(r?.synonyms) ? r.synonyms : [] }))
    .filter((r) => r.id)
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const r of sorted) {
    const synonyms = r.synonyms.map((s) => String(s)).filter(Boolean).sort();
    rows.push(
      [
        csvEscape(r.id),
        csvEscape("any"),
        csvEscape(""),
        csvEscape(synonyms.join("|")),
      ].join(","),
    );
  }

  return `${rows.join("\n")}\n`;
}

function generateQuickExamples({ triggerDict, rolesDict, lookspecLexicon, observedKeys }) {
  const allowedPrefixes = Array.isArray(triggerDict?.allowedPrefixes) ? triggerDict.allowedPrefixes : [];

  const lookSpecKeys = Array.from(observedKeys ?? [])
    .filter((k) => k.startsWith("lookSpec."))
    .sort();

  // If there are no observed lookSpec keys (e.g., empty KB), fall back to prefix patterns.
  const lookSpecPrefixKeys =
    lookSpecKeys.length > 0
      ? lookSpecKeys
      : allowedPrefixes.filter((p) => String(p).startsWith("lookSpec.")).map((p) => `${p}<field>`);

  const marketForExamples = "US";
  const baseFinish = lookspecLexicon ? pickLexiconValue(lookspecLexicon, marketForExamples, "base", "finish") : "unknown";
  const baseCoverage = lookspecLexicon ? pickLexiconValue(lookspecLexicon, marketForExamples, "base", "coverage") : "unknown";
  const lipFinish = lookspecLexicon ? pickLexiconValue(lookspecLexicon, marketForExamples, "lip", "finish") : "unknown";

  const makeCondition = (key) => {
    const k = String(key);
    if (k.endsWith(".intent")) return `${k} exists`;
    if (k.endsWith(".finish")) return `${k} eq ${k.includes(".base.") ? baseFinish : lipFinish}`;
    if (k.endsWith(".coverage")) return `${k} eq ${baseCoverage}`;
    return `${k} exists`;
  };

  const examples = [];
  for (let i = 0; i < 15; i += 1) {
    const k1 = lookSpecPrefixKeys[i % lookSpecPrefixKeys.length];
    const k2 = lookSpecPrefixKeys[(i + 3) % lookSpecPrefixKeys.length];
    const conds = [makeCondition(k1), makeCondition(k2)];
    if (i % 3 === 0) conds.push("preferenceMode eq ease");
    examples.push(`- \`${conds.join("; ")}\``);
  }

  const roles = Array.isArray(rolesDict?.roles) ? rolesDict.roles : [];
  const roleIds = roles
    .map((r) => String(r?.id ?? "").trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const roleSets = [];
  const chunk = 3;
  for (let i = 0; i < 15; i += 1) {
    const start = i * chunk;
    const set = roleIds.slice(start, start + chunk);
    // If we run out (small dict), wrap deterministically.
    while (set.length < chunk && roleIds.length > 0) set.push(roleIds[(start + set.length) % roleIds.length]);
    roleSets.push(set);
  }

  const renderRoleSets = (label, sets) => {
    const lines = [];
    lines.push(`### ${label}`);
    lines.push("");
    for (const s of sets) {
      lines.push(`- \`${s.join(", ")}\``);
    }
    lines.push("");
    return lines.join("\n");
  };

  const lines = [];
  lines.push("# Quick Examples (copy-paste)");
  lines.push("");
  lines.push("Generated from frozen dicts. Adjust values as needed.");
  lines.push("");
  lines.push("## Trigger `trigger_all` examples");
  lines.push("");
  lines.push(...examples);
  lines.push("");
  lines.push("## Example `productRoleHints` sets (role IDs)");
  lines.push("");
  lines.push(renderRoleSets("Eye (5 sets)", roleSets.slice(0, 5)));
  lines.push(renderRoleSets("Base (5 sets)", roleSets.slice(5, 10)));
  lines.push(renderRoleSets("Lip (5 sets)", roleSets.slice(10, 15)));

  return `${lines.join("\n")}\n`;
}

function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const dictDir = path.join(repoRoot, "src", "layer2", "dicts");
  const outDir = path.join(repoRoot, "artifacts", "handbook");

  ensureDir(outDir);

  const triggerDict = readJson(path.join(dictDir, "trigger_keys_v0.json"));
  const rolesDict = readJson(path.join(dictDir, "roles_v0.json"));
  const lookspecLexicon = tryReadJson(path.join(dictDir, "lookspec_lexicon_v0.json"));

  const observedKeys = walkTechniqueDirsForObservedTriggerKeys(repoRoot);

  writeText(
    path.join(outDir, "trigger_keys_cheatsheet.md"),
    generateTriggerCheatsheet({ triggerDict, lookspecLexicon, observedKeys }),
  );

  writeText(path.join(outDir, "roles_dropdown.csv"), generateRolesDropdownCsv(rolesDict));

  writeText(
    path.join(outDir, "quick_examples.md"),
    generateQuickExamples({ triggerDict, rolesDict, lookspecLexicon, observedKeys }),
  );

  console.log(`[handbook] wrote ${path.join("artifacts", "handbook", "trigger_keys_cheatsheet.md")}`);
  console.log(`[handbook] wrote ${path.join("artifacts", "handbook", "roles_dropdown.csv")}`);
  console.log(`[handbook] wrote ${path.join("artifacts", "handbook", "quick_examples.md")}`);
}

main();

