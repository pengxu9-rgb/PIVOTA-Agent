const fs = require('fs');
const path = require('path');
const { EvalSampleSchema } = require('./schema');

function defaultDatasetPath() {
  return path.join(process.cwd(), 'data', 'eval', 'us', 'layer1_samples.jsonl');
}

function loadJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Dataset not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const samples = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let json;
    try {
      json = JSON.parse(line);
    } catch (err) {
      throw new Error(`Invalid JSON on line ${i + 1}`);
    }
    const parsed = EvalSampleSchema.safeParse(json);
    if (!parsed.success) {
      const msg = JSON.stringify(parsed.error.format());
      throw new Error(`Invalid sample on line ${i + 1}: ${msg}`);
    }
    samples.push(parsed.data);
  }
  return samples;
}

module.exports = {
  defaultDatasetPath,
  loadJsonl,
};

