const fs = require('fs');
const path = require('path');
const { z } = require('zod');

const { createProviderFromEnv, LlmError } = require('../../llm/provider');
const { AdjustmentSkeletonV0Schema } = require('../schemas/adjustmentSkeletonV0');

const { RULE_TITLES_US } = require('./rules/usAdjustmentRules');

const Layer2AdjustmentV0Schema = z
  .object({
    impactArea: z.enum(['base', 'eye', 'lip']),
    title: z.string().min(1),
    because: z.string().min(1),
    do: z.string().min(1),
    why: z.string().min(1),
    confidence: z.enum(['high', 'medium', 'low']),
    evidence: z.array(z.string().min(1)).min(1),
    ruleId: z.string().min(1),
    techniqueRefs: z
      .array(
        z
          .object({
            id: z.string().min(1),
            area: z.enum(['base', 'eye', 'lip']),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const RephraseOutputSchema = z
  .object({
    adjustments: z.array(Layer2AdjustmentV0Schema).length(3),
  })
  .strict();

let cachedPrompt = null;

function loadPrompt() {
  if (cachedPrompt) return cachedPrompt;
  const p = path.join(__dirname, '..', 'prompts', 'adjustments_rephrase_en.txt');
  cachedPrompt = fs.readFileSync(p, 'utf8');
  return cachedPrompt;
}

function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function ensurePeriod(s) {
  const t = normalizeText(s);
  if (!t) return t;
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function humanTitleForRule(ruleId, impactArea) {
  const t = RULE_TITLES_US[ruleId];
  if (t) return t;
  const prefix = impactArea === 'base' ? 'Base' : impactArea === 'eye' ? 'Eye' : 'Lip';
  return `${prefix} adjustment`;
}

function renderAdjustmentFromSkeleton(s) {
  const doActions =
    Array.isArray(s.doActions) && s.doActions.length
      ? s.doActions
      : [
          ...(s.impactArea === 'base'
            ? ['Apply a thin base layer.', 'Spot-correct only where needed.']
            : s.impactArea === 'eye'
              ? ['Start liner from the outer third.', 'Keep the line thin and wing short.']
              : ['Match the reference finish.', 'Stay in a close shade family.']),
        ];

  return Layer2AdjustmentV0Schema.parse({
    impactArea: s.impactArea,
    ruleId: s.ruleId,
    title: humanTitleForRule(s.ruleId, s.impactArea),
    because: ensurePeriod(s.becauseFacts.join(' ')),
    do: ensurePeriod(doActions.join(' ')),
    why: ensurePeriod(s.whyMechanism.join(' ')),
    confidence: s.confidence,
    evidence: s.evidenceKeys,
    techniqueRefs: s.techniqueRefs,
  });
}

function containsIdentityLanguage(text) {
  const s = text.toLowerCase();
  return /look like|resemble|celebrity|famous|actor|actress|singer|model/.test(s);
}

function collectAllowedNumbers(skeletons) {
  const s = JSON.stringify(skeletons);
  const nums = s.match(/\d+(\.\d+)?/g) || [];
  return new Set(nums);
}

function numbersOnlyFromSkeleton(text, allowed) {
  const nums = text.match(/\d+(\.\d+)?/g) || [];
  return nums.every((n) => allowed.has(n));
}

function collectAllowedDoVerbsByArea(skeletons) {
  const out = { base: new Set(), eye: new Set(), lip: new Set() };
  const toVerb = (s) => String(s || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
  for (const sk of skeletons) {
    const area = sk.impactArea;
    const steps = Array.isArray(sk.doActions) ? sk.doActions : [];
    for (const step of steps) {
      const v = toVerb(step);
      if (v) out[area].add(v);
    }
  }
  return out;
}

function extractDoVerbs(text) {
  const verbs = new Set();
  const pieces = String(text || '')
    .split(/[.!?;\n]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of pieces) {
    const v = p.split(/\s+/)[0]?.toLowerCase() || '';
    if (v) verbs.add(v);
  }
  return verbs;
}

function onlyUsesAllowedDoVerbs(doText, allowed) {
  const okAux = new Set(['and', 'then', 'also', 'try', 'aim', 'keep', 'use', 'add', 'apply', 'blend', 'press']);
  const verbs = extractDoVerbs(doText);
  for (const v of verbs) {
    if (okAux.has(v)) continue;
    if (!allowed.has(v)) return false;
  }
  return true;
}

function textContainsForbiddenAttributes(outputText, allowedText) {
  const forbiddenTokens = [
    'hooded',
    'downturned',
    'upturned',
    'thin lips',
    'oily skin',
    'dry skin',
    'pores',
    'wrinkles',
    'acne',
    'undertone',
    'warm',
    'cool',
    'skin type',
  ];
  const lowerOut = outputText.toLowerCase();
  const lowerAllowed = allowedText.toLowerCase();
  for (const tok of forbiddenTokens) {
    if (lowerOut.includes(tok) && !lowerAllowed.includes(tok)) return tok;
  }
  return null;
}

function ensureExactAreas(items, warnings) {
  const byArea = {};
  for (const a of items) {
    if (!a) continue;
    if (a.impactArea !== 'base' && a.impactArea !== 'eye' && a.impactArea !== 'lip') continue;
    if (!byArea[a.impactArea]) byArea[a.impactArea] = a;
  }
  const out = [
    byArea.base ?? (warnings.push('Missing base adjustment from LLM output.'), null),
    byArea.eye ?? (warnings.push('Missing eye adjustment from LLM output.'), null),
    byArea.lip ?? (warnings.push('Missing lip adjustment from LLM output.'), null),
  ];
  if (!out[0] || !out[1] || !out[2]) throw new Error('LLM output did not include exactly one adjustment per impactArea.');
  return out;
}

function validateNoNewFactsOrIdentity(skeletons, adjustments) {
  const allowedText = JSON.stringify(skeletons);
  const allowedNumbers = collectAllowedNumbers(skeletons);
  const allowedDoVerbsByArea = collectAllowedDoVerbsByArea(skeletons);

  const skeletonByArea = {
    base: skeletons.find((s) => s.impactArea === 'base'),
    eye: skeletons.find((s) => s.impactArea === 'eye'),
    lip: skeletons.find((s) => s.impactArea === 'lip'),
  };

  for (const a of adjustments) {
    const textBlob = `${a.title}\n${a.because}\n${a.do}\n${a.why}`;
    if (containsIdentityLanguage(textBlob)) return { ok: false, reason: 'identity_language' };
    if (!numbersOnlyFromSkeleton(textBlob, allowedNumbers)) return { ok: false, reason: 'new_numeric_claim' };
    const forbiddenAttr = textContainsForbiddenAttributes(textBlob, allowedText);
    if (forbiddenAttr) return { ok: false, reason: `new_trait:${forbiddenAttr}` };
    if (!onlyUsesAllowedDoVerbs(a.do, allowedDoVerbsByArea[a.impactArea])) return { ok: false, reason: 'new_action_verb' };

    const sk = skeletonByArea[a.impactArea];
    if (a.ruleId !== sk.ruleId) return { ok: false, reason: 'ruleId_mismatch' };
    if (!Array.isArray(a.evidence) || a.evidence.length < 1) return { ok: false, reason: 'missing_evidence' };
    const allowedEvidence = new Set(sk.evidenceKeys);
    if (a.evidence.some((e) => !allowedEvidence.has(e))) return { ok: false, reason: 'evidence_not_subset' };
  }

  return { ok: true };
}

async function rephraseAdjustments(input) {
  if (input.market !== 'US') throw new Error('rephraseAdjustments only supports market=US.');
  const locale = String(input.locale || 'en').trim() || 'en';

  const skeletons = (input.skeletons || []).map((s) => AdjustmentSkeletonV0Schema.parse(s));
  const warnings = [];

  const fallback = () => {
    const rendered = skeletons.map(renderAdjustmentFromSkeleton);
    return { adjustments: rendered, warnings, usedFallback: true };
  };

  let provider = input.provider ?? null;
  if (!provider) {
    try {
      provider = createProviderFromEnv('layer2_lookspec');
    } catch {
      warnings.push('LLM config missing: using deterministic adjustment renderer.');
      return fallback();
    }
  }

  const promptTemplate = loadPrompt();
  const prompt = `${promptTemplate}\n\n` + `INPUT_JSON:\n` + JSON.stringify({ market: 'US', locale, skeletons }, null, 2);

  try {
    const parsed = await provider.analyzeTextToJson({ prompt, schema: RephraseOutputSchema });
    const fixed = ensureExactAreas(parsed.adjustments, warnings);
    const validation = validateNoNewFactsOrIdentity(skeletons, fixed);
    if (!validation.ok) {
      warnings.push(`LLM output rejected (${validation.reason}): using deterministic adjustment renderer.`);
      return fallback();
    }
    return { adjustments: fixed, warnings, usedFallback: false };
  } catch (err) {
    if (err instanceof LlmError) {
      warnings.push(`LLM failed (${err.code}): ${String(err.message || '').slice(0, 220)}`);
    } else {
      warnings.push('LLM failed: using deterministic adjustment renderer.');
    }
    return fallback();
  }
}

module.exports = {
  Layer2AdjustmentV0Schema,
  renderAdjustmentFromSkeleton,
  validateNoNewFactsOrIdentity,
  rephraseAdjustments,
};
