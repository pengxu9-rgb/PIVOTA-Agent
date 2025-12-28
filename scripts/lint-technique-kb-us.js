const { loadTechniqueKBUS } = require('../src/layer2/kb/loadTechniqueKBUS');

const { loadTriggerKeysLatest, isTriggerKeyAllowed } = require('../src/layer2/dicts/triggerKeys');

function hasForbiddenLanguageGatingTrigger(card) {
  const triggers = card.triggers || {};
  const conditions = [...(triggers.all || []), ...(triggers.any || []), ...(triggers.none || [])];
  return conditions.some((c) => {
    if (!c || c.key !== 'preferenceMode') return false;
    if (c.op === 'eq' || c.op === 'neq') return c.value === 'en' || c.value === 'zh';
    if (c.op === 'in') return Array.isArray(c.value) && (c.value.includes('en') || c.value.includes('zh'));
    return Array.isArray(c.value) && (c.value.includes('en') || c.value.includes('zh'));
  });
}

function main() {
  const kb = loadTechniqueKBUS();
  const triggerKeys = loadTriggerKeysLatest();
  const ids = new Set();
  const errors = [];
  const langPairs = new Map();

  for (const c of kb.list) {
    if (!c.id) errors.push(`Missing id in card: ${JSON.stringify(c).slice(0, 120)}`);
    if (ids.has(c.id)) errors.push(`Duplicate id: ${c.id}`);
    ids.add(c.id);

    const steps = c.actionTemplate?.steps || [];
    if (!Array.isArray(steps) || !steps.length) errors.push(`Empty actionTemplate.steps: ${c.id}`);
    for (const step of steps) {
      if (!String(step || '').trim()) errors.push(`Empty step string: ${c.id}`);
    }

    const triggers = c.triggers || {};
    const conditions = [...(triggers.all || []), ...(triggers.any || []), ...(triggers.none || [])];
    for (const cond of conditions) {
      if (!isTriggerKeyAllowed(cond.key, triggerKeys)) errors.push(`Disallowed trigger key (${c.id}): ${cond.key}`);
    }

    const id = String(c.id || '');
    const baseId = id.replace(/-(zh|en)$/, '');
    if (id.endsWith('-zh') || id.endsWith('-en')) {
      const cur = langPairs.get(baseId) || { zh: false, en: false };
      if (id.endsWith('-zh')) cur.zh = true;
      if (id.endsWith('-en')) cur.en = true;
      langPairs.set(baseId, cur);
    }
    if ((id.endsWith('-zh') || id.endsWith('-en')) && hasForbiddenLanguageGatingTrigger(c)) {
      errors.push(`Bilingual card must not gate language via triggers.preferenceMode (en/zh): ${id}`);
    }
  }

  // Optional pairing check: warn by default, fail if explicitly enabled.
  const requirePairs = process.argv.includes('--strict-pairs') || process.env.KB_LINT_REQUIRE_LANG_PAIRS === '1';
  const pairErrors = [];
  for (const [baseId, pair] of langPairs.entries()) {
    if (!pair.zh || !pair.en) pairErrors.push(`Missing bilingual pair for baseId=${baseId} (zh=${pair.zh}, en=${pair.en})`);
  }
  if (pairErrors.length) {
    const tag = requirePairs ? 'FAILED' : 'WARN';
    console.warn(`[lint:kb:us] ${tag}: bilingual pairing check`);
    for (const e of pairErrors) console.warn(`- ${e}`);
    if (requirePairs) errors.push(...pairErrors);
  }

  if (errors.length) {
    console.error('[lint:kb:us] FAILED');
    for (const e of errors) console.error(`- ${e}`);
    process.exit(1);
  }

  console.log(`[lint:kb:us] OK (${kb.list.length} technique cards).`);
}

main();
