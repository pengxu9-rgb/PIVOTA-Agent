const fs = require('fs');
const path = require('path');

const { TechniqueCardV0Schema } = require('../schemas/techniqueCardV0');

let cached = null;

function loadTechniqueKBUS() {
  if (cached) return cached;

  const dir = path.join(__dirname, 'us', 'techniques');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));

  const byId = new Map();
  const list = [];

  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const parsed = TechniqueCardV0Schema.parse(raw);
    if (parsed.market !== 'US') {
      throw new Error(`Technique card ${parsed.id} market must be US (got ${parsed.market}).`);
    }
    if (byId.has(parsed.id)) {
      throw new Error(`Duplicate technique id: ${parsed.id}`);
    }
    byId.set(parsed.id, parsed);
    list.push(parsed);
  }

  cached = { byId, list };
  return cached;
}

module.exports = {
  loadTechniqueKBUS,
};

