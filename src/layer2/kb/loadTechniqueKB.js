const fs = require('fs');
const path = require('path');

const { TechniqueCardV0Schema } = require('../schemas/techniqueCardV0');

const cacheByMarket = new Map();

function parseEnvBool(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return null;
}

function isStarterKbEnabled() {
  const fromEnv = parseEnvBool(process.env.ENABLE_STARTER_KB);
  if (fromEnv !== null) return fromEnv;
  return process.env.NODE_ENV !== 'production';
}

function loadTechniqueKB(market) {
  const m = String(market || '').trim().toUpperCase();
  if (m !== 'US' && m !== 'JP') throw new Error(`Invalid market: ${market}`);

  const starterEnabled = isStarterKbEnabled();
  const cacheKey = `${m}:${starterEnabled ? 1 : 0}`;
  if (cacheByMarket.has(cacheKey)) return cacheByMarket.get(cacheKey);

  const marketDir = path.join(__dirname, m.toLowerCase());
  const primaryDir = path.join(marketDir, 'techniques');
  const starterDir = path.join(marketDir, 'starter');

  const listJsonFiles = (dir) => {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort((a, b) => a.localeCompare(b))
      .map((f) => path.join(dir, f));
  };

  const byId = new Map();
  const list = [];

  // Load primary techniques first (canonical).
  for (const filePath of listJsonFiles(primaryDir)) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const parsed = TechniqueCardV0Schema.parse(raw);
    if (parsed.market !== m) {
      throw new Error(`Technique card ${parsed.id} market must be ${m} (got ${parsed.market}).`);
    }
    if (byId.has(parsed.id)) {
      throw new Error(`Duplicate technique id: ${parsed.id}`);
    }
    byId.set(parsed.id, parsed);
    list.push(parsed);
  }

  // Load starter cards as a fallback layer: only add when missing in primary.
  if (starterEnabled) {
    for (const filePath of listJsonFiles(starterDir)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const parsed = TechniqueCardV0Schema.parse(raw);
      if (parsed.market !== m) {
        throw new Error(`Technique card ${parsed.id} market must be ${m} (got ${parsed.market}).`);
      }
      if (byId.has(parsed.id)) continue;
      byId.set(parsed.id, parsed);
      list.push(parsed);
    }
  }

  const kb = { byId, list };
  cacheByMarket.set(cacheKey, kb);
  return kb;
}

module.exports = {
  loadTechniqueKB,
};
