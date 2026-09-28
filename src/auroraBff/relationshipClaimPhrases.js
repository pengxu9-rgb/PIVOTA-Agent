'use strict';

// One detector for unsupported social-proof copy, shared by the relationship-graph builder (which
// strips it from the snapshot text an edge stores) and scripts/audit-product-relationship-graph.js
// (which fails a report that still carries it). Keeping both on this module is the point: a second
// list in either place would let the builder store what the audit rejects, or the reverse.
//
// Two tiers, one list:
//   - SOCIAL_CLAIM_PATTERN is the audit GATE. It is the pre-#2290 audit pattern, narrowed so that a
//     product-name compound ("Insta-Glow Serum"), a company name ("creator labs") and a shade name
//     ("Trending shade") no longer fire. It is deliberately not widened: stored edges built before
//     this change must not start failing the daily relgraph-sync audit.
//   - SOCIAL_PROOF_STRIP_PATTERNS is what the builder strips: the gate phrases plus popularity
//     claims no source_ref can support ("best seller", "award-winning", "#1", "No. 1", "cult
//     favourite", "as seen on"). Ordinals are exempt in product-name context ("Chanel No. 1 de
//     Chanel", "Nars #1 shade"): preceded by the snapshot brand or by a mid-sentence capitalised name.
//
// Stripping is phrase-level: the phrase is cut out and the sentence keeps its product words. A
// sentence with fewer than three content words left, or that lost more than half of them, is
// dropped. Sentences split on . ! ? and on 。！？ with or without a following space.
//
// 2026-09-26 JP/AU dry run: the only failing audit gate was unsupported_claims, 27 edges whose
// candidate_snapshot.description quoted merchant copy ("The viral product you've been waiting for!",
// "A viral bestseller").

const SOCIAL_CLAIM_SOURCE = [
  'tiktok',
  'tik\\s*tok',
  'instagram',
  // "insta" alone, never the compound "Insta-Glow" / "InstaBright".
  'insta(?![\\w-])',
  // "creator" only as social proof, never "creator labs" / "Creator Studio". Singular only: the
  // pre-#2290 gate was \bcreator\b, and this gate must match a SUBSET of what that one matched.
  'content creator',
  'creator[\\s-]+(?:favou?rite|approved|loved|backed|pick)',
  'influencer',
  'viral',
  'social proof',
  'ugc',
  'testimonial',
  'celebrity',
  'raved about',
  'hyped',
  // "trending" as popularity ("trending on TikTok", "trending now"), never "Trending shade".
  'trending\\s+(?:on\\s+\\w+|now|everywhere|worldwide|right now)',
];
const SOCIAL_CLAIM_PATTERN = new RegExp(`\\b(?:${SOCIAL_CLAIM_SOURCE.join('|')})\\b`, 'i');

const POPULARITY_CLAIM_SOURCE = [
  // Plural social-proof forms the gate never matched (it is a subset of the pre-#2290 gate); the
  // builder still strips them.
  'content creators',
  'creators?[\\s-]+(?:favou?rites|picks)',
  'influencers',
  'testimonials',
  'best[\\s-]?sellers?',
  'best[\\s-]?selling',
  'award[\\s-]?winning',
  'cult[\\s-](?:favou?rites?|classics?)',
  'as seen on(?:\\s+[\\w-]+)?',
];
const POPULARITY_CLAIM_PATTERN = new RegExp(`\\b(?:${POPULARITY_CLAIM_SOURCE.join('|')})\\b`, 'i');
// "#1", "No. 1", "number one": a rank claim unless it names a product line.
const ORDINAL_CLAIM_PATTERN = /(?:(?:^|[\s(])#\s?1\b|\bno\.?\s?1\b|\bnumber[\s-]?(?:one|1)\b)/i;

const SOCIAL_SOURCE_SUPPORT_PATTERN = /\b(?:social|creator|influencer|tiktok|tik\s*tok|instagram|ugc|review|reviews|testimonial|press|editorial|citation|source)\b/i;

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

// Words that cannot open or close a clause on their own; a stripped sentence that starts or ends on
// one, or has one left hanging before a comma, has lost its predicate and is dropped whole.
const DANGLING_LEAD_WORDS = new Set(['and', 'as', 'but', 'by', 'of', 'or', 'so', 'than', 'with']);
const DANGLING_TAIL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'from', 'into', 'of', 'on', 'or', 'so', 'than', 'the', 'to', 'with']);
const MIN_KEPT_WORD_SHARE = 0.6;
// A removed phrase that was the object of a preposition ("loved by [influencers]") or a noun between
// a modifier and a preposition ("Real [testimonials] from customers") leaves the clause without its
// argument; the sentence is dropped whole.
const PREPOSITIONS = new Set(['at', 'by', 'for', 'from', 'in', 'of', 'on', 'to', 'with']);
const DETERMINERS = new Set(['a', 'an', 'the', 'our', 'your', 'their', 'its', 'this', 'that', 'these', 'those', 'my']);

function orphansClause(text, start, end) {
  const before = (text.slice(0, start).trim().match(/[\p{L}\p{N}']+$/u) || [''])[0].toLowerCase();
  const after = (text.slice(end).trim().match(/^[\p{L}\p{N}']+/u) || [''])[0].toLowerCase();
  if (PREPOSITIONS.has(before)) return true;
  return Boolean(before) && !DETERMINERS.has(before) && PREPOSITIONS.has(after);
}

function danglingAfterStrip(text) {
  const words = normalizeText(text).toLowerCase().match(/[\p{L}\p{N}']+|[,;:]/gu) || [];
  if (!words.length) return true;
  if (DANGLING_LEAD_WORDS.has(words[0])) return true;
  if (DANGLING_TAIL_WORDS.has(words[words.length - 1])) return true;
  for (let i = 0; i + 1 < words.length; i += 1) {
    if (/^[,;:]$/.test(words[i + 1]) && DANGLING_TAIL_WORDS.has(words[i])) return true;
  }
  return false;
}

// Sentence ends: ". ! ?" followed by whitespace ("No." as in "No. 1" is an abbreviation, not an
// end), Japanese 。！？ with or without a following space, line breaks, bullets.
const SENTENCE_SPLIT = /(?<=[.!?])(?<!\b[Nn]o\.)\s+|(?<=[。！？])\s*|\r?\n+|\s+[•·|]\s+/;
const CONTENT_WORD = /[\p{L}\p{N}]+/gu;

function normalizeText(value) {
  return String(value == null ? '' : value);
}

function hasSocialProofClaim(text) {
  return SOCIAL_CLAIM_PATTERN.test(normalizeText(text));
}

function hasSupportingSocialSource(sourceRefs) {
  const text = (Array.isArray(sourceRefs) ? sourceRefs : [])
    .map((ref) => {
      if (typeof ref === 'string') return ref;
      if (!ref || typeof ref !== 'object') return '';
      return [ref.type, ref.source_type, ref.source, ref.name, ref.label, ref.title, ref.url, ref.href]
        .map((item) => normalizeText(item).trim())
        .filter(Boolean)
        .join(' ');
    })
    .filter(Boolean)
    .join(' ');
  return SOCIAL_SOURCE_SUPPORT_PATTERN.test(text);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// An ordinal names a product line, not a rank, when the snapshot brand or a mid-sentence capitalised
// name precedes it ("Chanel No. 1 de Chanel", "Nars #1"). "Our #1 serum", "the No. 1 brand" strip.
function ordinalNamesProduct(sentence, index, brand) {
  const before = sentence.slice(0, index).replace(/\s+$/, '');
  if (!before) return false;
  const brandText = normalizeText(brand).trim();
  if (brandText && new RegExp(`${escapeRegExp(brandText)}\\s*$`, 'i').test(before)) return true;
  const words = before.split(/\s+/);
  const previous = words[words.length - 1];
  return /^[A-Z][\w'&.-]*$/.test(previous) && !/^(?:The|Our|A|An|This|That|Its|Their|Your|My|We|It|Japan's|Australia's|America's|Korea's)$/.test(previous);
}

function stripPhrasesFromSentence(sentence, { brand } = {}) {
  let out = sentence;
  let touched = false;
  let orphaned = false;
  for (const pattern of [SOCIAL_CLAIM_PATTERN, POPULARITY_CLAIM_PATTERN]) {
    const global = new RegExp(pattern.source, 'gi');
    const source = out;
    out = source.replace(global, (match, offset) => {
      touched = true;
      if (orphansClause(source, offset, offset + match.length)) orphaned = true;
      return ' ';
    });
  }
  const ordinal = new RegExp(ORDINAL_CLAIM_PATTERN.source, 'gi');
  const ordinalSource = out;
  out = ordinalSource.replace(ordinal, (match, offset) => {
    const leading = /^[\s(]/.test(match) ? match[0] : '';
    if (ordinalNamesProduct(ordinalSource, offset + leading.length, brand)) return match;
    touched = true;
    if (orphansClause(ordinalSource, offset + leading.length, offset + match.length)) orphaned = true;
    return leading;
  });
  if (!touched) return { text: sentence, touched: false, orphaned: false };
  const cleaned = out
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+([,;:.!?。！？])/g, '$1')
    .replace(/([,;:])\s*(?=[,;:.!?])/g, '')
    .replace(/^[\s,;:]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { text: cleaned, touched: true, orphaned };
}

function contentWordCount(text) {
  return (normalizeText(text).match(CONTENT_WORD) || []).length;
}

// Cut social-proof phrases out of `text`. A sentence that keeps fewer than three content words, fewer
// than 60% of the words it had, or is left opening / closing on a function word ("Loved by, this
// serum", "A loved by everywhere") is dropped whole. Returns '' when nothing supportable is left.
function stripSocialProofPhrases(text, options = {}) {
  const raw = normalizeText(text).trim();
  if (!raw) return raw;
  if (!SOCIAL_CLAIM_PATTERN.test(raw) && !POPULARITY_CLAIM_PATTERN.test(raw) && !ORDINAL_CLAIM_PATTERN.test(raw)) return raw;
  const kept = [];
  for (const part of raw.split(SENTENCE_SPLIT)) {
    const sentence = normalizeText(part).trim();
    if (!sentence) continue;
    const { text: stripped, touched, orphaned } = stripPhrasesFromSentence(sentence, options);
    if (!touched) {
      kept.push(sentence);
      continue;
    }
    const before = contentWordCount(sentence);
    const after = contentWordCount(stripped);
    if (orphaned || after < 3 || after < before * MIN_KEPT_WORD_SHARE || danglingAfterStrip(stripped)) continue;
    kept.push(stripped);
  }
  return kept.join(' ').trim();
}

// Kept for callers that want sentence semantics; the builder uses stripSocialProofPhrases.
const stripSocialProofSentences = stripSocialProofPhrases;

function neutralizeClaimValue(value, options = {}, depth = 0) {
  if (value == null || depth > 8) return value;
  if (typeof value === 'string') {
    const stripped = stripSocialProofPhrases(value, options);
    return stripped ? stripped : undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => neutralizeClaimValue(item, options, depth + 1)).filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const next = neutralizeClaimValue(child, options, depth + 1);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  return value;
}

// Returns a copy of `snapshot` with the listed claim fields stripped of social-proof phrases. A field
// left with no supportable text is removed rather than stored empty. The snapshot's own brand exempts
// ordinals that name its product line.
function neutralizeSnapshotClaims(snapshot, fields, options = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  const brand = options.brand != null ? options.brand : (snapshot.brand || snapshot.brand_name || snapshot.vendor || '');
  let out = snapshot;
  for (const field of fields) {
    if (snapshot[field] == null) continue;
    const next = neutralizeClaimValue(snapshot[field], { brand });
    if (next === snapshot[field]) continue;
    if (out === snapshot) out = { ...snapshot };
    if (next === undefined) delete out[field];
    else out[field] = next;
  }
  return out;
}

module.exports = {
  SOCIAL_CLAIM_SOURCE,
  SOCIAL_CLAIM_PATTERN,
  POPULARITY_CLAIM_PATTERN,
  ORDINAL_CLAIM_PATTERN,
  SOCIAL_SOURCE_SUPPORT_PATTERN,
  CANDIDATE_CLAIM_FIELDS,
  ANCHOR_CLAIM_FIELDS,
  hasSocialProofClaim,
  hasSupportingSocialSource,
  stripSocialProofPhrases,
  stripSocialProofSentences,
  neutralizeClaimValue,
  neutralizeSnapshotClaims,
};
