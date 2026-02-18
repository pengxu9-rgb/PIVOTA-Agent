const crypto = require('crypto');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickFirst(...values) {
  for (const value of values) {
    const text = String(value == null ? '' : value).trim();
    if (text) return text;
  }
  return '';
}

function buildCandidateKey(candidate, index = 0) {
  const row = isPlainObject(candidate) ? candidate : {};
  const key = pickFirst(
    row.product_id,
    row.productId,
    row.sku_id,
    row.skuId,
    row.id,
    row.url,
    row.name,
    row.display_name,
    row.displayName,
    `idx:${index}`,
  );
  return String(key || `idx:${index}`).trim().toLowerCase();
}

function normalizeList(rows) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < (Array.isArray(rows) ? rows : []).length; i += 1) {
    const row = rows[i];
    if (!isPlainObject(row)) continue;
    const key = buildCandidateKey(row, i);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, row });
  }
  return out;
}

function seedStartTeam(seed = '') {
  const text = String(seed || '').trim();
  if (!text) return 'A';
  const digest = crypto.createHash('sha1').update(text).digest('hex');
  const first = Number.parseInt(digest.slice(0, 2), 16);
  return first % 2 === 0 ? 'A' : 'B';
}

function teamDraftInterleave({ rankedA, rankedB, limit, seed } = {}) {
  const listA = normalizeList(rankedA);
  const listB = normalizeList(rankedB);
  const cap = Math.max(0, Math.min(100, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : Math.max(listA.length, listB.length)));

  const presence = new Map();
  for (const item of listA) presence.set(item.key, { inA: true, inB: false });
  for (const item of listB) {
    const prev = presence.get(item.key) || { inA: false, inB: false };
    prev.inB = true;
    presence.set(item.key, prev);
  }

  const output = [];
  const attribution = {};
  const seen = new Set();

  let idxA = 0;
  let idxB = 0;
  let turn = seedStartTeam(seed);

  const pickFrom = (team) => {
    if (team === 'A') {
      while (idxA < listA.length) {
        const cand = listA[idxA++];
        if (seen.has(cand.key)) continue;
        return { team: 'A', ...cand };
      }
      return null;
    }
    while (idxB < listB.length) {
      const cand = listB[idxB++];
      if (seen.has(cand.key)) continue;
      return { team: 'B', ...cand };
    }
    return null;
  };

  while (output.length < cap) {
    const primary = pickFrom(turn);
    const fallbackTeam = turn === 'A' ? 'B' : 'A';
    const picked = primary || pickFrom(fallbackTeam);
    if (!picked) break;

    seen.add(picked.key);
    output.push(picked.row);

    const p = presence.get(picked.key) || { inA: false, inB: false };
    let attr = picked.team;
    if (p.inA && p.inB) attr = 'both';
    attribution[picked.key] = attr;

    turn = fallbackTeam;
  }

  return {
    interleaved: output,
    attribution,
  };
}

module.exports = {
  teamDraftInterleave,
  buildCandidateKey,
};
