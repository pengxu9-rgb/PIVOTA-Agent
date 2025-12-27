#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');

const { TechniqueCardV0Schema } = require('../src/layer2/schemas/techniqueCardV0');
const { loadTriggerKeysV0, isTriggerKeyAllowed } = require('../src/layer2/dicts/triggerKeys');
const { loadRolesV0 } = require('../src/layer2/dicts/roles');
const { loadLookSpecLexiconV0 } = require('../src/layer2/dicts/lookSpecLexicon');
const { loadIntentsV0 } = require('../src/layer2/dicts/intents');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = String(a || '').match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function normalizeMarketArg(v) {
  const s = String(v || '').trim().toUpperCase();
  if (s === 'US' || s === 'JP' || s === 'ALL') return s;
  return null;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function stableJsonStringify(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function writeCardFile(outDir, card) {
  const filePath = path.join(outDir, `${card.id}.json`);
  fs.writeFileSync(filePath, stableJsonStringify(card), 'utf8');
}

function cleanDirJson(outDir) {
  if (!fs.existsSync(outDir)) return;
  for (const f of fs.readdirSync(outDir)) {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(outDir, f));
  }
}

function titleFromIntent(intentId) {
  const words = String(intentId || '')
    .replace(/^TJP?_STARTER_/, '')
    .split(/[_\s]+/g)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const pretty = words
    .map((w) => (w.length ? `${w[0].toUpperCase()}${w.slice(1)}` : w))
    .join(' ')
    .trim();
  return pretty || 'Starter technique';
}

function intentShort(intentId) {
  return String(intentId || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function pickRoleHintsByArea(area, rolesV0) {
  const ids = (rolesV0.roles || []).map((r) => r.id);
  const eye = ids.filter((id) => /(liner|mascara|lash|shadow|brush)/.test(id) && !id.startsWith('lip_'));
  const base = ids.filter((id) => /(foundation|concealer|primer|powder|puff|sponge|spray|moisturizer|highlighter)/.test(id));
  const lip = ids.filter((id) => id.startsWith('lip_') || /(gloss|tissue)/.test(id));

  const pool = area === 'eye' ? eye : area === 'base' ? base : lip;
  const stable = pool.sort((a, b) => a.localeCompare(b));
  return stable.slice(0, 3);
}

function stepClamp(steps) {
  const trimmed = (steps || []).map((s) => String(s || '').trim()).filter(Boolean);
  const bounded = trimmed.slice(0, 6);
  return bounded.map((s) => (s.length > 120 ? s.slice(0, 117).trimEnd() + '…' : s));
}

function buildBaseSteps() {
  return stepClamp([
    'Apply a thin, even base layer.',
    'Spot-correct only where needed and re-blend.',
    'Set only where needed to keep the intended finish.',
  ]);
}

function buildEyeSteps() {
  return stepClamp([
    'Start detail work from the outer third and build gradually.',
    'Keep lines thin first, then adjust the outer corner.',
    'Fill small gaps along the lash line for a clean edge.',
  ]);
}

function buildLipSteps() {
  return stepClamp([
    'Match the reference finish first (matte/satin/gloss/tint).',
    'Stay in a close shade family and adjust intensity with a light blot.',
    'Concentrate color slightly more in the center if needed.',
  ]);
}

function selectLexiconValuesForArea(area, lexiconForMarket) {
  const l = lexiconForMarket;
  if (!l) return null;
  if (area === 'base') {
    const finish = (l.base?.finish || []).filter((v) => v !== 'unknown').sort();
    const coverage = (l.base?.coverage || []).filter((v) => v !== 'unknown').sort();
    return { finish: finish.slice(0, 2), coverage: coverage.slice(0, 2) };
  }
  if (area === 'eye') {
    const lashIntensity = (l.eye?.lashIntensity || []).filter((v) => v !== 'unknown').sort();
    return { lashIntensity: lashIntensity.slice(0, 2) };
  }
  const finish = (l.lip?.finish || []).filter((v) => v !== 'unknown').sort();
  return { finish: finish.slice(0, 2) };
}

function buildStarterCardsForMarket({ market, count }) {
  const triggerKeys = loadTriggerKeysV0();
  const rolesV0 = loadRolesV0();
  const lexicon = loadLookSpecLexiconV0(market);
  const intents = loadIntentsV0();

  const byArea = { base: [], eye: [], lip: [] };
  for (const it of intents.intents || []) {
    if (!it || !it.id || !it.area) continue;
    if (!it.markets?.[market]) continue;
    if (!byArea[it.area]) continue;
    byArea[it.area].push(it);
  }

  for (const k of Object.keys(byArea)) {
    byArea[k].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  const areaOrder = ['base', 'eye', 'lip'];
  const cards = [];
  const seenIds = new Set();

  const perAreaTarget = {
    base: Math.floor(count / 3),
    eye: Math.floor(count / 3),
    lip: count - 2 * Math.floor(count / 3),
  };

  function addCard(area, intent, variant) {
    const prefix = market === 'JP' ? 'TJP_STARTER' : 'T_STARTER';
    const id = `${prefix}_${area.toUpperCase()}_${intentShort(intent.id)}${variant ? `_${variant}` : ''}`;
    if (seenIds.has(id)) return false;

    const commonRoles = pickRoleHintsByArea(area, rolesV0);
    const lex = selectLexiconValuesForArea(area, lexicon);

    const triggers = {};
    if (variant === 'FINISH' && area === 'base' && lex?.finish?.length) {
      triggers.all = [{ key: 'lookSpec.breakdown.base.finish', op: 'in', value: lex.finish }];
    } else if (variant === 'COVERAGE' && area === 'base' && lex?.coverage?.length) {
      triggers.all = [{ key: 'lookSpec.breakdown.base.coverage', op: 'in', value: lex.coverage }];
    } else if (variant === 'FINISH' && area === 'lip' && lex?.finish?.length) {
      triggers.all = [{ key: 'lookSpec.breakdown.lip.finish', op: 'in', value: lex.finish }];
    } else if (variant === 'LASH' && area === 'eye' && lex?.lashIntensity?.length) {
      triggers.all = [{ key: 'lookSpec.breakdown.eye.finish', op: 'exists' }];
    } else {
      // Safe default: only gate on the area’s lookSpec breakdown key existing.
      const key =
        area === 'base'
          ? 'lookSpec.breakdown.base.intent'
          : area === 'eye'
            ? 'lookSpec.breakdown.eye.intent'
            : 'lookSpec.breakdown.lip.intent';
      triggers.any = [{ key, op: 'exists' }];
    }

    const allConds = [...(triggers.all || []), ...(triggers.any || []), ...(triggers.none || [])];
    for (const c of allConds) {
      if (!isTriggerKeyAllowed(c.key, triggerKeys)) throw new Error(`Generated disallowed trigger key: ${c.key}`);
    }

    const steps = area === 'base' ? buildBaseSteps() : area === 'eye' ? buildEyeSteps() : buildLipSteps();
    const card = {
      schemaVersion: 'v0',
      market,
      id,
      area,
      difficulty: 'easy',
      triggers,
      actionTemplate: {
        title: `${titleFromIntent(intent.id)} (starter)`,
        steps,
      },
      rationaleTemplate: [
        'These steps are a safe baseline and can be tuned once more context is available.',
      ],
      productRoleHints: commonRoles,
      safetyNotes: ['Avoid identity/celebrity comparisons.'],
      sourceId: 'INTERNAL_STARTER',
      sourcePointer: 'generated',
      tags: ['starter'],
    };

    const parsed = TechniqueCardV0Schema.parse(card);
    seenIds.add(parsed.id);
    cards.push(parsed);
    return true;
  }

  // Round-robin per area to keep coverage balanced.
  const picked = { base: 0, eye: 0, lip: 0 };
  const variants = ['BASE', 'FINISH', 'COVERAGE']; // deterministic variant names; only some produce different triggers.

  for (const area of areaOrder) {
    for (const intent of byArea[area]) {
      if (cards.length >= count) break;
      if (addCard(area, intent, null)) picked[area] += 1;
      if (cards.length >= count) break;

      // Add a second variant for a subset until per-area target is reached.
      if (picked[area] < perAreaTarget[area] && (area === 'base' || area === 'lip')) {
        if (addCard(area, intent, 'FINISH')) picked[area] += 1;
      } else if (picked[area] < perAreaTarget[area] && area === 'base') {
        if (addCard(area, intent, 'COVERAGE')) picked[area] += 1;
      }
    }
  }

  // Fill remaining slots (if any) in stable area order.
  if (cards.length < count) {
    for (const area of areaOrder) {
      for (const intent of byArea[area]) {
        if (cards.length >= count) break;
        for (const v of variants) {
          if (cards.length >= count) break;
          addCard(area, intent, v);
        }
      }
    }
  }

  // Ensure deterministic ordering by id.
  cards.sort((a, b) => a.id.localeCompare(b.id));
  return cards.slice(0, count);
}

function usageAndExit(code) {
  console.log(`Usage:
  npm run kb:starter:generate -- --market US|JP|ALL --count 20

Outputs:
  - src/layer2/kb/us/starter/*.json
  - src/layer2/kb/jp/starter/*.json
`);
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const marketArg = normalizeMarketArg(args.market);
  const count = Math.max(0, Math.min(Number(args.count || 20) || 20, 200));
  if (!marketArg) usageAndExit(1);

  const markets = marketArg === 'ALL' ? ['US', 'JP'] : [marketArg];
  for (const m of markets) {
    const outDir = path.join(__dirname, '..', 'src', 'layer2', 'kb', m.toLowerCase(), 'starter');
    ensureDir(outDir);
    cleanDirJson(outDir);
    const cards = buildStarterCardsForMarket({ market: m, count });
    for (const c of cards) writeCardFile(outDir, c);
    console.log(`[kb:starter] market=${m} wrote ${cards.length} card(s) to ${outDir}`);
  }
}

main();
