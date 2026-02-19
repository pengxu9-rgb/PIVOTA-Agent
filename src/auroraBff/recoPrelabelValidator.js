const { z } = require('zod');
const { parseJsonOnlyObject, extractJsonObject, extractJsonObjectByKeys } = require('./jsonExtract');

const LabelEnum = z.enum(['relevant', 'not_relevant', 'wrong_block']);
const BlockEnum = z.enum(['competitors', 'dupes', 'related_products']);

const PrelabelOutputSchema = z
  .object({
    suggested_label: LabelEnum,
    wrong_block_target: BlockEnum.nullable(),
    confidence: z.number().min(0).max(1),
    rationale_user_visible: z.string().min(1).max(320),
    flags: z.array(z.string().min(1)).max(16),
  })
  .strict();

function uniqStrings(values, max = 12) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const token = String(raw || '').trim().toLowerCase();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= max) break;
  }
  return out;
}

function fallbackInvalidJson(flags = []) {
  return {
    suggested_label: 'not_relevant',
    wrong_block_target: null,
    confidence: 0,
    rationale_user_visible: 'Suggestion parsing failed; employee review is required.',
    flags: uniqStrings(['invalid_json', ...flags], 16),
  };
}

function normalizeCandidateLabel(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = { ...raw };
  const suggestedLabel = String(obj.suggested_label || '').trim().toLowerCase();
  const target = obj.wrong_block_target == null ? null : String(obj.wrong_block_target || '').trim().toLowerCase();
  const confidenceRaw = Number(obj.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : NaN;
  const rationale = String(obj.rationale_user_visible || '').trim();
  const flags = uniqStrings(obj.flags, 16);
  const normalized = {
    suggested_label: suggestedLabel,
    wrong_block_target: target,
    confidence,
    rationale_user_visible: rationale,
    flags,
  };
  const parsed = PrelabelOutputSchema.safeParse(normalized);
  if (!parsed.success) return null;
  const value = parsed.data;
  return {
    ...value,
    wrong_block_target: value.suggested_label === 'wrong_block' ? value.wrong_block_target : null,
    flags: uniqStrings(value.flags, 16),
  };
}

function sanitizeJsonLikeText(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';

  // Remove fenced wrappers while preserving body.
  text = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  // Normalize smart quotes often produced by copied markdown content.
  text = text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  // Tolerate trailing commas from non-strict emitters.
  text = text.replace(/,\s*([}\]])/g, '$1');
  return text.trim();
}

function findCandidateDeep(root, depth = 0, seen = new Set()) {
  if (!root || typeof root !== 'object' || depth > 4 || seen.has(root)) return null;
  seen.add(root);

  const direct = normalizeCandidateLabel(root);
  if (direct) return direct;

  const values = Array.isArray(root) ? root : Object.values(root);
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const next = findCandidateDeep(value, depth + 1, seen);
    if (next) return next;
  }
  return null;
}

function coerceInputObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  const text = String(raw || '').trim();
  if (!text) return null;
  const cleaned = sanitizeJsonLikeText(text);
  const requiredKeys = ['suggested_label', 'wrong_block_target', 'confidence', 'rationale_user_visible', 'flags'];
  return (
    parseJsonOnlyObject(cleaned) ||
    extractJsonObjectByKeys(cleaned, requiredKeys) ||
    extractJsonObject(cleaned) ||
    null
  );
}

function validateAndNormalizePrelabelOutput(raw) {
  const inputObj = coerceInputObject(raw);
  const normalized = normalizeCandidateLabel(inputObj) || findCandidateDeep(inputObj);
  if (!normalized) {
    return {
      ok: false,
      errors: ['invalid_prelabel_output'],
      value: fallbackInvalidJson(),
    };
  }
  return { ok: true, errors: [], value: normalized };
}

module.exports = {
  PRELABEL_OUTPUT_SCHEMA: PrelabelOutputSchema,
  validateAndNormalizePrelabelOutput,
  fallbackInvalidJson,
};
