const fs = require('fs');
const path = require('path');

const { TechniqueCardV0Schema } = require('../schemas/techniqueCardV0');

const cacheByMarket = new Map();

function loadTechniqueKB(market) {
  const m = String(market || '').trim().toUpperCase();
  if (m !== 'US' && m !== 'JP') throw new Error(`Invalid market: ${market}`);

  if (cacheByMarket.has(m)) return cacheByMarket.get(m);

  const dir = path.join(__dirname, m.toLowerCase(), 'techniques');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));

  const byId = new Map();
  const list = [];

  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
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

  const kb = { byId, list };
  cacheByMarket.set(m, kb);
  return kb;
}

module.exports = {
  loadTechniqueKB,
};

