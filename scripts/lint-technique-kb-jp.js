const { loadTechniqueKB } = require('../src/layer2/kb/loadTechniqueKB');
const { loadTriggerKeysV0, isTriggerKeyAllowed } = require('../src/layer2/dicts/triggerKeys');

function main() {
  const kb = loadTechniqueKB('JP');
  const triggerKeys = loadTriggerKeysV0();
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
      if (!isTriggerKeyAllowed(cond.key, triggerKeys)) errors.push(`Disallowed trigger key (${c.id}): ${cond.key}`);
    }
  }

  if (errors.length) {
    console.error('[lint:kb:jp] FAILED');
    for (const e of errors) console.error(`- ${e}`);
    process.exit(1);
  }

  console.log(`[lint:kb:jp] OK (${kb.list.length} technique cards).`);
}

main();
