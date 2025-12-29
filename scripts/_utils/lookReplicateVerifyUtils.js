const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function repoRoot() {
  return path.join(__dirname, "..", "..");
}

function readJson(relPathFromRepoRoot) {
  const abs = path.join(repoRoot(), relPathFromRepoRoot);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

function writeTempJpeg(prefix = "pivota-lookrep-verify") {
  const p = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}.jpg`);
  fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // minimal JPEG markers
  return p;
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

async function withMockedExtractLookSpec({ referenceLookSpec, selfieLookSpec }, fn) {
  const modulePath = path.join(repoRoot(), "src", "layer2", "extractLookSpec");
  const resolved = require.resolve(modulePath);
  const prior = require.cache[resolved];

  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: {
      extractLookSpec: async (input) => (input?.imageKind === "selfie" ? selfieLookSpec : referenceLookSpec),
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

function stableSortStrings(list) {
  return [...list].map(String).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function uniqStrings(list) {
  return stableSortStrings(Array.from(new Set((Array.isArray(list) ? list : []).map(String).filter(Boolean))));
}

function collectTechniqueIds(out) {
  const ids = [];

  const resultRefs = Array.isArray(out?.result?.techniqueRefs) ? out.result.techniqueRefs : [];
  for (const r of resultRefs) {
    const id = String(r?.id || "").trim();
    if (id) ids.push(id);
  }

  if (ids.length) return uniqStrings(ids);

  const skels = Array.isArray(out?.telemetrySample?.replayContext?.adjustmentSkeletons)
    ? out.telemetrySample.replayContext.adjustmentSkeletons
    : [];

  for (const s of skels) {
    const refs = Array.isArray(s?.techniqueRefs) ? s.techniqueRefs : [];
    for (const r of refs) {
      const id = String(r?.id || "").trim();
      if (id) ids.push(id);
    }
  }

  if (ids.length) return uniqStrings(ids);

  const used = Array.isArray(out?.telemetrySample?.usedTechniques) ? out.telemetrySample.usedTechniques : [];
  for (const t of used) {
    const id = String(t?.id || "").trim();
    if (id) ids.push(id);
  }

  return uniqStrings(ids);
}

function summarizeSkeletons(out) {
  const skels = Array.isArray(out?.telemetrySample?.replayContext?.adjustmentSkeletons)
    ? out.telemetrySample.replayContext.adjustmentSkeletons
    : [];

  const summary = skels
    .map((s) => {
      const refs = Array.isArray(s?.techniqueRefs)
        ? s.techniqueRefs.map((r) => String(r?.id || "")).filter(Boolean)
        : [];
      return {
        impactArea: String(s?.impactArea || ""),
        ruleId: String(s?.ruleId || ""),
        doActionSelection: String(s?.doActionSelection || "(unset)"),
        techniqueRefs: stableSortStrings(refs),
      };
    })
    .sort((a, b) => a.impactArea.localeCompare(b.impactArea) || a.ruleId.localeCompare(b.ruleId));

  return summary;
}

function filterWarnings(warnings, patterns) {
  const pats = patterns?.length ? patterns : [];
  return uniqStrings(
    (Array.isArray(warnings) ? warnings : [])
      .map((w) => String(w || ""))
      .filter((w) => (pats.length ? pats.some((p) => w.includes(p)) : true)),
  );
}

async function runLookReplicatePipelineWithMockLookSpecs({
  market,
  locale,
  preferenceMode,
  referenceLookSpec,
  selfieLookSpec,
  enableSelfieLookSpec,
  provideSelfieImage,
  similarityReportOverride,
  env,
}) {
  const layer1Bundle = readJson("fixtures/contracts/us/layer1BundleV0.sample.json");
  if (similarityReportOverride) {
    layer1Bundle.similarityReport = similarityReportOverride;
  }
  const referenceImagePath = writeTempJpeg("pivota-lookrep-verify");

  try {
    const baseEnv = {
      API_MODE: "MOCK",
      PIVOTA_API_KEY: "",
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "",
      PIVOTA_GEMINI_API_KEY: "",
      GOOGLE_API_KEY: "",
      ENABLE_STARTER_KB: "0",
      EXPERIMENT_MORE_CANDIDATES_ENABLED: "0",
      ...(env || {}),
    };

    return await withEnv(baseEnv, async () => {
      return await withMockedExtractLookSpec({ referenceLookSpec, selfieLookSpec }, async () => {
        const { runLookReplicatePipeline } = require(path.join(repoRoot(), "src", "lookReplicator", "lookReplicatePipeline"));
        const shouldProvideSelfieImage = typeof provideSelfieImage === "boolean" ? provideSelfieImage : Boolean(enableSelfieLookSpec);
        return await runLookReplicatePipeline({
          market,
          locale,
          preferenceMode: preferenceMode ?? "structure",
          jobId: `verify_${market}_${locale}`,
          referenceImage: { path: referenceImagePath, contentType: "image/jpeg" },
          ...(enableSelfieLookSpec && shouldProvideSelfieImage
            ? { selfieImage: { path: referenceImagePath, contentType: "image/jpeg" } }
            : {}),
          layer1Bundle,
        });
      });
    });
  } finally {
    fs.rmSync(referenceImagePath, { force: true });
  }
}

module.exports = {
  repoRoot,
  readJson,
  stableSortStrings,
  uniqStrings,
  collectTechniqueIds,
  summarizeSkeletons,
  filterWarnings,
  runLookReplicatePipelineWithMockLookSpecs,
};
