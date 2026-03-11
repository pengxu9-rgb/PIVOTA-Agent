'use strict';

const { normalizeCurrentRoutineToV2, SCHEMA_VERSION } = require('./routineSchemaV2');

const LEGACY_ENUM_VALUES = new Set(['', 'none', 'basic', 'full']);
const DEFAULT_MISSING_FIELDS = ['currentRoutine.am', 'currentRoutine.pm'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function truncateText(value, max = 5000) {
  const text = toTrimmedString(value);
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function stringifyRoutine(value, max = 5000) {
  try {
    const json = JSON.stringify(value);
    return json.length <= max ? json : `${json.slice(0, max)}…`;
  } catch {
    return '';
  }
}

function cloneRoutineRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    if (Array.isArray(row)) return row.slice();
    if (isPlainObject(row)) return { ...row };
    return row;
  });
}

function hasFilledRoutineRows(rows) {
  return (Array.isArray(rows) ? rows : []).some((row) => {
    if (!row) return false;
    if (typeof row === 'string') return Boolean(String(row).trim());
    if (!isPlainObject(row)) return false;
    return Boolean(
      String(row.product || '').trim() ||
      String(row.name || '').trim() ||
      String(row.step || '').trim() ||
      String(row.ingredient || '').trim()
    );
  });
}

function parseRoutineSameAsAmFlag(value) {
  if (value == null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  const token = String(value || '').trim().toLowerCase();
  if (!token) return false;
  return [
    '1',
    'true',
    'yes',
    'y',
    'same_as_am',
    'same as am',
    'same-as-am',
    'pm_same_as_am',
    'pm same as am',
    'pm-same-as-am',
    'copy_am',
    'copy am',
    'same_am',
    'same am',
    'copy from am',
    'copy_from_am',
    'pm = am',
    'same as morning',
    'same as daytime',
    'same as day',
    'same morning',
    'same daytime',
    'same day',
    'am same',
    'sameam',
    '同am',
    '同 am',
    '和am一样',
    '跟am一样',
    '同早上',
  ].includes(token);
}

function applyPmSameAsAmShortcut(routine) {
  if (!isPlainObject(routine)) return routine;

  const amRows = Array.isArray(routine.am) ? routine.am : Array.isArray(routine.am_steps) ? routine.am_steps : [];
  const pmRows = Array.isArray(routine.pm) ? routine.pm : Array.isArray(routine.pm_steps) ? routine.pm_steps : [];
  const pmNode = routine.pm;
  const pmNodeText = typeof pmNode === 'string' ? pmNode : '';

  const sameAsAmRequested =
    parseRoutineSameAsAmFlag(routine.pm_same_as_am) ||
    parseRoutineSameAsAmFlag(routine.pmSameAsAm) ||
    parseRoutineSameAsAmFlag(routine.same_as_am) ||
    parseRoutineSameAsAmFlag(routine.sameAsAm) ||
    parseRoutineSameAsAmFlag(routine.pm_copy_from_am) ||
    parseRoutineSameAsAmFlag(routine.pmCopyFromAm) ||
    parseRoutineSameAsAmFlag(pmNodeText) ||
    (isPlainObject(pmNode) && (
      parseRoutineSameAsAmFlag(pmNode.same_as_am) ||
      parseRoutineSameAsAmFlag(pmNode.sameAsAm) ||
      parseRoutineSameAsAmFlag(pmNode.pm_same_as_am) ||
      parseRoutineSameAsAmFlag(pmNode.pmSameAsAm)
    ));

  if (!sameAsAmRequested) return routine;
  if (!hasFilledRoutineRows(amRows)) return routine;
  if (hasFilledRoutineRows(pmRows)) return routine;

  const copied = cloneRoutineRows(amRows);
  return {
    ...routine,
    pm: copied,
    pm_steps: cloneRoutineRows(amRows),
  };
}

function normalizeSlot(value) {
  const token = toTrimmedString(value).toLowerCase();
  if (!token) return 'am';
  if (['am', 'morning', 'day', 'daytime', '早', '早上'].includes(token)) return 'am';
  if (['pm', 'night', 'evening', 'bedtime', '晚', '晚上'].includes(token)) return 'pm';
  if (token.includes('pm') || token.includes('night') || token.includes('evening')) return 'pm';
  return 'am';
}

function normalizeStep(value) {
  const token = toTrimmedString(value).toLowerCase();
  if (!token) return 'treatment';
  if (/(cleanser|cleanse|face wash|wash|洁面|清洁)/i.test(token)) return 'cleanser';
  if (/(spf|sunscreen|sun screen|uv|防晒)/i.test(token)) return 'spf';
  if (/(moistur|cream|lotion|gel|balm|面霜|乳液|保湿)/i.test(token)) return 'moisturizer';
  if (/(serum|toner|essence|treatment|active|retinol|acid|精华|活性|酸)/i.test(token)) return 'treatment';
  return token;
}

function buildRoutineStep(entry, index = 0) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    const product = truncateText(entry, 500);
    if (!product) return null;
    return { slot: 'am', step: `step_${index + 1}`, product };
  }
  if (!isPlainObject(entry)) return null;
  const product = truncateText(
    entry.product || entry.name || entry.display_name || entry.displayName || entry.title || entry.text,
    500,
  );
  if (!product) return null;
  return {
    slot: normalizeSlot(entry.slot || entry.routine || entry.time_of_day || entry.timeOfDay || entry.period),
    step: normalizeStep(entry.step || entry.category || entry.routine_step || entry.routineStep || entry.type),
    product,
    ...(toTrimmedString(entry.product_id) ? { product_id: String(entry.product_id).trim() } : {}),
    ...(toTrimmedString(entry.sku_id) ? { sku_id: String(entry.sku_id).trim() } : {}),
  };
}

function normalizeArrayRoutineToV2(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const am = [];
  const pm = [];
  const notes = [];
  value.forEach((entry, index) => {
    const row = buildRoutineStep(entry, index);
    if (row) {
      const normalized = {
        step: row.step,
        product: row.product,
        ...(row.product_id ? { product_id: row.product_id } : {}),
        ...(row.sku_id ? { sku_id: row.sku_id } : {}),
      };
      if (row.slot === 'pm') pm.push(normalized);
      else am.push(normalized);
      return;
    }
    if (typeof entry === 'string') {
      const note = truncateText(entry, 500);
      if (note) notes.push(note);
    }
  });
  if (!am.length && !pm.length && !notes.length) return null;
  return {
    schema_version: SCHEMA_VERSION,
    am,
    pm,
    ...(notes.length ? { notes: notes.join(' | ').slice(0, 1200) } : {}),
  };
}

function normalizeRoutineObject(value) {
  if (!isPlainObject(value)) return null;
  const resolved = applyPmSameAsAmShortcut(value);
  if (Array.isArray(resolved.am) || Array.isArray(resolved.pm) || isPlainObject(resolved.am) || isPlainObject(resolved.pm)) {
    return normalizeCurrentRoutineToV2(resolved);
  }
  if (Array.isArray(resolved.am_steps) || Array.isArray(resolved.pm_steps)) {
    return normalizeCurrentRoutineToV2({
      am: resolved.am_steps,
      pm: resolved.pm_steps,
      notes: resolved.notes,
    });
  }
  return normalizeCurrentRoutineToV2(resolved);
}

function tryParseRoutineObject(value) {
  if (!value) return null;
  if (isPlainObject(value)) {
    const rawResolved = applyPmSameAsAmShortcut(value);
    const normalized = normalizeRoutineStateValue(rawResolved);
    if (normalized && isPlainObject(normalized.current_routine_struct)) {
      const structured = normalized.current_routine_struct;
      return Array.isArray(rawResolved.pm_steps) && !Array.isArray(structured.pm_steps)
        ? { ...structured, pm_steps: cloneRoutineRows(rawResolved.pm_steps) }
        : structured;
    }
    return rawResolved;
  }
  if (typeof value !== 'string') {
    const normalized = normalizeRoutineStateValue(value);
    return normalized && isPlainObject(normalized.current_routine_struct)
      ? normalized.current_routine_struct
      : null;
  }
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (isPlainObject(parsed)) {
      const rawResolved = applyPmSameAsAmShortcut(parsed);
      const normalized = normalizeRoutineStateValue(rawResolved);
      if (normalized && isPlainObject(normalized.current_routine_struct)) {
        const structured = normalized.current_routine_struct;
        return Array.isArray(rawResolved.pm_steps) && !Array.isArray(structured.pm_steps)
          ? { ...structured, pm_steps: cloneRoutineRows(rawResolved.pm_steps) }
          : structured;
      }
      return rawResolved;
    }
    return null;
  } catch {
    const normalized = normalizeRoutineStateValue(value);
    return normalized && isPlainObject(normalized.current_routine_struct)
      ? normalized.current_routine_struct
      : null;
  }
}

function normalizeRoutineInputWithPmShortcut(value) {
  if (value == null) return value;
  const parsed = tryParseRoutineObject(value);
  return parsed || value;
}

function buildMissingRoutineFields(structuredRoutine) {
  if (!structuredRoutine || !isPlainObject(structuredRoutine)) return DEFAULT_MISSING_FIELDS.slice();
  const am = Array.isArray(structuredRoutine.am) ? structuredRoutine.am : [];
  const pm = Array.isArray(structuredRoutine.pm) ? structuredRoutine.pm : [];
  const hasFilled = (rows) =>
    rows.some((row) => {
      if (!row) return false;
      if (typeof row === 'string') return Boolean(toTrimmedString(row));
      if (!isPlainObject(row)) return false;
      return Boolean(
        toTrimmedString(row.product) ||
          toTrimmedString(row.name) ||
          toTrimmedString(row.step) ||
          toTrimmedString(row.ingredient),
      );
    });
  const missing = [];
  if (!hasFilled(am)) missing.push('currentRoutine.am');
  if (!hasFilled(pm)) missing.push('currentRoutine.pm');
  return missing.length ? missing : [];
}

function buildRoutineState(value, sourceShape) {
  const current_routine_struct =
    Array.isArray(value) ? normalizeArrayRoutineToV2(value) : isPlainObject(value) ? normalizeRoutineObject(value) : null;
  const current_routine_text =
    current_routine_struct ? stringifyRoutine(current_routine_struct) : Array.isArray(value) || isPlainObject(value) ? stringifyRoutine(value) : '';
  const routine_candidate = current_routine_struct || current_routine_text || null;
  const has_current_routine = Boolean(
    current_routine_struct ||
      (typeof routine_candidate === 'string' && routine_candidate.trim()) ||
      (Array.isArray(routine_candidate) && routine_candidate.length) ||
      (isPlainObject(routine_candidate) && Object.keys(routine_candidate).length),
  );
  return {
    current_routine_struct,
    current_routine_text: current_routine_text || null,
    routine_candidate,
    has_current_routine,
    source_shape: sourceShape,
    missing_routine_fields: buildMissingRoutineFields(current_routine_struct),
  };
}

function normalizeRoutineStateValue(raw) {
  if (raw == null) {
    return {
      current_routine_struct: null,
      current_routine_text: null,
      routine_candidate: null,
      has_current_routine: false,
      source_shape: 'empty',
      missing_routine_fields: DEFAULT_MISSING_FIELDS.slice(),
    };
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return {
        current_routine_struct: null,
        current_routine_text: null,
        routine_candidate: null,
        has_current_routine: false,
        source_shape: 'empty',
        missing_routine_fields: DEFAULT_MISSING_FIELDS.slice(),
      };
    }

    const lowered = trimmed.toLowerCase();
    if (LEGACY_ENUM_VALUES.has(lowered)) {
      return {
        current_routine_struct: null,
        current_routine_text: trimmed,
        routine_candidate: trimmed,
        has_current_routine: lowered !== 'none' && lowered !== '',
        source_shape: 'legacy_enum',
        missing_routine_fields: DEFAULT_MISSING_FIELDS.slice(),
      };
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return buildRoutineState(parsed, 'json_array_string');
      }
      if (isPlainObject(parsed)) {
        return buildRoutineState(parsed, 'json_object_string');
      }
    } catch {
      return {
        current_routine_struct: null,
        current_routine_text: truncateText(trimmed, 4000) || null,
        routine_candidate: truncateText(trimmed, 4000) || null,
        has_current_routine: true,
        source_shape: trimmed.startsWith('{') || trimmed.startsWith('[') ? 'invalid_json_string' : 'plain_text',
        missing_routine_fields: DEFAULT_MISSING_FIELDS.slice(),
      };
    }

    return {
      current_routine_struct: null,
      current_routine_text: truncateText(trimmed, 4000) || null,
      routine_candidate: truncateText(trimmed, 4000) || null,
      has_current_routine: true,
      source_shape: 'plain_text',
      missing_routine_fields: DEFAULT_MISSING_FIELDS.slice(),
    };
  }

  if (Array.isArray(raw)) return buildRoutineState(raw, 'array');
  if (isPlainObject(raw)) {
    const sourceShape =
      Array.isArray(raw.am) ||
      Array.isArray(raw.pm) ||
      isPlainObject(raw.am) ||
      isPlainObject(raw.pm) ||
      Array.isArray(raw.am_steps) ||
      Array.isArray(raw.pm_steps)
        ? 'am_pm_object'
        : 'object';
    return buildRoutineState(raw, sourceShape);
  }

  return {
    current_routine_struct: null,
    current_routine_text: truncateText(String(raw), 4000) || null,
    routine_candidate: truncateText(String(raw), 4000) || null,
    has_current_routine: Boolean(truncateText(String(raw), 4000)),
    source_shape: typeof raw,
    missing_routine_fields: DEFAULT_MISSING_FIELDS.slice(),
  };
}

function normalizeRoutineStateFromProfile(profile) {
  const source = isPlainObject(profile) ? profile.currentRoutine ?? profile.current_routine ?? null : null;
  return normalizeRoutineStateValue(source);
}

function getRoutineStateSummaryValue(raw) {
  return normalizeRoutineStateValue(raw).current_routine_text;
}

module.exports = {
  normalizeRoutineStateValue,
  normalizeRoutineStateFromProfile,
  getRoutineStateSummaryValue,
  buildMissingRoutineFields,
  normalizeRoutineInputWithPmShortcut,
};
