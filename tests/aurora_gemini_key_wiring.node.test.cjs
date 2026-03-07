const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readSource(relPath) {
  const fullPath = path.join(__dirname, '..', relPath);
  return fs.readFileSync(fullPath, 'utf8');
}

test('diagEnsemble uses Gemini global gate helper for diag Gemini calls', () => {
  const source = readSource('src/auroraBff/diagEnsemble.js');
  assert.match(source, /callAuroraGeminiGenerateContent/);
  assert.match(source, /hasAuroraGeminiApiKey/);
  assert.equal(
    source.includes('process.env.AURORA_SKIN_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY'),
    false,
  );
});

test('recoPrelabelGemini uses Gemini global gate helper for reco Gemini calls', () => {
  const source = readSource('src/auroraBff/recoPrelabelGemini.js');
  assert.match(source, /callAuroraGeminiGenerateContent/);
  assert.match(source, /hasAuroraGeminiApiKey/);
  assert.equal(
    source.includes('process.env.AURORA_SKIN_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY'),
    false,
  );
});

test('skinLlmGateway uses Gemini global gate with feature-specific vision key fallback', () => {
  const source = readSource('src/auroraBff/skinLlmGateway.js');
  assert.match(source, /resolveAuroraGeminiKey\('AURORA_VISION_GEMINI_API_KEY'\)/);
  assert.match(source, /getGeminiGlobalGate/);
  assert.equal(
    source.includes('process.env.AURORA_SKIN_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY'),
    false,
  );
});

test('routes uses feature-specific vision Gemini key resolver', () => {
  const source = readSource('src/auroraBff/routes.js');
  assert.match(source, /callAuroraGeminiGenerateContent/);
  assert.match(source, /hasAuroraGeminiApiKey/);
  assert.equal(
    source.includes('process.env.AURORA_SKIN_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY'),
    false,
  );
});

test('aurora chat v2 llm gateway uses Gemini global gate only and has no OpenAI fallback chain', () => {
  const source = readSource('src/auroraBff/services/llm_gateway.js');
  assert.match(source, /getGeminiGlobalGate/);
  assert.match(source, /getApiKey/);
  assert.equal(source.includes("process.env.AURORA_CHAT_V2_GEMINI_API_KEY"), false);
  assert.equal(source.includes('OPENAI_API_KEY'), false);
  assert.equal(source.includes('_callOpenAI'), false);
  assert.equal(source.includes('fallbackProvider'), false);
});
