function tokenize(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function overlapScore(hay, needles) {
  if (!hay.length || !needles.length) return 0;
  const set = new Set(hay);
  let hits = 0;
  for (const n of needles) if (set.has(n)) hits += 1;
  return hits / Math.max(needles.length, 1);
}

function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function rankCandidates(input) {
  const { category, lookSpec } = input;
  const area = lookSpec.breakdown[category];
  const desiredTokens = tokenize([area.finish, area.coverage, ...(area.keyNotes || [])].join(' '));

  const scored = (input.candidates || []).map((candidate) => {
    const textTokens = tokenize(candidate.rawText);
    const finishTokens = tokenize(candidate.tags.finish.join(' '));
    const coverageTokens = tokenize(candidate.tags.coverage.join(' '));

    const finishScore = overlapScore(finishTokens, tokenize(area.finish));
    const coverageScore = overlapScore(coverageTokens, tokenize(area.coverage));
    const notesScore = overlapScore(textTokens, desiredTokens);
    const availabilityScore = candidate.availability === 'in_stock' ? 1 : candidate.availability === 'unknown' ? 0.4 : 0;

    const score = clamp01(finishScore * 0.35 + coverageScore * 0.25 + notesScore * 0.25 + availabilityScore * 0.15);
    return { candidate, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.candidate.availability !== b.candidate.availability) {
      if (a.candidate.availability === 'in_stock') return -1;
      if (b.candidate.availability === 'in_stock') return 1;
    }
    return b.candidate.price.amount - a.candidate.price.amount;
  });

  const warnings = [];
  const best = scored.length ? scored[0].candidate : null;
  const bestScore = scored.length ? scored[0].score : 0;
  if (!best) return { best: null, dupe: null, warnings: ['NO_CANDIDATES'] };

  const bestPrice = best.price.amount;
  const dupePool = scored
    .slice(1)
    .filter((it) => it.score >= Math.max(0, bestScore - 0.1))
    .map((it) => it.candidate);

  let dupe = null;
  const cheaper = dupePool.filter((c) => c.price.currency === best.price.currency && c.price.amount > 0 && c.price.amount <= bestPrice);
  if (cheaper.length) {
    cheaper.sort((a, b) => a.price.amount - b.price.amount);
    dupe = cheaper[0];
  } else if (dupePool.length) {
    dupePool.sort((a, b) => a.price.amount - b.price.amount);
    dupe = dupePool[0];
    if (dupe.price.amount > bestPrice) warnings.push('DUPE_NOT_CHEAPER');
  } else {
    dupe = scored.length > 1 ? scored[1].candidate : null;
    if (dupe) warnings.push('DUPE_WEAK_MATCH');
  }

  if (!dupe) warnings.push('NO_DUPE_FOUND');
  return { best, dupe, warnings };
}

module.exports = {
  rankCandidates,
};

