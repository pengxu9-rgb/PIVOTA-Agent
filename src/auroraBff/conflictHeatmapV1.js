const {
  getRuleCopy,
  getDefaultRuleCopy,
  filterRecommendations,
  i18n,
  normalizeText,
} = require('./conflictHeatmapRuleRegistry');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceIndex(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isInteger(n)) return n;
  }
  return null;
}

function coerceSeverity(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.trunc(value);
    if (n <= 0) return 0;
    if (n >= 3) return 3;
    return n;
  }
  const s = normalizeText(value, { maxLen: 30 }).toLowerCase();
  if (s === 'block') return 3;
  if (s === 'warn') return 2;
  if (s === 'low') return 1;
  if (s === 'none') return 0;
  if (!s) return 0;
  return 2;
}

function getStepPair(conflict) {
  if (!isPlainObject(conflict)) return null;
  const raw =
    Array.isArray(conflict.step_indices) ? conflict.step_indices
      : Array.isArray(conflict.stepIndices) ? conflict.stepIndices
        : Array.isArray(conflict.step_pair) ? conflict.step_pair
          : Array.isArray(conflict.stepPair) ? conflict.stepPair
            : null;
  if (!raw || raw.length < 2) return null;
  const i = coerceIndex(raw[0]);
  const j = coerceIndex(raw[1]);
  if (i == null || j == null) return null;
  if (i === j) return null;
  return i < j ? [i, j] : [j, i];
}

function normalizeStepLabel(value) {
  if (typeof value === 'string') return value.trim();
  return '';
}

function buildStepAxisItems(stepsRaw, maxItems) {
  const steps = Array.isArray(stepsRaw) ? stepsRaw : [];
  const out = [];
  for (let index = 0; index < steps.length && out.length < maxItems; index += 1) {
    const step = steps[index];
    let label = '';
    let shortLabel = '';

    if (typeof step === 'string') {
      label = normalizeStepLabel(step);
      shortLabel = label;
    } else if (isPlainObject(step)) {
      const labelObj = step.label_i18n && isPlainObject(step.label_i18n) ? step.label_i18n : null;
      const shortObj = step.short_label_i18n && isPlainObject(step.short_label_i18n) ? step.short_label_i18n : null;
      if (labelObj && typeof labelObj.en === 'string' && typeof labelObj.zh === 'string') {
        label = labelObj.en.trim() || labelObj.zh.trim();
      } else {
        label = normalizeStepLabel(step.label || step.step || step.name || step.title || step.category);
      }
      if (shortObj && typeof shortObj.en === 'string' && typeof shortObj.zh === 'string') {
        shortLabel = shortObj.en.trim() || shortObj.zh.trim();
      } else {
        shortLabel = normalizeStepLabel(step.short_label || step.shortLabel) || label;
      }
    }

    if (!label) {
      const n = index + 1;
      out.push({
        index,
        step_key: `step_${index}`,
        label_i18n: i18n(`Step ${n}`, `步骤 ${n}`),
        short_label_i18n: i18n(`Step ${n}`, `步骤 ${n}`),
      });
      continue;
    }

    const trimmedLabel = label.slice(0, 60);
    const trimmedShort = (shortLabel || label).slice(0, 24);

    out.push({
      index,
      step_key: `step_${index}`,
      label_i18n: i18n(trimmedLabel, trimmedLabel),
      short_label_i18n: i18n(trimmedShort, trimmedShort),
    });
  }
  return out;
}

function makeEmptyHeatmapPayload({ routineSimulation }) {
  const simObj = isPlainObject(routineSimulation) ? routineSimulation : {};
  const conflicts = Array.isArray(simObj.conflicts) ? simObj.conflicts : [];
  const schema = normalizeText(simObj.schema_version, { maxLen: 80 }) || 'unknown';

  return {
    schema_version: 'aurora.ui.conflict_heatmap.v1',
    state: 'unavailable',
    title_i18n: i18n('Conflict heatmap', '冲突热力图'),
    subtitle_i18n: i18n('Step × step compatibility (v1)', '步骤 × 步骤兼容性（V1）'),
    axes: {
      rows: { axis_id: 'steps', type: 'routine_steps', max_items: 16, items: [] },
      cols: { axis_id: 'steps', type: 'routine_steps', max_items: 16, items: [] },
      diagonal_policy: 'empty',
    },
    severity_scale: {
      min: 0,
      max: 3,
      meaning: '0 none, 1 low, 2 warn, 3 block',
      labels_i18n: { en: ['None', 'Low', 'Warn', 'Block'], zh: ['无', '低', '警告', '阻断'] },
      mapping_from_routine_simulation: { warn: 2, block: 3 },
    },
    cells: {
      encoding: 'sparse',
      default_severity: 0,
      items: [],
      max_items: 64,
      max_rule_ids_per_cell: 3,
      max_recommendations_per_cell: 3,
    },
    unmapped_conflicts: [],
    footer_note_i18n: i18n(
      'Compatibility and irritation guidance only (not medical advice).',
      '仅用于护肤兼容性/刺激风险提示（不构成医疗建议）。',
    ),
    generated_from: {
      routine_simulation_schema_version: schema,
      routine_simulation_safe: Boolean(simObj.safe),
      conflict_count: conflicts.length,
    },
  };
}

function buildConflictHeatmapV1({ routineSimulation, routineSteps }) {
  const simObj = isPlainObject(routineSimulation) ? routineSimulation : null;
  if (!simObj) return makeEmptyHeatmapPayload({ routineSimulation: null });

  const stepsMax = 16;
  const axisItems = buildStepAxisItems(routineSteps, stepsMax);
  const stepsCount = axisItems.length;

  const conflicts = Array.isArray(simObj.conflicts) ? simObj.conflicts : [];
  const schema = normalizeText(simObj.schema_version, { maxLen: 80 }) || 'unknown';

  const unmapped = [];
  const cellAgg = new Map();

  for (const conflict of conflicts) {
    if (!isPlainObject(conflict)) continue;
    const ruleId = normalizeText(conflict.rule_id || conflict.ruleId, { maxLen: 80 }) || 'unknown_rule';
    const sev = coerceSeverity(conflict.severity);

    const pair = getStepPair(conflict);
    if (!pair || stepsCount === 0) {
      const copy = getRuleCopy(ruleId) || getDefaultRuleCopy(ruleId);
      unmapped.push({
        rule_id: ruleId,
        severity: sev,
        message_i18n: copy.why_i18n,
      });
      continue;
    }

    const [i, j] = pair;
    if (i < 0 || j < 0 || i >= stepsCount || j >= stepsCount) {
      const copy = getRuleCopy(ruleId) || getDefaultRuleCopy(ruleId);
      unmapped.push({
        rule_id: ruleId,
        severity: sev,
        message_i18n: copy.why_i18n,
      });
      continue;
    }

    const row = i;
    const col = j;
    const key = `${row}|${col}`;
    const existing = cellAgg.get(key);
    const agg = existing || {
      row_index: row,
      col_index: col,
      severity: 0,
      ruleSeverities: new Map(),
    };
    agg.severity = Math.max(agg.severity, sev);
    const prev = agg.ruleSeverities.get(ruleId) || 0;
    agg.ruleSeverities.set(ruleId, Math.max(prev, sev));
    if (!existing) cellAgg.set(key, agg);
  }

  const cellsItems = [];
  let maxSeverity = 0;
  for (const agg of cellAgg.values()) {
    const ruleIdsAll = Array.from(agg.ruleSeverities.keys()).sort();
    const ruleIds = ruleIdsAll.slice(0, 3);

    let primaryRuleId = ruleIdsAll[0] || 'unknown_rule';
    let primarySev = -1;
    for (const rid of ruleIdsAll) {
      const s = agg.ruleSeverities.get(rid) || 0;
      if (s > primarySev) {
        primarySev = s;
        primaryRuleId = rid;
      } else if (s === primarySev && String(rid) < String(primaryRuleId)) {
        primaryRuleId = rid;
      }
    }

    const copy = getRuleCopy(primaryRuleId) || getDefaultRuleCopy(primaryRuleId);
    const cellSeverity = Math.max(0, Math.min(3, Math.trunc(agg.severity)));
    maxSeverity = Math.max(maxSeverity, cellSeverity);

    cellsItems.push({
      cell_id: `cell_${agg.row_index}_${agg.col_index}`,
      row_index: agg.row_index,
      col_index: agg.col_index,
      severity: cellSeverity,
      rule_ids: ruleIds,
      headline_i18n: copy.headline_i18n,
      why_i18n: copy.why_i18n,
      recommendations: filterRecommendations(copy.recommendations),
    });
  }

  cellsItems.sort((a, b) => (a.row_index - b.row_index) || (a.col_index - b.col_index));

  const unmappedSorted = unmapped
    .map((u) => ({
      rule_id: normalizeText(u.rule_id, { maxLen: 80 }) || 'unknown_rule',
      severity: Math.max(0, Math.min(3, Math.trunc(coerceSeverity(u.severity)))),
      message_i18n: u.message_i18n && isPlainObject(u.message_i18n) ? u.message_i18n : i18n('—', '—'),
    }))
    .sort((a, b) => (b.severity - a.severity) || String(a.rule_id).localeCompare(String(b.rule_id)))
    .slice(0, 10);

  maxSeverity = Math.max(maxSeverity, ...unmappedSorted.map((u) => u.severity));

  const anyConflicts = conflicts.length > 0;
  const hasUnmapped = unmappedSorted.length > 0;
  const hasMapped = cellsItems.length > 0;

  let state = 'unavailable';
  if (stepsCount === 0) {
    state = 'unavailable';
  } else if (!anyConflicts) {
    state = 'no_conflicts';
  } else if (hasUnmapped) {
    state = 'has_conflicts_partial';
  } else if (hasMapped) {
    state = 'has_conflicts';
  } else {
    state = 'has_conflicts_partial';
  }

  if (state === 'unavailable') {
    const empty = makeEmptyHeatmapPayload({ routineSimulation: simObj });
    return {
      ...empty,
      unmapped_conflicts: unmappedSorted,
    };
  }

  return {
    schema_version: 'aurora.ui.conflict_heatmap.v1',
    state,
    title_i18n: i18n('Conflict heatmap', '冲突热力图'),
    subtitle_i18n: i18n('Step × step compatibility (v1)', '步骤 × 步骤兼容性（V1）'),
    axes: {
      rows: { axis_id: 'steps', type: 'routine_steps', max_items: stepsMax, items: axisItems },
      cols: { axis_id: 'steps', type: 'routine_steps', max_items: stepsMax, items: axisItems },
      diagonal_policy: 'empty',
    },
    severity_scale: {
      min: 0,
      max: 3,
      meaning: '0 none, 1 low, 2 warn, 3 block',
      labels_i18n: { en: ['None', 'Low', 'Warn', 'Block'], zh: ['无', '低', '警告', '阻断'] },
      mapping_from_routine_simulation: { warn: 2, block: 3 },
    },
    cells: {
      encoding: 'sparse',
      default_severity: 0,
      items: cellsItems.slice(0, 64),
      max_items: 64,
      max_rule_ids_per_cell: 3,
      max_recommendations_per_cell: 3,
    },
    unmapped_conflicts: unmappedSorted,
    footer_note_i18n: i18n(
      'Compatibility and irritation guidance only (not medical advice).',
      '仅用于护肤兼容性/刺激风险提示（不构成医疗建议）。',
    ),
    generated_from: {
      routine_simulation_schema_version: schema,
      routine_simulation_safe: Boolean(simObj.safe),
      conflict_count: conflicts.length,
    },
  };
}

module.exports = {
  buildConflictHeatmapV1,
};

