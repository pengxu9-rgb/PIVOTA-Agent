import { LlmProvider } from "../../llm/provider";
import { normalizeLookSpecToV1 } from "../schemas/lookSpecV1";
import { rephraseAdjustments, Layer2AdjustmentV0, Layer2AdjustmentV0Schema } from "./rephraseAdjustments";
import { runAdjustmentRulesUS } from "./rules/runAdjustmentRulesUS";
import { loadTechniqueKBUS } from "../kb/loadTechniqueKBUS";
import { renderSkeletonFromKB } from "./renderSkeletonFromKB";
import type { AdjustmentSkeletonV0 } from "../schemas/adjustmentSkeletonV0";

export { Layer2AdjustmentV0Schema };
export type { Layer2AdjustmentV0 };

// Use the existing Layer1 JS schemas as runtime validators.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { FaceProfileV0Schema } = require("../../layer1/schemas/faceProfileV0");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SimilarityReportV0Schema } = require("../../layer1/schemas/similarityReportV0");

export type GenerateAdjustmentsInput = {
  market: "US";
  locale: string;
  userFaceProfile?: unknown | null;
  refFaceProfile?: unknown | null;
  similarityReport?: unknown | null;
  lookSpec: unknown;
  preferenceMode?: "structure" | "vibe" | "ease";
  provider?: LlmProvider;
};

export type GenerateAdjustmentsOutput = {
  adjustments: [Layer2AdjustmentV0, Layer2AdjustmentV0, Layer2AdjustmentV0];
  warnings: string[];
  usedFallback: boolean;
  skeletons: [AdjustmentSkeletonV0, AdjustmentSkeletonV0, AdjustmentSkeletonV0];
};

export async function generateAdjustments(input: GenerateAdjustmentsInput): Promise<GenerateAdjustmentsOutput> {
  if (input.market !== "US") {
    throw new Error("Only market=US is supported for Layer2 personalization.");
  }

  const locale = String(input.locale || "en").trim() || "en";

  const lookSpec = normalizeLookSpecToV1(input.lookSpec);
  const userFace = input.userFaceProfile == null ? null : FaceProfileV0Schema.parse(input.userFaceProfile);
  const refFace = input.refFaceProfile == null ? null : FaceProfileV0Schema.parse(input.refFaceProfile);
  const similarityReport = input.similarityReport == null ? null : SimilarityReportV0Schema.parse(input.similarityReport);

  const warnings: string[] = [];
  if (refFace == null) warnings.push("Missing refFaceProfile: rules will use safer defaults.");
  if (userFace == null) warnings.push("Missing userFaceProfile: rules will use safer defaults.");

  const preferenceMode =
    input.preferenceMode ??
    (similarityReport ? String(similarityReport.preferenceMode || "structure") : "structure");

  const skeletons = runAdjustmentRulesUS({
    userFaceProfile: userFace,
    refFaceProfile: refFace,
    similarityReport,
    lookSpec,
    preferenceMode: preferenceMode as any,
  });

  const kb = loadTechniqueKBUS();
  const rendered = renderSkeletonFromKB(
    skeletons,
    kb,
    {
      userFaceProfile: userFace,
      refFaceProfile: refFace,
      similarityReport,
      lookSpec,
      locale,
      preferenceMode: preferenceMode as any,
    },
  );
  warnings.push(...rendered.warnings);

  const rephrased = await rephraseAdjustments({
    market: "US",
    locale,
    skeletons: rendered.skeletons,
    provider: input.provider,
  });

  const parsed = rephrased.adjustments.map((a) => Layer2AdjustmentV0Schema.parse(a)) as [
    Layer2AdjustmentV0,
    Layer2AdjustmentV0,
    Layer2AdjustmentV0
  ];

  // Always enforce evidence non-empty.
  for (const a of parsed) {
    if (!a.evidence?.length) {
      warnings.push(`Adjustment ${a.impactArea} missing evidence: using skeleton evidenceKeys.`);
      const sk = rendered.skeletons.find((s) => s.impactArea === a.impactArea);
      if (sk) a.evidence = sk.evidenceKeys;
    }
  }

  warnings.push(...(rephrased.warnings || []));

  const usedFallback = Boolean(rendered.usedFallback) || Boolean(rephrased.usedFallback);
  return { adjustments: parsed, warnings, usedFallback, skeletons: rendered.skeletons };
}
