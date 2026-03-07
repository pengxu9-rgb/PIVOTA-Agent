'use strict';

const { runSkill } = require('./contracts');

function normalizeRoutineSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({
      step: String(s.step || '').trim().toLowerCase(),
      product: String(s.product || '').trim(),
      product_id: s.product_id || null,
      sku_id: s.sku_id || null,
    }))
    .filter((s) => s.step && s.product)
    .slice(0, 8);
}

function extractProductNamesFromNotes(notes) {
  if (!notes || typeof notes !== 'string') return [];
  const text = notes.trim();
  if (!text) return [];

  const products = [];
  const patterns = [
    /(?:用|use|using|added|switched to|changed to|trying|started)\s+(.{3,60}?)(?:[,，。.;；\n]|$)/gi,
    /([A-Z][a-zA-Z''-]+(?:\s+[A-Z][a-zA-Z''-]+){0,5}(?:\s+(?:Serum|Cream|Lotion|Toner|Cleanser|Mask|SPF|Moisturizer|Oil|Gel|Essence|Ampoule|Mist|Balm|Sunscreen))+)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const candidate = (match[1] || match[0]).trim();
      if (candidate.length >= 4 && candidate.length <= 80) {
        products.push(candidate);
      }
    }
  }

  return [...new Set(products)].slice(0, 10);
}

function detectUserIntent(notes) {
  if (!notes) return 'unknown';
  const lower = notes.toLowerCase();
  if (/add|新增|加了|新加/.test(lower)) return 'add_product';
  if (/换了|替换|replace|switch|changed/.test(lower)) return 'replace_product';
  if (/停用|去掉|remov|stop|drop/.test(lower)) return 'remove_product';
  if (/刺痛|泛红|过敏|irritat|sting|burn|red|allerg/.test(lower)) return 'report_reaction';
  return 'general_update';
}

async function runRoutineIntakeParserSkill({
  requestContext,
  logger,
  routineCandidate,
} = {}) {
  return runSkill({
    skillName: 'routine_intake_parser',
    stage: 'routine_intake_parser',
    provider: 'local_rules',
    requestContext,
    logger,
    run: async () => {
      if (!routineCandidate || typeof routineCandidate !== 'object') {
        return { parsed: false, am_steps: [], pm_steps: [], notes: '', notes_products: [], user_intent: 'unknown' };
      }

      const amSteps = normalizeRoutineSteps(routineCandidate.am);
      const pmSteps = normalizeRoutineSteps(routineCandidate.pm);
      const notes = String(routineCandidate.notes || '').trim().slice(0, 800);
      const notesProducts = extractProductNamesFromNotes(notes);
      const userIntent = detectUserIntent(notes);

      return {
        parsed: true,
        am_steps: amSteps,
        pm_steps: pmSteps,
        notes,
        notes_products: notesProducts,
        user_intent: userIntent,
        total_products: amSteps.length + pmSteps.length,
        has_notes: Boolean(notes),
      };
    },
  });
}

module.exports = {
  runRoutineIntakeParserSkill,
  normalizeRoutineSteps,
  extractProductNamesFromNotes,
  detectUserIntent,
};
