const { z } = require('zod');

const MarketSchema = z.enum(['US', 'JP']);

function normalizeMarket(input, fallback = 'US') {
  const s = String(input || '').trim().toUpperCase();
  if (s === 'US' || s === 'JP') return s;
  return fallback;
}

function parseMarketFromRequest(input, defaultMarket = 'US') {
  const raw = String(input || '').trim();
  if (!raw) return defaultMarket;
  const s = raw.toUpperCase();
  if (s === 'US' || s === 'JP') return s;
  const err = new Error(`Market not supported: ${raw}`);
  err.code = 'MARKET_NOT_SUPPORTED';
  err.httpStatus = 400;
  throw err;
}

function isMarketEnabled(market) {
  if (market === 'US') return true;
  const enabled = String(process.env.ENABLE_MARKET_JP || '').trim().toLowerCase();
  return enabled === '1' || enabled === 'true';
}

function requireMarketEnabled(market) {
  if (isMarketEnabled(market)) return;
  const err = new Error(`Market ${market} is disabled`);
  err.code = 'MARKET_DISABLED';
  err.httpStatus = 403;
  throw err;
}

module.exports = {
  MarketSchema,
  normalizeMarket,
  parseMarketFromRequest,
  isMarketEnabled,
  requireMarketEnabled,
};
