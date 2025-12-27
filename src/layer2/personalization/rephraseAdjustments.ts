import fs from "fs";
import path from "path";
import { z } from "zod";

import { LlmError, LlmProvider, createProviderFromEnv } from "../../llm/provider";
import { AdjustmentSkeletonV0, AdjustmentSkeletonV0Schema } from "../schemas/adjustmentSkeletonV0";

import { RULE_TITLES_US } from "./rules/usAdjustmentRules";

export const Layer2AdjustmentV0Schema = z
  .object({
    impactArea: z.enum(["base", "eye", "lip"]),
    title: z.string().min(1),
    because: z.string().min(1),
    do: z.string().min(1),
    why: z.string().min(1),
    confidence: z.enum(["high", "medium", "low"]),
    evidence: z.array(z.string().min(1)).min(1),
    ruleId: z.string().min(1),
    techniqueRefs: z
      .array(
        z
          .object({
            id: z.string().min(1),
            area: z.enum(["base", "eye", "lip"]),
          })
          .strict()
      )
      .optional(),
  })
  .strict();

export type Layer2AdjustmentV0 = z.infer<typeof Layer2AdjustmentV0Schema>;

const RephraseOutputSchema = z
  .object({
    adjustments: z.array(Layer2AdjustmentV0Schema).length(3),
  })
  .strict();

export type RephraseAdjustmentsInput = {
  market: "US" | "JP";
  locale: string;
  skeletons: readonly AdjustmentSkeletonV0[];
  provider?: LlmProvider;
  promptPack?: { adjustmentsRephrase?: string };
};

export type RephraseAdjustmentsOutput = {
  adjustments: [Layer2AdjustmentV0, Layer2AdjustmentV0, Layer2AdjustmentV0];
  warnings: string[];
  usedFallback: boolean;
};

const promptCache = new Map<string, string>();

function readPromptOnce(filePath: string): string {
  const abs = path.resolve(filePath);
  const cached = promptCache.get(abs);
  if (cached) return cached;
  const txt = fs.readFileSync(abs, "utf8");
  promptCache.set(abs, txt);
  return txt;
}

function isJaLocale(locale: string): boolean {
  const s = String(locale || "").trim().toLowerCase();
  return s === "ja" || s.startsWith("ja-") || s.startsWith("ja_");
}

function loadPromptForMarket(market: "US" | "JP", locale: string): string {
  if (market === "US") return readPromptOnce(path.join(__dirname, "..", "prompts", "adjustments_rephrase_en.txt"));
  // JP prompts are Japanese-first; keep schema keys identical.
  return readPromptOnce(path.join(__dirname, "..", "prompts", "jp", "adjustments_rephrase_ja.txt"));
}

function normalizeText(s: string): string {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function ensurePeriod(s: string): string {
  const t = normalizeText(s);
  if (!t) return t;
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function humanTitleForRule(ruleId: string, impactArea: Layer2AdjustmentV0["impactArea"]): string {
  const t = RULE_TITLES_US[ruleId];
  if (t) return t;
  const prefix = impactArea === "base" ? "Base" : impactArea === "eye" ? "Eye" : "Lip";
  return `${prefix} adjustment`;
}

export function renderAdjustmentFromSkeleton(s: AdjustmentSkeletonV0): Layer2AdjustmentV0 {
  const doActions = Array.isArray(s.doActions) && s.doActions.length ? s.doActions : [
    ...(s.impactArea === "base"
      ? ["Apply a thin base layer.", "Spot-correct only where needed."]
      : s.impactArea === "eye"
        ? ["Start liner from the outer third.", "Keep the line thin and wing short."]
        : ["Match the reference finish.", "Stay in a close shade family."]),
  ];

  return Layer2AdjustmentV0Schema.parse({
    impactArea: s.impactArea,
    ruleId: s.ruleId,
    title: humanTitleForRule(s.ruleId, s.impactArea),
    because: ensurePeriod(s.becauseFacts.join(" ")),
    do: ensurePeriod(doActions.join(" ")),
    why: ensurePeriod(s.whyMechanism.join(" ")),
    confidence: s.confidence,
    evidence: s.evidenceKeys,
    techniqueRefs: s.techniqueRefs,
  });
}

function containsIdentityLanguage(text: string): boolean {
  const s = text.toLowerCase();
  if (/look like|resemble|celebrity|famous|actor|actress|singer|model/.test(s)) return true;
  // Japanese identity/celebrity phrasing (best-effort).
  return /有名人|芸能人|セレブ|そっくり|似ている|似てる|○○みたい/.test(text);
}

function collectAllowedNumbers(skeletons: readonly AdjustmentSkeletonV0[]): Set<string> {
  const s = JSON.stringify(skeletons);
  const nums = s.match(/\d+(\.\d+)?/g) || [];
  return new Set(nums);
}

function numbersOnlyFromSkeleton(text: string, allowed: Set<string>): boolean {
  const nums = text.match(/\d+(\.\d+)?/g) || [];
  return nums.every((n) => allowed.has(n));
}

function collectAllowedDoVerbsByArea(skeletons: readonly AdjustmentSkeletonV0[]): Record<"base" | "eye" | "lip", Set<string>> {
  const out: Record<"base" | "eye" | "lip", Set<string>> = {
    base: new Set(),
    eye: new Set(),
    lip: new Set(),
  };
  const toVerb = (s: string) => String(s || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
  for (const sk of skeletons) {
    const area = sk.impactArea;
    const steps = Array.isArray(sk.doActions) ? sk.doActions : [];
    for (const step of steps) {
      const v = toVerb(step);
      if (v) out[area].add(v);
    }
  }
  return out;
}

function extractDoVerbs(text: string): Set<string> {
  const verbs = new Set<string>();
  const pieces = String(text || "")
    .split(/[.!?;\n]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of pieces) {
    const v = p.split(/\s+/)[0]?.toLowerCase() || "";
    if (v) verbs.add(v);
  }
  return verbs;
}

function onlyUsesAllowedDoVerbs(doText: string, allowed: Set<string>): boolean {
  const okAux = new Set(["and", "then", "also", "try", "aim", "keep", "use", "add", "apply", "blend", "press"]);
  const verbs = extractDoVerbs(doText);
  for (const v of verbs) {
    if (okAux.has(v)) continue;
    if (!allowed.has(v)) return false;
  }
  return true;
}

function textContainsForbiddenAttributes(outputText: string, allowedText: string): string | null {
  // Conservative: block explicit trait assertions unless the token exists in the skeleton text.
  const forbiddenTokens = [
    "hooded",
    "downturned",
    "upturned",
    "thin lips",
    "oily skin",
    "dry skin",
    "pores",
    "wrinkles",
    "acne",
    "undertone",
    "warm",
    "cool",
    "skin type",
  ];
  const lowerOut = outputText.toLowerCase();
  const lowerAllowed = allowedText.toLowerCase();
  for (const tok of forbiddenTokens) {
    if (lowerOut.includes(tok) && !lowerAllowed.includes(tok)) return tok;
  }
  return null;
}

function ensureExactAreas(items: readonly Layer2AdjustmentV0[], warnings: string[]): [Layer2AdjustmentV0, Layer2AdjustmentV0, Layer2AdjustmentV0] {
  const byArea: Partial<Record<"base" | "eye" | "lip", Layer2AdjustmentV0>> = {};
  for (const a of items) {
    if (!a) continue;
    if (a.impactArea !== "base" && a.impactArea !== "eye" && a.impactArea !== "lip") continue;
    if (!byArea[a.impactArea]) byArea[a.impactArea] = a;
  }
  const out: [Layer2AdjustmentV0, Layer2AdjustmentV0, Layer2AdjustmentV0] = [
    byArea.base ?? (warnings.push("Missing base adjustment from LLM output."), null as any),
    byArea.eye ?? (warnings.push("Missing eye adjustment from LLM output."), null as any),
    byArea.lip ?? (warnings.push("Missing lip adjustment from LLM output."), null as any),
  ];
  if (!out[0] || !out[1] || !out[2]) {
    throw new Error("LLM output did not include exactly one adjustment per impactArea.");
  }
  return out;
}

export function validateNoNewFactsOrIdentity(
  skeletons: readonly AdjustmentSkeletonV0[],
  adjustments: readonly Layer2AdjustmentV0[],
  locale?: string
): { ok: true } | { ok: false; reason: string } {
  const allowedText = JSON.stringify(skeletons);
  const allowedNumbers = collectAllowedNumbers(skeletons);
  const allowedDoVerbsByArea = collectAllowedDoVerbsByArea(skeletons);
  const skipVerbCheck = isJaLocale(String(locale || ""));

  const skeletonByArea: Record<"base" | "eye" | "lip", AdjustmentSkeletonV0> = {
    base: skeletons.find((s) => s.impactArea === "base")!,
    eye: skeletons.find((s) => s.impactArea === "eye")!,
    lip: skeletons.find((s) => s.impactArea === "lip")!,
  };

  for (const a of adjustments) {
    const textBlob = `${a.title}\n${a.because}\n${a.do}\n${a.why}`;
    if (containsIdentityLanguage(textBlob)) return { ok: false, reason: "identity_language" };
    if (!numbersOnlyFromSkeleton(textBlob, allowedNumbers)) return { ok: false, reason: "new_numeric_claim" };
    const forbiddenAttr = textContainsForbiddenAttributes(textBlob, allowedText);
    if (forbiddenAttr) return { ok: false, reason: `new_trait:${forbiddenAttr}` };
    // For Japanese output, verb tokenization is unreliable; skip and rely on evidence + no-new-numbers.
    if (!skipVerbCheck && !onlyUsesAllowedDoVerbs(a.do, allowedDoVerbsByArea[a.impactArea])) {
      return { ok: false, reason: "new_action_verb" };
    }

    const sk = skeletonByArea[a.impactArea];
    if (a.ruleId !== sk.ruleId) return { ok: false, reason: "ruleId_mismatch" };
    if (!Array.isArray(a.evidence) || a.evidence.length < 1) return { ok: false, reason: "missing_evidence" };
    const allowedEvidence = new Set(sk.evidenceKeys);
    if (a.evidence.some((e) => !allowedEvidence.has(e))) return { ok: false, reason: "evidence_not_subset" };
  }

  return { ok: true };
}

export async function rephraseAdjustments(input: RephraseAdjustmentsInput): Promise<RephraseAdjustmentsOutput> {
  if (input.market !== "US" && input.market !== "JP") throw new Error("MARKET_NOT_SUPPORTED");
  const locale = String(input.locale || "en").trim() || "en";

  const skeletons = input.skeletons.map((s) => AdjustmentSkeletonV0Schema.parse(s));
  const warnings: string[] = [];

  const fallback = (): RephraseAdjustmentsOutput => {
    const rendered = skeletons.map(renderAdjustmentFromSkeleton) as [Layer2AdjustmentV0, Layer2AdjustmentV0, Layer2AdjustmentV0];
    return { adjustments: rendered, warnings, usedFallback: true };
  };

  let provider = input.provider ?? null;
  if (!provider) {
    try {
      provider = createProviderFromEnv("layer2_lookspec");
    } catch {
      warnings.push("LLM config missing: using deterministic adjustment renderer.");
      return fallback();
    }
  }

  const promptTemplate = input.promptPack?.adjustmentsRephrase || loadPromptForMarket(input.market, locale);
  const prompt =
    `${promptTemplate}\n\n` +
    `INPUT_JSON:\n` +
    JSON.stringify(
      {
        market: input.market,
        locale,
        skeletons,
      },
      null,
      2
    );

  try {
    const parsed = await provider.analyzeTextToJson({
      prompt,
      schema: RephraseOutputSchema,
    });

    const fixed = ensureExactAreas(parsed.adjustments, warnings);
    const validation = validateNoNewFactsOrIdentity(skeletons, fixed, locale);
    if (!validation.ok) {
      warnings.push(`LLM output rejected (${validation.reason}): using deterministic adjustment renderer.`);
      return fallback();
    }

    return { adjustments: fixed, warnings, usedFallback: false };
  } catch (err) {
    if (err instanceof LlmError) {
      warnings.push(`LLM failed (${err.code}): ${String(err.message || "").slice(0, 220)}`);
    } else {
      warnings.push("LLM failed: using deterministic adjustment renderer.");
    }
    return fallback();
  }
}
