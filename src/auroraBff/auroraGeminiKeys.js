function readGeminiEnv(name) {
  if (!name) return '';
  return String(process.env[name] || '').trim();
}

function resolveAuroraGeminiKey(featureKeyName) {
  return (
    readGeminiEnv(featureKeyName) ||
    readGeminiEnv('AURORA_SKIN_GEMINI_API_KEY') ||
    readGeminiEnv('GEMINI_API_KEY') ||
    readGeminiEnv('GOOGLE_API_KEY')
  );
}

module.exports = {
  resolveAuroraGeminiKey,
};
