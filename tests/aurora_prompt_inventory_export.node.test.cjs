const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  collectAuroraPromptInventory,
  renderMarkdown,
} = require('../scripts/export_aurora_prompt_inventory.cjs');

const ROOT_DIR = path.resolve(__dirname, '..');

test('aurora prompt inventory covers every v2 manifest template and free-form chat entrypoint', () => {
  const report = collectAuroraPromptInventory(ROOT_DIR);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'src/auroraBff/prompts/prompt_manifest.json'), 'utf8')
  );

  const manifestTemplates = new Set((manifest.templates || []).map((entry) => entry.template_id));
  const inventoryTemplates = new Set(
    report.rows.filter((row) => row.template_id !== 'chat.freeform').map((row) => row.template_id)
  );

  assert.deepEqual(report.coverage.missing_from_inventory, []);
  for (const templateId of manifestTemplates) {
    assert.equal(inventoryTemplates.has(templateId), true, `missing ${templateId} from inventory`);
  }

  const freeformRow = report.rows.find((row) => row.template_id === 'chat.freeform');
  assert.ok(freeformRow);
  assert.equal(freeformRow.call_mode, 'freeform_chat');
  assert.equal(freeformRow.entrypoint, 'skill_router._handleFreeFormChat');
  assert.equal(freeformRow.version, 'inline_system_prompt_v2');
});

test('aurora prompt inventory markdown includes prompt table and audit queue', () => {
  const report = collectAuroraPromptInventory(ROOT_DIR);
  const markdown = renderMarkdown(report);

  assert.match(markdown, /# Aurora Chat v2 Prompt Inventory/);
  assert.match(markdown, /\| Priority \| Template \/ Call \| Version \| Mode \| Schema \| Entrypoint \| Source \|/);
  assert.match(markdown, /## Audit Queue/);
  assert.match(markdown, /`product_analyze`/);
  assert.match(markdown, /`chat\.freeform`/);
});
