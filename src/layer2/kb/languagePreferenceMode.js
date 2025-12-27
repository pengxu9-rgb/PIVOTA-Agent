function normalizeLangToken(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
}

function langFromToken(raw) {
  const s = normalizeLangToken(raw || "");
  if (!s) return null;
  if (s === "zh" || s.startsWith("zh-")) return "zh";
  if (s === "en" || s.startsWith("en-")) return "en";
  return null;
}

function langFromAcceptLanguage(header) {
  const s = normalizeLangToken(header || "");
  if (!s) return null;

  const first = (s.split(",")[0] || "").trim();
  const firstToken = (first.split(";")[0] || "").trim();
  return langFromToken(firstToken) || (s.includes("zh") ? "zh" : null);
}

function inferTechniqueLanguagePreferenceMode(input) {
  return (
    langFromToken(input && input.userLanguage) ||
    langFromToken(input && input.appLanguage) ||
    langFromToken(input && input.locale) ||
    langFromAcceptLanguage(input && input.acceptLanguage) ||
    "en"
  );
}

module.exports = {
  inferTechniqueLanguagePreferenceMode,
};

