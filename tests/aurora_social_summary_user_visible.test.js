const {
  SOCIAL_CHANNEL_WHITELIST,
  extractWhitelistedSocialChannels,
  buildSocialSummaryUserVisible,
} = require('../src/auroraBff/socialSummaryUserVisible');

describe('socialSummaryUserVisible', () => {
  test('extracts only whitelisted social channels with alias mapping', () => {
    const channels = extractWhitelistedSocialChannels({
      channels: ['Reddit', 'XHS', 'blog', 'YT', 'IG'],
      platform_scores: { TikTok: 0.8, Retailer: 0.6 },
    });
    expect(channels).toEqual(expect.arrayContaining(['reddit', 'xiaohongshu', 'youtube', 'instagram', 'tiktok']));
    expect(channels.every((c) => SOCIAL_CHANNEL_WHITELIST.includes(c))).toBe(true);
  });

  test('builds user-visible summary with bounded themes/keywords and filtered hype terms', () => {
    const summary = buildSocialSummaryUserVisible({
      channels: ['reddit', 'xhs', 'tiktok'],
      co_mention_strength: 0.78,
      sentiment_proxy: 0.73,
      topic_keywords: [
        'barrier repair',
        'soothing',
        'oily skin',
        '完美平替',
        'https://spam.example/post',
        '@user123',
        'hydration',
        'niacinamide',
      ],
    }, { lang: 'EN' });

    expect(summary).toBeTruthy();
    expect(summary.themes.length).toBeLessThanOrEqual(3);
    expect(Array.isArray(summary.top_keywords)).toBe(true);
    expect(summary.top_keywords.length).toBeLessThanOrEqual(6);
    expect(summary.volume_bucket).toBe('high');
    const serialized = JSON.stringify(summary).toLowerCase();
    expect(serialized).not.toMatch(/完美平替|https?:\/\/|@user|miracle dupe/);
  });

  test('returns undefined for non-social channels only', () => {
    const summary = buildSocialSummaryUserVisible({
      channels: ['brand_site', 'retailer_product_page', 'catalog'],
      co_mention_strength: 0.92,
      topic_keywords: ['hydration', 'lightweight'],
    }, { lang: 'EN' });
    expect(summary).toBeUndefined();
  });

  test('returns undefined for low-signal single-channel input', () => {
    const summary = buildSocialSummaryUserVisible({
      channels: ['reddit'],
      co_mention_strength: 0.12,
      topic_keywords: ['ok'],
    }, { lang: 'CN' });
    expect(summary).toBeUndefined();
  });

  test('never outputs internal counts or user identifiers', () => {
    const summary = buildSocialSummaryUserVisible({
      channels: ['reddit', 'xhs'],
      co_mention_strength: 0.64,
      sentiment_proxy: 0.62,
      topic_keywords: ['barrier', '敏感肌'],
      mention_count: 99999,
      sample_size: 2048,
      user: '@hidden',
    }, { lang: 'EN' });

    expect(summary).toBeTruthy();
    expect(summary.mention_count).toBeUndefined();
    expect(summary.sample_size).toBeUndefined();
    expect(summary.user).toBeUndefined();
    expect(Object.keys(summary).sort()).toEqual(
      expect.arrayContaining(['themes', 'volume_bucket']),
    );
  });
});
