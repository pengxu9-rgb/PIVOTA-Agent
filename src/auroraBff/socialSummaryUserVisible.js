function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function norm01(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n >= 0 && n <= 1) return clamp01(n);
  if (n >= -1 && n < 0) return clamp01((n + 1) / 2);
  if (n > 1 && n <= 100) return clamp01(n / 100);
  return clamp01(n);
}

function uniq(items, max = 20) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

const CHANNEL_CANONICAL = new Set(['reddit', 'xiaohongshu', 'tiktok', 'youtube', 'instagram']);

function normalizeSocialChannel(raw) {
  const token = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!token) return null;
  if (token.includes('reddit')) return 'reddit';
  if (token === 'red' || token === 'xhs' || token.includes('xiaohongshu') || token.includes('小红书')) return 'xiaohongshu';
  if (token === 'yt' || token.includes('youtube') || token.includes('you tube')) return 'youtube';
  if (token.includes('tiktok') || token.includes('tik tok') || token.includes('抖音')) return 'tiktok';
  if (token === 'ig' || token.includes('instagram') || token.includes('insta')) return 'instagram';
  if (CHANNEL_CANONICAL.has(token)) return token;
  return null;
}

function extractWhitelistedSocialChannels(input) {
  const src = isPlainObject(input) ? input : {};
  const candidates = [];
  const channels = Array.isArray(src.channels) ? src.channels : [];
  const platforms = Array.isArray(src.platforms) ? src.platforms : [];
  const scoreObj = isPlainObject(src.platform_scores) ? src.platform_scores : {};

  for (const channel of channels) candidates.push(channel);
  for (const platform of platforms) {
    if (isPlainObject(platform)) {
      candidates.push(platform.name, platform.channel, platform.platform);
      continue;
    }
    candidates.push(platform);
  }
  for (const key of Object.keys(scoreObj)) candidates.push(key);

  return uniq(
    candidates
      .map((item) => normalizeSocialChannel(item))
      .filter(Boolean),
    5,
  );
}

const MARKETING_HYPE_PATTERNS = [
  /完美平替/i,
  /100%\s*(相同|一样|identical|same)/i,
  /miracle\s+dupe/i,
  /绝对吊打/i,
  /无敌平替/i,
];

function shouldDropKeyword(text) {
  const token = String(text == null ? '' : text).trim();
  if (!token) return true;
  if (token.length < 2 || token.length > 40) return true;
  if (/https?:\/\//i.test(token)) return true;
  if (/[@]/.test(token)) return true;
  if (/^[#]+$/.test(token)) return true;
  if (/^(?:route_|dedupe_|internal_|fallback_|ref_)/i.test(token)) return true;
  if (/^[0-9\-_:/.]+$/.test(token)) return true;
  if (MARKETING_HYPE_PATTERNS.some((re) => re.test(token))) return true;
  return false;
}

function splitKeywords(values) {
  const out = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) continue;
    const segments = text
      .split(/[|,/;]+/g)
      .map((x) => x.trim())
      .filter(Boolean);
    for (const seg of segments.length ? segments : [text]) out.push(seg.replace(/^#/, '').trim());
  }
  return out;
}

function collectKeywords(raw) {
  const obj = isPlainObject(raw) ? raw : {};
  const topTopics = Array.isArray(obj.top_topics) ? obj.top_topics : [];
  const topicStrings = topTopics.map((item) => (isPlainObject(item) ? item.topic || item.name : item));
  const merged = [
    ...(Array.isArray(obj.topic_keywords) ? obj.topic_keywords : []),
    ...(Array.isArray(obj.top_keywords) ? obj.top_keywords : []),
    ...(Array.isArray(obj.keywords) ? obj.keywords : []),
    ...topicStrings,
  ];
  const split = splitKeywords(merged);
  return uniq(split.filter((k) => !shouldDropKeyword(k)), 12);
}

function countThemeHits(keywords, patterns) {
  let count = 0;
  for (const keyword of keywords) {
    const lower = keyword.toLowerCase();
    if (patterns.some((re) => re.test(lower))) count += 1;
  }
  return count;
}

const THEME_RULES = [
  {
    key: 'barrier_repair',
    patterns: [/(barrier|ceramide|cica|panthenol|repair|修护|修復|屏障|泛红|舒缓)/i],
    labels: { CN: '屏障修护', EN: 'Barrier repair' },
  },
  {
    key: 'sensitive_redness',
    patterns: [/(sensitive|reactive|redness|sting|敏感|泛红|刺痛|耐受)/i],
    labels: { CN: '敏感泛红', EN: 'Sensitive redness' },
  },
  {
    key: 'oil_acne',
    patterns: [/(oily|sebum|acne|blemish|breakout|控油|痘|闭口|粉刺)/i],
    labels: { CN: '控油痘痘', EN: 'Oil & acne control' },
  },
  {
    key: 'brightening',
    patterns: [/(bright|tone|vitamin c|niacinamide|dark spot|提亮|美白|肤色|痘印)/i],
    labels: { CN: '美白提亮', EN: 'Brightening' },
  },
  {
    key: 'hydration',
    patterns: [/(hydration|moistur|plump|hyaluronic|保湿|补水|滋润)/i],
    labels: { CN: '保湿补水', EN: 'Hydration' },
  },
  {
    key: 'light_texture',
    patterns: [/(lightweight|non-greasy|quick absorb|清爽|不黏|轻薄|肤感)/i],
    labels: { CN: '清爽肤感', EN: 'Light texture' },
  },
  {
    key: 'fragrance_free',
    patterns: [/(fragrance[-\s]?free|no fragrance|unscented|无香精|香精)/i],
    labels: { CN: '无香精', EN: 'Fragrance profile' },
  },
];

function inferThemes(keywords, lang = 'EN') {
  const locale = String(lang || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
  const scored = [];
  for (const rule of THEME_RULES) {
    const hits = countThemeHits(keywords, rule.patterns);
    if (!hits) continue;
    scored.push({
      key: rule.key,
      hits,
      label: rule.labels[locale] || rule.labels.EN,
    });
  }
  scored.sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits;
    return a.key.localeCompare(b.key);
  });
  return scored.map((x) => x.label).slice(0, 3);
}

function buildSentimentHint(raw, lang = 'EN') {
  const obj = isPlainObject(raw) ? raw : {};
  const locale = String(lang || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
  const sentiment = norm01(obj.sentiment_proxy ?? obj.sentiment ?? obj.sentiment_score ?? obj.sentimentScore);
  if (sentiment == null) return undefined;
  if (locale === 'CN') {
    if (sentiment >= 0.68) return '社媒讨论整体偏正向。';
    if (sentiment <= 0.35) return '社媒讨论偏谨慎，需关注耐受风险。';
    return '社媒讨论正负并存。';
  }
  if (sentiment >= 0.68) return 'Overall social discussion is mostly positive.';
  if (sentiment <= 0.35) return 'Social discussion is cautious; monitor tolerance-related feedback.';
  return 'Social discussion is mixed.';
}

function buildVolumeBucket(raw, channelCount) {
  const obj = isPlainObject(raw) ? raw : {};
  const strength = norm01(obj.co_mention_strength ?? obj.coMentionStrength ?? obj.context_match ?? obj.contextMatch);
  if (strength == null) return channelCount ? 'unknown' : 'unknown';
  if (strength >= 0.7) return 'high';
  if (strength >= 0.4) return 'mid';
  if (strength > 0) return 'low';
  return 'unknown';
}

function isLowSignal({ channels, keywords, volumeBucket, sentimentHint }) {
  const channelCount = channels.length;
  const keywordCount = keywords.length;
  if (!channelCount) return true;
  if (channelCount === 1 && keywordCount < 2 && (volumeBucket === 'low' || volumeBucket === 'unknown')) return true;
  if (keywordCount === 0 && !sentimentHint && (volumeBucket === 'low' || volumeBucket === 'unknown')) return true;
  return false;
}

function buildSocialSummaryUserVisible(socialRaw, { lang = 'EN' } = {}) {
  const raw = isPlainObject(socialRaw) ? socialRaw : null;
  if (!raw) return undefined;

  const channels = extractWhitelistedSocialChannels(raw);
  const keywords = collectKeywords(raw);
  const themes = inferThemes(keywords, lang);
  const sentimentHint = buildSentimentHint(raw, lang);
  const volumeBucket = buildVolumeBucket(raw, channels.length);

  if (isLowSignal({ channels, keywords, volumeBucket, sentimentHint })) return undefined;

  if (!themes.length && keywords.length < 2) return undefined;

  const out = {
    themes: themes.slice(0, 3),
    volume_bucket: volumeBucket,
  };
  const topKeywords = keywords.slice(0, 6);
  if (topKeywords.length) out.top_keywords = topKeywords;
  if (sentimentHint) out.sentiment_hint = sentimentHint;
  return out;
}

module.exports = {
  SOCIAL_CHANNEL_WHITELIST: Array.from(CHANNEL_CANONICAL),
  normalizeSocialChannel,
  extractWhitelistedSocialChannels,
  buildSocialSummaryUserVisible,
};
