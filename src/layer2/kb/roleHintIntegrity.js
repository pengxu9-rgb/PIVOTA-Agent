function stableSort(list) {
  return [...list].sort((a, b) => String(a).localeCompare(String(b)));
}

function applyNormalization(s, rules) {
  let out = String(s || "");
  if (rules?.trim) out = out.trim();
  for (const r of rules?.replace_chars || []) out = out.split(r.from).join(r.to);
  if (rules?.collapse_whitespace) out = out.replace(/\s+/g, " ");
  if (rules?.lowercase) out = out.toLowerCase();
  return out;
}

function tokenize(s) {
  return String(s || "")
    .split(/\s+/g)
    .map((t) => t.trim())
    .filter(Boolean);
}

function levenshtein(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  const n = s.length;
  const m = t.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const dp = new Array(m + 1);
  for (let j = 0; j <= m; j += 1) dp[j] = j;
  for (let i = 1; i <= n; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= m; j += 1) {
      const tmp = dp[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[m];
}

function similarityScore(a, b) {
  const na = String(a || "");
  const nb = String(b || "");
  if (!na || !nb) return 0;

  const ta = tokenize(na);
  const tb = tokenize(nb);
  const setA = new Set(ta);
  const setB = new Set(tb);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const tokenScore = (2 * inter) / (setA.size + setB.size);

  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length) || 1;
  const editScore = 1 - dist / maxLen;

  return tokenScore * 0.7 + editScore * 0.3;
}

function buildRoleCandidatesFromDict(rolesDict) {
  const d = rolesDict || {};
  const rules = d.normalization_rules || {};
  const roles = Array.isArray(d.roles) ? d.roles : [];
  const candidates = [];
  for (const role of roles) {
    const roleId = String(role?.id || "").trim();
    if (!roleId) continue;
    candidates.push({ roleId, phrase: applyNormalization(roleId, rules) });
    for (const syn of Array.isArray(role?.synonyms) ? role.synonyms : []) {
      const p = applyNormalization(syn, rules);
      if (p) candidates.push({ roleId, phrase: p });
    }
  }
  return { rules, candidates };
}

function suggestRoleIdsForHint({ normalizedHint, candidates, max = 3 }) {
  const hint = String(normalizedHint || "").trim();
  if (!hint) return [];

  const bestByRole = new Map();
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const roleId = String(c?.roleId || "").trim();
    const phrase = String(c?.phrase || "").trim();
    if (!roleId || !phrase) continue;
    const score = similarityScore(hint, phrase);
    const prev = bestByRole.get(roleId);
    if (prev == null || score > prev) bestByRole.set(roleId, score);
  }

  return stableSort(
    Array.from(bestByRole.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, Math.max(0, Number(max) || 0))
      .map(([roleId]) => roleId)
  );
}

function lintRoleHintsForCards({ market, cards, rolesDict, normalizeRoleHint, maxSuggestions = 3 }) {
  const list = Array.isArray(cards) ? cards : [];
  const { rules, candidates } = buildRoleCandidatesFromDict(rolesDict);

  let cardsWithRoleHints = 0;
  let totalRoleHints = 0;

  const unknownRoleHints = [];
  const byHint = new Map();
  const affected = new Set();

  for (const card of list) {
    const cardId = String(card?.id || "").trim();
    const hints = Array.isArray(card?.productRoleHints) ? card.productRoleHints : [];
    if (!hints.length) continue;
    cardsWithRoleHints += 1;
    for (const h of hints) {
      const hint = String(h || "");
      if (!hint.trim()) continue;
      totalRoleHints += 1;

      const mapped = typeof normalizeRoleHint === "function" ? normalizeRoleHint(hint) : null;
      if (mapped) continue;

      const normalizedHint = applyNormalization(hint, rules);
      const suggestions = suggestRoleIdsForHint({ normalizedHint, candidates, max: maxSuggestions });
      unknownRoleHints.push({ cardId, hint, normalizedHint, suggestions });
      affected.add(cardId);

      const key = hint;
      if (!byHint.has(key)) byHint.set(key, new Set());
      byHint.get(key).add(cardId);
    }
  }

  const byHintObj = {};
  for (const [hint, cardSet] of byHint.entries()) {
    const cardsForHint = stableSort(Array.from(cardSet));
    byHintObj[hint] = { count: cardsForHint.length, cards: cardsForHint };
  }

  return {
    market,
    summary: {
      kbCardCount: list.length,
      cardsWithRoleHints,
      totalRoleHints,
      unknownRoleHintsCount: unknownRoleHints.length,
      cardsAffectedCount: affected.size,
    },
    unknownRoleHints: unknownRoleHints.sort((a, b) => a.cardId.localeCompare(b.cardId) || a.hint.localeCompare(b.hint)),
    byHint: byHintObj,
  };
}

module.exports = {
  applyNormalization,
  buildRoleCandidatesFromDict,
  suggestRoleIdsForHint,
  lintRoleHintsForCards,
};

