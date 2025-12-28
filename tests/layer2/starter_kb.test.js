const fs = require('fs');
const path = require('path');

const { TechniqueCardV0Schema } = require('../../src/layer2/schemas/techniqueCardV0');
const { loadTriggerKeysV1, isTriggerKeyAllowed } = require('../../src/layer2/dicts/triggerKeys');
const { loadRolesV1 } = require('../../src/layer2/dicts/roles');

function listJson(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => path.join(dir, f));
}

function collectAllStrings(card) {
  const out = [];
  out.push(card.id, card.market, card.area, card.difficulty);
  out.push(card.actionTemplate?.title);
  for (const s of card.actionTemplate?.steps || []) out.push(s);
  for (const s of card.rationaleTemplate || []) out.push(s);
  for (const s of card.productRoleHints || []) out.push(s);
  for (const s of card.safetyNotes || []) out.push(s);
  out.push(card.sourceId, card.sourcePointer);
  for (const s of card.tags || []) out.push(s);
  return out.filter(Boolean).map(String);
}

describe('starter KB', () => {
  const triggerKeys = loadTriggerKeysV1();
  const roles = loadRolesV1();
  const roleIds = new Set((roles.roles || []).map((r) => r.id));
  const bannedTokens = ['kendall', 'tiktok', 'sephora'];
  const requiredAreaCounts = {
    prep: 3,
    base: 5,
    brow: 3,
    eye: 5,
    blush: 2,
    contour: 1,
    lip: 1,
  };

  for (const market of ['us', 'jp']) {
    test(`${market.toUpperCase()} starter cards are valid and safe`, () => {
      const dir = path.join(__dirname, '..', '..', 'src', 'layer2', 'kb', market, 'starter');
      const files = listJson(dir);
      expect(files.length).toBe(20);

      const areaCounts = {};

      for (const filePath of files) {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const card = TechniqueCardV0Schema.parse(raw);

        expect(card.sourceId).toBe('INTERNAL_STARTER');
        expect(card.sourcePointer).toBe('generated');
        expect(card.tags || []).toContain('starter');
        expect(card.tags || []).toContain('reviewStatus:approved');
        expect(card.difficulty).toBe('easy');

        areaCounts[card.area] = (areaCounts[card.area] || 0) + 1;

        const steps = card.actionTemplate.steps;
        expect(steps.length).toBeGreaterThanOrEqual(2);
        expect(steps.length).toBeLessThanOrEqual(6);
        for (const s of steps) expect(String(s).length).toBeLessThanOrEqual(120);

        const conditions = [
          ...(card.triggers?.all || []),
          ...(card.triggers?.any || []),
          ...(card.triggers?.none || []),
        ];
        for (const c of conditions) {
          expect(isTriggerKeyAllowed(c.key, triggerKeys)).toBe(true);
        }

        for (const hint of card.productRoleHints || []) {
          expect(roleIds.has(hint)).toBe(true);
        }

        const blob = collectAllStrings(card).join('\n').toLowerCase();
        for (const tok of bannedTokens) {
          expect(blob.includes(tok)).toBe(false);
        }
      }

      for (const [area, n] of Object.entries(requiredAreaCounts)) {
        expect(areaCounts[area] || 0).toBe(n);
      }
    });
  }
});
