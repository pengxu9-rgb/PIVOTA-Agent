function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr || []) {
    const s = String(v || '').trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function normalizeActiveToken(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return null;

  const map = [
    [/tretinoin|adapalene|retinal|retinol|retinoid/, 'retinoid'],
    [/benzoyl\s*peroxide|bpo/, 'benzoyl_peroxide'],
    [/salicylic|bha/, 'bha'],
    [/glycolic|lactic|mandelic|aha/, 'aha'],
    [/vitamin\s*c|ascorbic|l-ascorbic|ascorbate/, 'vitamin_c'],
    [/niacinamide/, 'niacinamide'],
    [/azelaic/, 'azelaic_acid'],
    [/tranexamic/, 'tranexamic_acid'],
  ];

  for (const [re, out] of map) {
    if (re.test(t)) return out;
  }

  // Keep short unknown tokens for debugging but avoid bloating.
  if (t.length > 40) return null;
  return t;
}

function extractActives(product) {
  if (!product || typeof product !== 'object') return [];
  const candidates = [];

  const keyActives = product.key_actives || product.keyActives || product.actives;
  if (Array.isArray(keyActives)) candidates.push(...keyActives);

  const evidence = product.evidence_pack || product.evidencePack;
  if (evidence && typeof evidence === 'object') {
    if (Array.isArray(evidence.keyActives)) candidates.push(...evidence.keyActives);
  }

  const ingredients = product.ingredients;
  if (ingredients && typeof ingredients === 'object') {
    if (Array.isArray(ingredients.highlights)) candidates.push(...ingredients.highlights);
    if (Array.isArray(ingredients.head)) candidates.push(...ingredients.head);
  }

  const name = product.name || product.title;
  if (typeof name === 'string') candidates.push(name);

  const normalized = uniq(
    candidates
      .flatMap((v) => (typeof v === 'string' ? v.split(/[,/|+]/) : []))
      .map(normalizeActiveToken)
      .filter(Boolean),
  );
  return normalized;
}

function simulateConflicts({ routine, testProduct }) {
  const am = Array.isArray(routine && routine.am) ? routine.am : [];
  const pm = Array.isArray(routine && routine.pm) ? routine.pm : [];

  const stepActives = [];
  for (const item of am) stepActives.push(extractActives(item).map((t) => t.toLowerCase()));
  for (const item of pm) stepActives.push(extractActives(item).map((t) => t.toLowerCase()));
  if (testProduct) stepActives.push(extractActives(testProduct).map((t) => t.toLowerCase()));

  const routineActives = uniq([
    ...am.flatMap(extractActives),
    ...pm.flatMap(extractActives),
  ]).map((t) => t.toLowerCase());

  const testActives = extractActives(testProduct).map((t) => t.toLowerCase());

  const has = (token) => routineActives.includes(token) || testActives.includes(token);
  const pairs = new Set();
  for (const a of routineActives) pairs.add(`routine:${a}`);
  for (const a of testActives) pairs.add(`test:${a}`);

  const conflicts = [];

  const indicesWith = (token) => {
    const out = [];
    for (let i = 0; i < stepActives.length; i += 1) {
      if (stepActives[i].includes(token)) out.push(i);
    }
    return out;
  };

  const findDistinctPair = (aIndices, bIndices) => {
    const a = Array.isArray(aIndices) ? aIndices : [];
    const b = Array.isArray(bIndices) ? bIndices : [];
    for (const i of a) {
      for (const j of b) {
        if (i === j) continue;
        return i < j ? [i, j] : [j, i];
      }
    }
    return null;
  };

  // Retinoid + strong acids
  if (has('retinoid') && (has('aha') || has('bha'))) {
    const pair = findDistinctPair(indicesWith('retinoid'), [...indicesWith('aha'), ...indicesWith('bha')]);
    conflicts.push({
      severity: 'warn',
      rule_id: 'retinoid_x_acids',
      message: 'Retinoids + AHAs/BHAs can increase irritation. Consider alternating nights or spacing them apart.',
      ...(pair ? { step_indices: pair } : {}),
    });
  }

  // Retinoid + benzoyl peroxide
  if (has('retinoid') && has('benzoyl_peroxide')) {
    const pair = findDistinctPair(indicesWith('retinoid'), indicesWith('benzoyl_peroxide'));
    conflicts.push({
      severity: 'block',
      rule_id: 'retinoid_x_bpo',
      message: 'Avoid layering retinoids with benzoyl peroxide in the same routine; it can be very irritating and reduce efficacy.',
      ...(pair ? { step_indices: pair } : {}),
    });
  }

  // Vitamin C + acids
  if (has('vitamin_c') && (has('aha') || has('bha'))) {
    const pair = findDistinctPair(indicesWith('vitamin_c'), [...indicesWith('aha'), ...indicesWith('bha')]);
    conflicts.push({
      severity: 'warn',
      rule_id: 'vitc_x_acids',
      message: 'Vitamin C + strong acids may be too irritating for some skin types. Consider separating AM/PM.',
      ...(pair ? { step_indices: pair } : {}),
    });
  }

  // Over-exfoliation
  const exfoliantCount = ['aha', 'bha'].filter((t) => routineActives.includes(t)).length;
  if (exfoliantCount >= 2) {
    const exfoliantSteps = Array.from(new Set([...indicesWith('aha'), ...indicesWith('bha')])).sort((a, b) => a - b);
    const pair = exfoliantSteps.length >= 2 ? [exfoliantSteps[0], exfoliantSteps[1]] : null;
    conflicts.push({
      severity: 'warn',
      rule_id: 'multiple_exfoliants',
      message: 'Multiple exfoliants detected in the routine. Watch for dryness/irritation and reduce frequency if needed.',
      ...(pair ? { step_indices: pair } : {}),
    });
  }

  const safe = conflicts.length === 0;
  const summary = safe
    ? 'Looks compatible with your routine order.'
    : conflicts.some((c) => c.severity === 'block')
      ? 'Potentially unsafe combo detected. Consider changing the routine order or alternating days.'
      : 'Some irritation risks detected. Consider spacing actives apart or alternating nights.';

  return { safe, conflicts, summary, debug: { routineActives, testActives, pairs: Array.from(pairs).slice(0, 50) } };
}

module.exports = {
  extractActives,
  simulateConflicts,
};
