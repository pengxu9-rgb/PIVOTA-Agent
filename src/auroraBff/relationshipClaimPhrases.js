'use strict';

// One detector for unsupported social-proof copy, shared by the relationship-graph builder (which
// strips it from the snapshot text an edge stores) and scripts/audit-product-relationship-graph.js
// (which fails a report that still carries it). Keeping both on this module is the point: a second
// list in either place would let the builder store what the audit rejects, or the reverse.
//
// 2026-09-26 JP/AU dry run: the only failing audit gate was unsupported_claims, 27 edges whose
// candidate_snapshot.description quoted merchant copy ("The viral product you've been waiting for!",
// "A viral bestseller"). Popularity claims that no source_ref supports are stripped sentence by
// sentence; the rest of the copy stays.

const SOCIAL_CLAIM_PATTERN = new RegExp(
  [
    '\\b(?:tiktok|tik\\s*tok|instagram|insta|creator|influencer|viral|social proof|ugc|testimonial|celebrity|raved about|hyped|trending)\\b',
    '\\b(?:best[\\s-]?sellers?|best[\\s-]?selling|award[\\s-]?winning|cult[\\s-](?:favou?rite|classic)|top[\\s-]?rated|most[\\s-]?loved|as seen on|number[\\s-]?(?:one|1))\\b',
    '(?:^|[\\s(])#\\s?1\\b',
    '\\bno\\.?\\s?1\\b',
  ].join('|'),
  'i',
);

// The claim fields the audit reads on each snapshot (scripts/audit-product-relationship-graph.js
// claimTextFragments). The builder neutralises exactly these.
const CANDIDATE_CLAIM_FIELDS = [
  'description',
  'short_description',
  'long_description',
  'marketing_copy',
  'claims',
  'claim',
  'benefits',
  'highlights',
  'reason',
  'reasons',
  'why',
];
const ANCHOR_CLAIM_FIELDS = ['description', 'claims', 'benefits'];

// Sentence ends, lines and bullets. "No." (as in "No. 1") is an abbreviation, not a sentence end.
const SENTENCE_SPLIT = /(?<=[.!?。！？])(?<!\b[Nn]o\.)\s+|\r?\n+|\s+[•·|]\s+/;

function hasSocialProofClaim(text) {
  return SOCIAL_CLAIM_PATTERN.test(String(text == null ? '' : text));
}

// Drop every sentence (or line / bullet) that carries a social-proof phrase. Returns '' when nothing
// supportable is left.
function stripSocialProofSentences(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw || !SOCIAL_CLAIM_PATTERN.test(raw)) return raw;
  return raw
    .split(SENTENCE_SPLIT)
    .map((part) => part.trim())
    .filter((part) => part && !SOCIAL_CLAIM_PATTERN.test(part))
    .join(' ')
    .trim();
}

function neutralizeClaimValue(value, depth = 0) {
  if (value == null || depth > 8) return value;
  if (typeof value === 'string') {
    const stripped = stripSocialProofSentences(value);
    return stripped ? stripped : undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => neutralizeClaimValue(item, depth + 1)).filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const next = neutralizeClaimValue(child, depth + 1);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  return value;
}

// Returns a copy of `snapshot` with the listed claim fields stripped of social-proof sentences. A
// field left with no supportable text is removed rather than stored empty.
function neutralizeSnapshotClaims(snapshot, fields) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  let out = snapshot;
  for (const field of fields) {
    if (snapshot[field] == null) continue;
    const next = neutralizeClaimValue(snapshot[field]);
    if (next === snapshot[field]) continue;
    if (out === snapshot) out = { ...snapshot };
    if (next === undefined) delete out[field];
    else out[field] = next;
  }
  return out;
}

module.exports = {
  SOCIAL_CLAIM_PATTERN,
  CANDIDATE_CLAIM_FIELDS,
  ANCHOR_CLAIM_FIELDS,
  hasSocialProofClaim,
  stripSocialProofSentences,
  neutralizeClaimValue,
  neutralizeSnapshotClaims,
};
