const axios = require('axios');

const {
  buildSocialSourceConfig,
  fetchCrossPlatformSocialSignals,
} = require('../src/auroraBff/socialSourceAdapter');

describe('aurora social source adapter', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(axios, 'post');
    axios.post.mockReset();
    process.env.AURORA_BFF_SOCIAL_SOURCE_ENABLED = 'true';
    process.env.AURORA_BFF_SOCIAL_SOURCE_BASE_URL = 'https://social.example.com';
    process.env.AURORA_BFF_SOCIAL_SOURCE_API_KEY = 'test_key';
    process.env.AURORA_BFF_SOCIAL_SOURCE_TIMEOUT_MS = '900';
    process.env.AURORA_BFF_SOCIAL_SOURCE_CHANNELS = 'reddit,xhs,tiktok,youtube,instagram,on_page_related';
  });

  afterAll(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envBackup)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(envBackup)) {
      process.env[key] = value;
    }
  });

  test('buildSocialSourceConfig normalizes channels and timeout', () => {
    const cfg = buildSocialSourceConfig(process.env);
    expect(cfg.enabled).toBe(true);
    expect(cfg.base_url).toBe('https://social.example.com');
    expect(cfg.timeout_ms).toBe(900);
    expect(cfg.channels).toEqual(['reddit', 'xiaohongshu', 'tiktok', 'youtube', 'instagram']);
  });

  test('fetchCrossPlatformSocialSignals maps whitelisted channels only', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        source_version: 'social_v1',
        signals: [
          {
            candidate_key: 'cand_1',
            channels: ['reddit', 'xhs', 'retailer_product_page'],
            topic_keywords: ['barrier repair', 'hydration'],
            co_mention_strength: 0.78,
            sentiment_proxy: 0.67,
          },
        ],
      },
    });

    const out = await fetchCrossPlatformSocialSignals({
      anchor: { brand_id: 'anchor_brand', category_taxonomy: ['serum'] },
      candidates: [
        {
          product_id: 'cand_1',
          name: 'Candidate 1',
          source: { type: 'catalog_search' },
        },
      ],
      lang: 'EN',
    });

    expect(out.ok).toBe(true);
    expect(out.source_version).toBe('social_v1');
    expect(Object.keys(out.signals_by_key)).toContain('cand_1');
    expect(out.signals_by_key.cand_1.channels).toEqual(['reddit', 'xiaohongshu']);
    expect(out.channels_used).toEqual(['reddit', 'xiaohongshu']);
  });

  test('fetchCrossPlatformSocialSignals soft-fails on timeout', async () => {
    const timeoutErr = new Error('timeout');
    timeoutErr.code = 'ECONNABORTED';
    axios.post.mockRejectedValue(timeoutErr);

    const out = await fetchCrossPlatformSocialSignals({
      anchor: { brand_id: 'anchor_brand', category_taxonomy: ['serum'] },
      candidates: [
        {
          product_id: 'cand_2',
          name: 'Candidate 2',
          source: { type: 'catalog_search' },
        },
      ],
      lang: 'EN',
    });

    expect(out.ok).toBe(false);
    expect(out.reason).toBe('timeout');
    expect(out.signals_by_key).toEqual({});
  });
});
