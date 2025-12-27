import fs from "fs";
import path from "path";

type DictName =
  | "trigger_keys_v0.json"
  | "lookspec_lexicon_v0.json"
  | "roles_v0.json"
  | "intents_v0.json"
  | "vibe_tags_us_v0.json"
  | "vibe_tags_jp_v0.json";

const cache = new Map<DictName, unknown>();

function dictPath(name: DictName): string {
  return path.join(__dirname, name);
}

export function readDictJson(name: DictName): unknown {
  if (cache.has(name)) return cache.get(name);
  const raw = fs.readFileSync(dictPath(name), "utf8");
  const parsed = JSON.parse(raw);
  cache.set(name, parsed);
  return parsed;
}

export function resetDictCacheForTests() {
  cache.clear();
}

