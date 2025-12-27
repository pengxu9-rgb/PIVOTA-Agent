export type TechniqueLanguagePreferenceMode = "zh" | "en";

export type InferTechniqueLanguageInput = {
  userLanguage?: string | null;
  appLanguage?: string | null;
  locale?: string | null;
  acceptLanguage?: string | null;
};

function normalizeLangToken(raw: string): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
}

function langFromToken(raw: string | null | undefined): TechniqueLanguagePreferenceMode | null {
  const s = normalizeLangToken(raw ?? "");
  if (!s) return null;
  if (s === "zh" || s.startsWith("zh-")) return "zh";
  if (s === "en" || s.startsWith("en-")) return "en";
  return null;
}

function langFromAcceptLanguage(header: string | null | undefined): TechniqueLanguagePreferenceMode | null {
  const s = normalizeLangToken(header ?? "");
  if (!s) return null;

  // Example: "zh-CN,zh;q=0.9,en;q=0.8" -> "zh-CN"
  const first = s.split(",")[0]?.trim() || "";
  const firstToken = first.split(";")[0]?.trim() || "";
  return langFromToken(firstToken) ?? (s.includes("zh") ? "zh" : null);
}

export function inferTechniqueLanguagePreferenceMode(input: InferTechniqueLanguageInput): TechniqueLanguagePreferenceMode {
  return (
    langFromToken(input.userLanguage) ??
    langFromToken(input.appLanguage) ??
    langFromToken(input.locale) ??
    langFromAcceptLanguage(input.acceptLanguage) ??
    "en"
  );
}

