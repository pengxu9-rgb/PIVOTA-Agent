/* eslint-disable no-console */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function repoRoot() {
  return path.join(__dirname, "..");
}

function readJson(relPathFromRepoRoot) {
  const abs = path.join(repoRoot(), relPathFromRepoRoot);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

function writeTempJpeg() {
  const p = path.join(os.tmpdir(), `pivota-lookrep-smoke-${process.pid}-${Date.now()}.jpg`);
  fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // minimal JPEG markers
  return p;
}

function filterWarnings(warnings) {
  const patterns = ["[trigger_match]", "Technique language fallback", "NO_CANDIDATES", "Missing technique card"];
  return (Array.isArray(warnings) ? warnings : [])
    .map((w) => String(w || ""))
    .filter((w) => patterns.some((p) => w.includes(p)));
}

function uniqueStrings(items) {
  const seen = new Set();
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const s = String(it || "");
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function summarizeSkeletons(label, skeletons) {
  console.log(label);
  for (const s of Array.isArray(skeletons) ? skeletons : []) {
    const refs = Array.isArray(s?.techniqueRefs)
      ? s.techniqueRefs.map((r) => String(r?.id || "")).filter(Boolean)
      : [];
    console.log(
      `- area=${String(s?.impactArea || "")} ruleId=${String(s?.ruleId || "")} doActionSelection=${String(s?.doActionSelection || "(unset)")} techniqueRefs=[${refs.join(
        ", "
      )}]`
    );
  }
}

function collectTechniqueRefIds(skeletons) {
  const ids = [];
  for (const s of Array.isArray(skeletons) ? skeletons : []) {
    const refs = Array.isArray(s?.techniqueRefs) ? s.techniqueRefs : [];
    for (const r of refs) {
      const id = String(r?.id || "").trim();
      if (id) ids.push(id);
    }
  }
  return ids;
}

function countEyeMicroMacro(techniqueIds) {
  const micro = techniqueIds.filter((id) => id.startsWith("T_EYE_"));
  const macro = techniqueIds.filter((id) => id.startsWith("US_eye_") && id.includes("liner"));
  return { micro, macro };
}

function pairedZhId(enId) {
  if (String(enId).endsWith("-en")) return `${enId.slice(0, -3)}-zh`;
  return null;
}

async function withEnv(overrides, fn) {
  const backup = { ...process.env };
  try {
    for (const [k, v] of Object.entries(overrides || {})) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = String(v);
    }
    return await fn();
  } finally {
    process.env = backup;
  }
}

async function withMockedExtractLookSpec(mockLookSpec, fn) {
  const modulePath = path.join(repoRoot(), "src", "layer2", "extractLookSpec");
  const resolved = require.resolve(modulePath);
  const prior = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: {
      extractLookSpec: async () => mockLookSpec,
    },
  };

  try {
    const pipelinePath = path.join(repoRoot(), "src", "lookReplicator", "lookReplicatePipeline");
    const pipelineResolved = require.resolve(pipelinePath);
    delete require.cache[pipelineResolved];
    return await fn();
  } finally {
    if (prior) require.cache[resolved] = prior;
    else delete require.cache[resolved];
  }
}

async function runScenario({ name, locale, lookSpecFixturePath, env }) {
  const baseEnv = {
    API_MODE: "MOCK",
    PIVOTA_API_KEY: "",
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "",
    PIVOTA_GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
    ENABLE_STARTER_KB: "0",
    EXPERIMENT_MORE_CANDIDATES_ENABLED: "0",
    LAYER2_ENABLE_EYE_ACTIVITY_SLOT: "1",
  };

  const effectiveEnv = { ...baseEnv, ...(env || {}) };

  console.log(
    `\n=== ${name} (locale=${locale}) env={LAYER2_ENABLE_TRIGGER_MATCHING=${effectiveEnv.LAYER2_ENABLE_TRIGGER_MATCHING || "0"}, LAYER2_TRIGGER_MATCH_DEBUG=${effectiveEnv.LAYER2_TRIGGER_MATCH_DEBUG || "0"}, LAYER2_ENABLE_EXTENDED_AREAS=${effectiveEnv.LAYER2_ENABLE_EXTENDED_AREAS || "0"}, LAYER2_ENABLE_EYE_ACTIVITY_SLOT=${effectiveEnv.LAYER2_ENABLE_EYE_ACTIVITY_SLOT || "0"}} ===`
  );

  const lookSpec = readJson(lookSpecFixturePath);
  const layer1Bundle = readJson("fixtures/contracts/us/layer1BundleV0.sample.json");
  const referenceImagePath = writeTempJpeg();

  try {
    return await withEnv(effectiveEnv, async () => {
      // Run full look-replicator pipeline (extractLookSpec is mocked to avoid network).
      const pipelineOut = await withMockedExtractLookSpec(lookSpec, async () => {
        const { runLookReplicatePipeline } = require(path.join(repoRoot(), "src", "lookReplicator", "lookReplicatePipeline"));
        return await runLookReplicatePipeline({
          market: "US",
          locale,
          preferenceMode: "structure",
          jobId: `smoke_${name}`,
          referenceImage: { path: referenceImagePath, contentType: "image/jpeg" },
          layer1Bundle,
        });
      });

      // Also run Layer2 render directly so we can print both skeletons + allSkeletons (primary vs full list).
      const { runAdjustmentRulesUS } = require(path.join(repoRoot(), "src", "layer2", "personalization", "rules", "runAdjustmentRulesUS"));
      const { loadTechniqueKBUS } = require(path.join(repoRoot(), "src", "layer2", "kb", "loadTechniqueKBUS"));
      const { renderSkeletonFromKB } = require(path.join(repoRoot(), "src", "layer2", "personalization", "renderSkeletonFromKB"));

      const userFaceProfile = layer1Bundle?.userFaceProfile ?? null;
      const refFaceProfile = layer1Bundle?.refFaceProfile ?? null;
      const similarityReport = layer1Bundle?.similarityReport ?? null;

      const rawSkeletons = runAdjustmentRulesUS({
        userFaceProfile,
        refFaceProfile,
        similarityReport,
        lookSpec,
        preferenceMode: "structure",
      });

      const kb = loadTechniqueKBUS();
      const rendered = renderSkeletonFromKB(rawSkeletons, kb, {
        userFaceProfile,
        refFaceProfile,
        similarityReport,
        lookSpec,
        locale,
        preferenceMode: "structure",
      });

      const filtered = [
        ...filterWarnings(pipelineOut?.result?.warnings),
        ...filterWarnings(rendered?.warnings),
      ];
      const deduped = uniqueStrings(filtered);
      console.log("warnings:");
      if (!deduped.length) console.log("(none)");
      else for (const w of deduped) console.log(`- ${w}`);

      summarizeSkeletons("skeletons (primary):", rendered?.skeletons);
      summarizeSkeletons("allSkeletons (full):", rendered?.allSkeletons);

      const ids = collectTechniqueRefIds(rendered?.allSkeletons ?? rendered?.skeletons);
      const { micro, macro } = countEyeMicroMacro(ids);

      if (name.toLowerCase().includes("eye")) {
        console.log(`derived_checks: microCount=${micro.length} macroCount=${macro.length} macroIds=[${macro.join(", ")}]`);
      }

      return { pipelineOut, rendered, micro, macro };
    });
  } finally {
    fs.rmSync(referenceImagePath, { force: true });
  }
}

async function main() {
  const scenarios = [
    {
      name: "A_EN_EYE_LINER_matching_off",
      locale: "en-US",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_eye_liner_up.json",
      env: {
        LAYER2_ENABLE_TRIGGER_MATCHING: "0",
        LAYER2_TRIGGER_MATCH_DEBUG: "0",
        LAYER2_ENABLE_EXTENDED_AREAS: "0",
      },
    },
    {
      name: "B_EN_BASE_COVERAGE_matching_on",
      locale: "en-US",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_base_coverage_full.json",
      env: {
        LAYER2_ENABLE_TRIGGER_MATCHING: "1",
        LAYER2_TRIGGER_MATCH_DEBUG: "1",
        LAYER2_ENABLE_EXTENDED_AREAS: "0",
      },
    },
    {
      name: "C_ZH_EYE_LINER_matching_on_extended_on",
      locale: "zh-CN",
      lookSpecFixturePath: "fixtures/look_replicator/lookspec_eye_liner_up.json",
      env: {
        LAYER2_ENABLE_TRIGGER_MATCHING: "1",
        LAYER2_TRIGGER_MATCH_DEBUG: "1",
        LAYER2_ENABLE_EXTENDED_AREAS: "1",
      },
    },
  ];

  let failed = false;

  for (const s of scenarios) {
    const out = await runScenario(s);

    if (s.name.toLowerCase().includes("eye")) {
      const microCountOk = out.micro.length >= 3;
      const macroCountOk = out.macro.length === 1;
      if (!microCountOk || !macroCountOk) {
        console.warn(`[FAIL] ${s.name}: expected microCount>=3 and macroCount==1 (got micro=${out.micro.length}, macro=${out.macro.length})`);
        failed = true;
      }

      if (s.locale.toLowerCase().startsWith("zh")) {
        const macroId = out.macro[0] || "";
        const shouldBeZh = macroId.endsWith("-zh");
        if (!shouldBeZh) {
          const zhPair = pairedZhId(macroId);
          const kb = require(path.join(repoRoot(), "src", "layer2", "kb", "loadTechniqueKB")).loadTechniqueKB("US");
          const hasZh = zhPair ? kb.byId.has(zhPair) : false;
          if (hasZh) {
            console.warn(`bilingual_pair_missing_for=${macroId}`);
            failed = true;
          }
        }
      }
    }
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
