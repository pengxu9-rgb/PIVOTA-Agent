const fs = require('fs');
const path = require('path');

const cache = new Map();

function dictPath(name) {
  return path.join(__dirname, name);
}

function readDictJson(name) {
  if (cache.has(name)) return cache.get(name);
  const raw = fs.readFileSync(dictPath(name), 'utf8');
  const parsed = JSON.parse(raw);
  cache.set(name, parsed);
  return parsed;
}

function resetDictCacheForTests() {
  cache.clear();
}

module.exports = {
  readDictJson,
  resetDictCacheForTests,
};

