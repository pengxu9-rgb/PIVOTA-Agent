const path = require('path');

const { readDictJson } = require('../src/layer2/dicts/loadDicts');
const { loadTechniqueKB } = require('../src/layer2/kb/loadTechniqueKB');
const { isTriggerKeyAllowed } = require('../src/layer2/dicts/triggerKeys');

function fail(message) {
  // eslint-disable-next-line no-console
  console.error(`[lint:dicts] ERROR: ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  // eslint-disable-next-line no-console
  console.log(`[lint:dicts] ${message}`);
}

function isAsciiString(value) {
  if (typeof value !== 'string') return false;
  for (const ch of value) {
    if (ch.charCodeAt(0) > 127) return false;
  }
  return true;
}

function isId(value) {
  return typeof value === 'string' && value.length > 0 && isAsciiString(value) && !/\s/.test(value);
}

function assertCount(name, n, min, max) {
  if (n < min || n > max) {
    fail(`${name} count must be in [${min}..${max}] (got ${n}).`);
  }
}

function assertUniqueIds(name, ids) {
  const seen = new Set();
  for (const id of ids) {
    if (!isId(id)) {
      fail(`${name} id must be non-empty ASCII with no whitespace (got ${JSON.stringify(id)}).`);
      continue;
    }
    if (seen.has(id)) {
      fail(`${name} ids must be unique (duplicate: ${id}).`);
      continue;
    }
    seen.add(id);
  }
  return seen;
}

function walkTriggerConditions(triggers) {
  const out = [];
  if (!triggers || typeof triggers !== 'object') return out;

  for (const groupKey of ['all', 'any', 'none']) {
    const list = Array.isArray(triggers[groupKey]) ? triggers[groupKey] : [];
    for (const condition of list) {
      if (!condition || typeof condition !== 'object') continue;
      if (typeof condition.key === 'string') out.push(condition.key);
    }
  }

  return out;
}

function lintVibeTags(market) {
  const file = market === 'US' ? 'vibe_tags_us_v0.json' : 'vibe_tags_jp_v0.json';
  const dict = readDictJson(file);
  if (dict?.schemaVersion !== 'v0') fail(`${file}: schemaVersion must be "v0".`);
  if (dict?.market !== market) fail(`${file}: market must be "${market}".`);
  const tags = Array.isArray(dict?.tags) ? dict.tags : [];

  assertCount(`${file} tags`, tags.length, 20, 40);
  assertUniqueIds(`${file} tag`, tags.map((t) => t?.id));
}

function lintRoles(dictFile, version) {
  const dict = readDictJson(dictFile);
  if (dict?.schemaVersion !== version) fail(`${dictFile}: schemaVersion must be "${version}".`);
  const roles = Array.isArray(dict?.roles) ? dict.roles : [];

  assertCount(`${dictFile} roles`, roles.length, 30, 80);
  assertUniqueIds(
    `${dictFile} role`,
    roles.map((r) => r?.id),
  );

  for (const role of roles) {
    const synonyms = Array.isArray(role?.synonyms) ? role.synonyms : [];
    for (const s of synonyms) {
      if (typeof s !== 'string' || !s.trim()) {
        fail(`roles_v0.json: role ${role?.id} has an empty synonym.`);
      }
    }
  }
}

function techniqueIdSetForMarket(market) {
  const kb = loadTechniqueKB(market);
  const ids = new Set();
  for (const card of kb.list) ids.add(card.id);
  return ids;
}

function lintIntents() {
  lintIntentsFile('intents_v0.json', 'v0');
  lintIntentsFile('intents_v1.json', 'v1');
}

function lintIntentsFile(dictFile, version) {
  const dict = readDictJson(dictFile);
  if (dict?.schemaVersion !== version) fail(`${dictFile}: schemaVersion must be "${version}".`);
  const placeholders = Array.isArray(dict?.placeholders) ? dict.placeholders : [];
  const intents = Array.isArray(dict?.intents) ? dict.intents : [];

  assertCount(`${dictFile} intents`, intents.length, 12, 30);
  const placeholderSet = assertUniqueIds(`${dictFile} placeholder`, placeholders);
  const intentIdSet = assertUniqueIds(
    `${dictFile} intent`,
    intents.map((i) => i?.id),
  );

  const knownTechniqueIds = {
    US: techniqueIdSetForMarket('US'),
    JP: techniqueIdSetForMarket('JP'),
  };

  const allowedAreasV0 = new Set(['prep', 'base', 'contour', 'brow', 'eye', 'blush', 'lip']);
  const allowedAreasV1 = new Set(['prep', 'base', 'contour', 'brow', 'eye', 'blush', 'lip']);

  for (const intent of intents) {
    if (!intent || typeof intent !== 'object') continue;
    const area = intent.area;
    const allowedAreas = version === 'v1' ? allowedAreasV1 : allowedAreasV0;
    if (!allowedAreas.has(area)) {
      fail(
        `${dictFile}: intent ${intent?.id} area must be ${Array.from(allowedAreas).join('|')} (got ${JSON.stringify(area)}).`,
      );
    }

    const markets = intent.markets || {};
    for (const market of ['US', 'JP']) {
      const m = markets[market] || {};
      const techniqueIds = Array.isArray(m.techniqueIds) ? m.techniqueIds : [];
      if (techniqueIds.length === 0) {
        fail(`${dictFile}: intent ${intent?.id} must define markets.${market}.techniqueIds (non-empty).`);
        continue;
      }

      for (const tid of techniqueIds) {
        if (!isId(tid)) {
          fail(`${dictFile}: intent ${intent?.id} markets.${market}.techniqueIds contains invalid id ${JSON.stringify(tid)}.`);
          continue;
        }
        const exists = knownTechniqueIds[market].has(tid);
        const isPlaceholder = placeholderSet.has(tid);
        if (!exists && !isPlaceholder) {
          fail(
            `${dictFile}: intent ${intent?.id} markets.${market}.techniqueIds references missing technique id ${tid}.`,
          );
        }
      }
    }
  }

  // A tiny sanity check: if something references a placeholder, it must be declared.
  ok(`Validated ${dictFile}: intents (${intentIdSet.size}) and placeholders (${placeholderSet.size}).`);
}

function lintTriggerKeysDict() {
  lintTriggerKeysFile('trigger_keys_v0.json', 'v0');
  lintTriggerKeysFile('trigger_keys_v1.json', 'v1');
}

function lintTriggerKeysFile(dictFile, version) {
  const dict = readDictJson(dictFile);
  if (dict?.schemaVersion !== version) fail(`${dictFile}: schemaVersion must be "${version}".`);
  const allowedPrefixes = Array.isArray(dict?.allowedPrefixes) ? dict.allowedPrefixes : [];
  if (allowedPrefixes.length === 0) fail(`${dictFile}: allowedPrefixes must be non-empty.`);
  for (const p of allowedPrefixes) {
    if (typeof p !== 'string' || !p.trim()) fail(`${dictFile}: allowedPrefixes contains empty entry.`);
    if (!isAsciiString(p)) fail(`${dictFile}: allowedPrefixes must be ASCII (got ${JSON.stringify(p)}).`);
  }
}

function lintTechniqueKBTriggers(market) {
  const kb = loadTechniqueKB(market);
  let bad = 0;

  for (const card of kb.list) {
    const keys = walkTriggerConditions(card.triggers);
    for (const k of keys) {
      if (!isTriggerKeyAllowed(k)) {
        bad += 1;
        fail(`Technique ${card.id} has disallowed trigger key: ${k}`);
      }
    }
  }

  if (bad === 0) ok(`Technique KB ${market}: all trigger keys are whitelisted.`);
}

function lintLookSpecLexicon() {
  lintLookSpecLexiconFile('lookspec_lexicon_v0.json', 'v0');
  lintLookSpecLexiconFile('lookspec_lexicon_v1.json', 'v1');
}

function lintLookSpecLexiconFile(dictFile, version) {
  const dict = readDictJson(dictFile);
  if (dict?.schemaVersion !== version) fail(`${dictFile}: schemaVersion must be "${version}".`);
  if (!dict?.markets?.US || !dict?.markets?.JP) fail(`${dictFile}: markets must include US and JP.`);
}

function main() {
  ok(`cwd=${path.resolve(process.cwd())}`);

  lintTriggerKeysDict();
  lintLookSpecLexicon();

  lintVibeTags('US');
  lintVibeTags('JP');
  ok('Validated vibe tag dicts.');

  lintRoles('roles_v0.json', 'v0');
  lintRoles('roles_v1.json', 'v1');
  ok('Validated roles dict.');

  lintIntents();
  lintTechniqueKBTriggers('US');
  lintTechniqueKBTriggers('JP');
}

main();
