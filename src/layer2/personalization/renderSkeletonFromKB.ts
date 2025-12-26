import { AdjustmentSkeletonV0, AdjustmentSkeletonImpactArea } from "../schemas/adjustmentSkeletonV0";
import type { TechniqueKBUS } from "../kb/loadTechniqueKBUS";
import type { TechniqueMatchContext } from "../kb/evalTechniqueTriggers";

function uniqueStrings(items: readonly string[]): string[] {
  return Array.from(new Set(items.map((s) => String(s || "").trim()).filter(Boolean)));
}

function renderTemplateStep(step: string, variables: Record<string, string>): string {
  return String(step || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name) => variables[name] ?? "");
}

function defaultVariablesForArea(area: AdjustmentSkeletonImpactArea): Record<string, string> {
  if (area === "eye") return { linerAngleHint: "angle slightly more horizontal" };
  return {};
}

function fallbackStepsForArea(area: AdjustmentSkeletonImpactArea): string[] {
  if (area === "base") return ["Apply a thin base layer.", "Spot-correct only where needed.", "Set only where needed."];
  if (area === "eye") return ["Start liner from the outer third.", "Keep the line thin.", "Keep the wing short."];
  return ["Match the reference finish.", "Stay in a close shade family.", "Blot lightly to adjust intensity."];
}

export type RenderSkeletonsFromKBOutput = {
  skeletons: [AdjustmentSkeletonV0, AdjustmentSkeletonV0, AdjustmentSkeletonV0];
  warnings: string[];
  usedFallback: boolean;
};

export function renderSkeletonFromKB(
  inputSkeletons: readonly AdjustmentSkeletonV0[],
  kb: TechniqueKBUS,
  ctx: TechniqueMatchContext,
): RenderSkeletonsFromKBOutput {
  const warnings: string[] = [];
  let usedFallback = false;

  const out = inputSkeletons.map((s) => {
    const doActionIds = Array.isArray(s.doActionIds) ? s.doActionIds : [];
    const variables = defaultVariablesForArea(s.impactArea);
    const doActions: string[] = [];
    const techniqueRefs: Array<{ id: string; area: AdjustmentSkeletonImpactArea }> = [];
    const tags: string[] = Array.isArray(s.tags) ? [...s.tags] : [];

    for (const id of doActionIds) {
      const card = kb.byId.get(id);
      if (!card) {
        warnings.push(`Missing technique card: ${id} (area=${s.impactArea}).`);
        usedFallback = true;
        continue;
      }
      if (card.market !== "US") {
        warnings.push(`Technique card ${id} market is not US.`);
        usedFallback = true;
        continue;
      }
      if (card.area !== s.impactArea) {
        warnings.push(`Technique card ${id} area mismatch (expected ${s.impactArea}, got ${card.area}).`);
        usedFallback = true;
        continue;
      }

      techniqueRefs.push({ id: card.id, area: card.area });

      const renderedSteps = card.actionTemplate.steps.map((step) => renderTemplateStep(step, variables)).filter(Boolean);
      doActions.push(...renderedSteps);

      if (Array.isArray(card.productRoleHints)) {
        for (const hint of card.productRoleHints) tags.push(`role:${String(hint).trim()}`);
      }
    }

    const finalDoActions = uniqueStrings(doActions);
    if (!finalDoActions.length) {
      warnings.push(`No rendered doActions for ${s.impactArea}: using safe fallback steps.`);
      usedFallback = true;
      finalDoActions.push(...fallbackStepsForArea(s.impactArea));
    }

    return {
      ...s,
      doActions: finalDoActions,
      techniqueRefs: techniqueRefs.length ? techniqueRefs : undefined,
      tags: uniqueStrings(tags).length ? uniqueStrings(tags) : undefined,
    } as AdjustmentSkeletonV0;
  });

  // Preserve canonical ordering: base, eye, lip.
  const byArea: Record<AdjustmentSkeletonImpactArea, AdjustmentSkeletonV0 | undefined> = {
    base: out.find((s) => s.impactArea === "base"),
    eye: out.find((s) => s.impactArea === "eye"),
    lip: out.find((s) => s.impactArea === "lip"),
  };
  if (!byArea.base || !byArea.eye || !byArea.lip) {
    throw new Error("renderSkeletonFromKB requires one skeleton per impactArea.");
  }

  return { skeletons: [byArea.base, byArea.eye, byArea.lip], warnings, usedFallback };
}
