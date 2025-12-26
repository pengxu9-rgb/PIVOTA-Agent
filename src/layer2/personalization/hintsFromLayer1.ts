type HintsByArea = {
  base: string[];
  eye: string[];
  lip: string[];
};

function slugify(input: string): string {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function uniq(xs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    const v = String(x || "").trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function hintsFromLayer1(similarityReport: any | null | undefined): HintsByArea {
  const out: HintsByArea = { base: [], eye: [], lip: [] };
  if (!similarityReport || typeof similarityReport !== "object") return out;

  const layer2Hints = similarityReport.layer2Hints;
  if (layer2Hints && typeof layer2Hints === "object") {
    if (Array.isArray(layer2Hints.base)) out.base.push(...layer2Hints.base);
    if (Array.isArray(layer2Hints.eye)) out.eye.push(...layer2Hints.eye);
    if (Array.isArray(layer2Hints.lip)) out.lip.push(...layer2Hints.lip);
  }

  const adjustments = similarityReport.adjustments;
  if (Array.isArray(adjustments)) {
    for (const a of adjustments) {
      const impactAreaRaw: unknown = (a as any)?.impactArea;
      if (impactAreaRaw !== "base" && impactAreaRaw !== "eye" && impactAreaRaw !== "lip") continue;
      const impactArea: "base" | "eye" | "lip" = impactAreaRaw;
      const title = typeof a?.title === "string" ? a.title : "";
      if (title) out[impactArea].push(`layer1.adjustment.${impactArea}.${slugify(title)}`);
    }
  }

  out.base = uniq(out.base).slice(0, 12);
  out.eye = uniq(out.eye).slice(0, 12);
  out.lip = uniq(out.lip).slice(0, 12);
  return out;
}

export type { HintsByArea };
