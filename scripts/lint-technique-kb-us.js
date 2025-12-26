const { loadTechniqueKBUS } = require('../src/layer2/kb/loadTechniqueKBUS');

const ALLOWED_PREFIXES = [
  'preferenceMode',
  'userFaceProfile.geometry.',
  'userFaceProfile.quality.',
  'userFaceProfile.categorical.',
  'refFaceProfile.geometry.',
  'refFaceProfile.quality.',
  'refFaceProfile.categorical.',
  'lookSpec.breakdown.base.',
  'lookSpec.breakdown.eye.',
  'lookSpec.breakdown.lip.',
  'similarityReport.',
];

function isAllowedKey(key) {
  const s = String(key || '');
  if (!s) return false;
  if (s.includes('__proto__') || s.includes('constructor') || s.includes('prototype')) return false;
  return ALLOWED_PREFIXES.some((p) => s === p || s.startsWith(p));
}

function main() {
  const kb = loadTechniqueKBUS();
  const ids = new Set();
  const errors = [];

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
      if (!isAllowedKey(cond.key)) errors.push(`Disallowed trigger key (${c.id}): ${cond.key}`);
    }
  }

  if (errors.length) {
    console.error('[lint:kb:us] FAILED');
    for (const e of errors) console.error(`- ${e}`);
    process.exit(1);
  }

  console.log(`[lint:kb:us] OK (${kb.list.length} technique cards).`);
}

main();

