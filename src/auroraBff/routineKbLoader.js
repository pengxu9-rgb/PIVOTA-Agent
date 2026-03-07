'use strict';

const fs = require('fs');
const path = require('path');

let interactionRulesCache = null;
let safetyRulesCache = null;

const KB_DIR = process.env.AURORA_KB_V0_DIR || path.join(__dirname, '..', '..', 'data', 'aurora_chat_v2', 'kb_v0');

function loadJsonFile(filename) {
  try {
    const filepath = path.join(KB_DIR, filename);
    if (!fs.existsSync(filepath)) return null;
    const raw = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getInteractionRules() {
  if (interactionRulesCache) return interactionRulesCache;
  const data = loadJsonFile('interaction_rules.v0.json');
  interactionRulesCache = data && Array.isArray(data.interactions) ? data.interactions : [];
  return interactionRulesCache;
}

function getSafetyRules() {
  if (safetyRulesCache) return safetyRulesCache;
  const data = loadJsonFile('safety_rules.v0.json');
  safetyRulesCache = {
    rules: data && Array.isArray(data.rules) ? data.rules : [],
    templates: data && Array.isArray(data.templates) ? data.templates : [],
  };
  return safetyRulesCache;
}

function findRelevantInteractionRules(activeConcepts) {
  if (!activeConcepts || activeConcepts.length < 2) return [];
  const rules = getInteractionRules();
  const conceptSet = new Set(activeConcepts.map((c) => c.toUpperCase()));

  return rules
    .filter((rule) => {
      const a = String(rule.concept_a || '').toUpperCase();
      const b = String(rule.concept_b || '').toUpperCase();
      return conceptSet.has(a) && conceptSet.has(b);
    })
    .map((rule) => ({
      id: rule.interaction_id,
      pair: `${rule.concept_a} + ${rule.concept_b}`,
      risk: rule.risk_level,
      action: rule.recommended_action,
      note: rule.notes,
    }))
    .slice(0, 10);
}

function findRelevantSafetyRules(profileSummary, activeConcepts) {
  const { rules, templates } = getSafetyRules();
  if (!rules.length) return [];

  const profile = profileSummary || {};
  const conceptSet = new Set((activeConcepts || []).map((c) => c.toUpperCase()));
  const matched = [];

  for (const rule of rules) {
    if (!rule.trigger) continue;

    let lifeStageMatch = true;
    if (rule.trigger.life_stage) {
      lifeStageMatch = false;
      const ls = rule.trigger.life_stage;
      if (ls.pregnancy_status && Array.isArray(ls.pregnancy_status)) {
        const userStatus = String(profile.pregnancy_status || 'unknown').toLowerCase();
        if (ls.pregnancy_status.includes(userStatus)) lifeStageMatch = true;
      }
      if (ls.lactation_status && Array.isArray(ls.lactation_status)) {
        const userStatus = String(profile.lactation_status || 'unknown').toLowerCase();
        if (ls.lactation_status.includes(userStatus)) lifeStageMatch = true;
      }
      if (ls.age_band && Array.isArray(ls.age_band)) {
        const userAge = String(profile.age_band || 'unknown').toLowerCase();
        if (ls.age_band.includes(userAge)) lifeStageMatch = true;
      }
    }
    if (!lifeStageMatch) continue;

    let conceptMatch = true;
    if (rule.trigger.concepts_any && Array.isArray(rule.trigger.concepts_any)) {
      conceptMatch = rule.trigger.concepts_any.some((c) => conceptSet.has(c.toUpperCase()));
    }
    if (!conceptMatch) continue;

    const template = rule.decision.template_id
      ? templates.find((t) => t.template_id === rule.decision.template_id)
      : null;

    matched.push({
      id: rule.rule_id,
      category: rule.category,
      block_level: rule.decision.block_level,
      rationale: (rule.rationale || '').slice(0, 200),
      safe_alternatives: rule.decision.safe_alternatives_concepts || [],
      template_text: template
        ? (profile.language === 'CN' ? template.text_zh : template.text_en) || null
        : null,
    });

    if (matched.length >= 5) break;
  }

  return matched;
}

function buildKbGroundingForPrompt({ activeConcepts, profileSummary, language } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const interactions = findRelevantInteractionRules(activeConcepts);
  const safety = findRelevantSafetyRules(profileSummary, activeConcepts);

  if (!interactions.length && !safety.length) return '';

  const parts = [];

  if (interactions.length) {
    const interactionStr = interactions
      .map((r) => `${r.pair}(${r.risk}): ${r.action} — ${r.note}`)
      .join('; ');

    if (lang === 'CN') {
      parts.push(`kb_interaction_rules: 以下成分交互规则来自知识库，请在分析中遵循：${interactionStr}`);
    } else {
      parts.push(`kb_interaction_rules: Follow these ingredient interaction rules from the knowledge base: ${interactionStr}`);
    }
  }

  if (safety.length) {
    const safetyStr = safety
      .map((r) => `[${r.block_level}] ${r.id}: ${r.rationale}${r.safe_alternatives.length ? ` (alternatives: ${r.safe_alternatives.join(', ')})` : ''}`)
      .join('; ');

    if (lang === 'CN') {
      parts.push(`kb_safety_rules: 以下安全规则适用于此用户，必须遵循：${safetyStr}`);
    } else {
      parts.push(`kb_safety_rules: These safety rules apply to this user and must be followed: ${safetyStr}`);
    }
  }

  return '\n' + parts.join('\n');
}

module.exports = {
  getInteractionRules,
  getSafetyRules,
  findRelevantInteractionRules,
  findRelevantSafetyRules,
  buildKbGroundingForPrompt,
};
