const fs = require('fs');
const path = require('path');

const { normalizeMarket, requireMarketEnabled } = require('./market');
const { loadTechniqueKB } = require('../layer2/kb/loadTechniqueKB');

const { loadLookSpecLexiconV0 } = require('../layer2/dicts/lookSpecLexicon');

const promptCache = new Map();

function readPromptOnce(filePath) {
  const abs = path.resolve(filePath);
  const cached = promptCache.get(abs);
  if (cached) return cached;
  const txt = fs.readFileSync(abs, 'utf8');
  promptCache.set(abs, txt);
  return txt;
}

function isJaLocale(locale) {
  const s = String(locale || '').trim().toLowerCase();
  return s === 'ja' || s.startsWith('ja-') || s.startsWith('ja_');
}

function isZhLocale(locale) {
  const s = String(locale || '').trim().toLowerCase().replace(/_/g, '-');
  return s === 'zh' || s.startsWith('zh-');
}

function getPromptPack({ market, locale }) {
  if (market === 'US') {
    const zh = isZhLocale(locale);
    return {
      lookSpecExtract: readPromptOnce(path.join(__dirname, '..', 'layer2', 'prompts', 'lookSpec_extract_en.txt')),
      adjustmentsRephrase: readPromptOnce(
        path.join(__dirname, '..', 'layer2', 'prompts', zh ? 'adjustments_rephrase_zh.txt' : 'adjustments_rephrase_en.txt'),
      ),
      stepsGenerate: readPromptOnce(path.join(__dirname, '..', 'layer2', 'prompts', zh ? 'steps_generate_zh.txt' : 'steps_generate_en.txt')),
    };
  }

  // JP: prefer Japanese output when locale starts with "ja".
  const ja = isJaLocale(locale);
  return {
    lookSpecExtract: readPromptOnce(path.join(__dirname, '..', 'layer2', 'prompts', 'jp', ja ? 'lookSpec_extract_ja.txt' : 'lookSpec_extract_ja.txt')),
    adjustmentsRephrase: readPromptOnce(
      path.join(__dirname, '..', 'layer2', 'prompts', 'jp', ja ? 'adjustments_rephrase_ja.txt' : 'adjustments_rephrase_ja.txt'),
    ),
    stepsGenerate: readPromptOnce(path.join(__dirname, '..', 'layer2', 'prompts', 'jp', ja ? 'steps_generate_ja.txt' : 'steps_generate_ja.txt')),
  };
}

function getLookSpecLexicon(market) {
  return loadLookSpecLexiconV0(market);
}

function getMarketPack(input) {
  const defaultMarket = normalizeMarket(process.env.DEFAULT_MARKET, 'US');
  const market = normalizeMarket(input?.market, defaultMarket);
  requireMarketEnabled(market);

  const defaultLocale = market === 'JP' ? 'ja-JP' : 'en-US';

  return {
    market,
    defaultLocale,
    commerceEnabled: market === 'US',
    getLookSpecLexicon: () => getLookSpecLexicon(market),
    loadTechniqueKB: () => loadTechniqueKB(market),
    getPromptPack: (locale) => getPromptPack({ market, locale }),
  };
}

module.exports = {
  getMarketPack,
};
