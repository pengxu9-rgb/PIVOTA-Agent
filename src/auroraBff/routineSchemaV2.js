'use strict';

const SCHEMA_VERSION = 'aurora.routine_intake.v2';
const LEGACY_ENUM_VALUES = new Set(['none', 'basic', 'full', '']);

/**
 * Normalize a single routine step entry to { step, product, product_id?, sku_id? }.
 * Returns null for invalid entries.
 */
function normalizeStep(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const step = String(entry.step || '').trim().toLowerCase();
  const product = String(entry.product || '').trim();
  if (!step || !product) return null;
  const out = { step, product };
  if (entry.product_id) out.product_id = String(entry.product_id);
  if (entry.sku_id) out.sku_id = String(entry.sku_id);
  return out;
}

/**
 * Convert a slot that may be an array of {step,product} OR an object map {step: product}
 * into a normalized array of {step,product,...}.
 */
function coerceSlotToArray(slot) {
  if (Array.isArray(slot)) return slot.map(normalizeStep).filter(Boolean);
  if (slot && typeof slot === 'object' && !Array.isArray(slot)) {
    return Object.entries(slot)
      .filter(([, v]) => typeof v === 'string' && v.trim())
      .map(([step, product]) => ({ step: step.toLowerCase(), product: product.trim() }));
  }
  return [];
}

/**
 * Normalize any legacy currentRoutine value into aurora.routine_intake.v2 schema.
 *
 * Accepted inputs:
 *   null / undefined                                   → null
 *   string enum 'none'/'basic'/'full'/''               → null  (no product data)
 *   JSON string of an object                           → parsed then re-normalized
 *   { am: [...], pm: [...] }                           → wrapped in v2
 *   { am: { step: product }, pm: { step: product } }   → converted + wrapped in v2
 *   { schema_version: '…v1', am, pm }                  → upgraded to v2
 *   { schema_version: '…v2', am, pm, notes }           → returned as-is
 *   anything else                                      → null
 */
function normalizeCurrentRoutineToV2(raw) {
  if (raw == null) return null;

  if (typeof raw === 'string') {
    const t = raw.trim();
    if (LEGACY_ENUM_VALUES.has(t.toLowerCase())) return null;
    try {
      return normalizeCurrentRoutineToV2(JSON.parse(t));
    } catch {
      return null;
    }
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) return null;

  const am = coerceSlotToArray(raw.am);
  const pm = coerceSlotToArray(raw.pm);
  const notes = typeof raw.notes === 'string' ? raw.notes.trim() : '';

  if (am.length === 0 && pm.length === 0 && !notes) return null;

  return { schema_version: SCHEMA_VERSION, am, pm, ...(notes ? { notes } : {}) };
}

module.exports = {
  SCHEMA_VERSION,
  normalizeStep,
  normalizeCurrentRoutineToV2,
};
