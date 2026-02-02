const axios = require('axios');

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/$/, '');
}

const USE_AURORA_MOCK = String(process.env.AURORA_BFF_USE_MOCK || '').toLowerCase() === 'true';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postWithRetry(url, body, { timeoutMs, retries, retryDelayMs } = {}) {
  const maxRetries = Number.isFinite(retries) ? retries : 1;
  const delayMs = Number.isFinite(retryDelayMs) ? retryDelayMs : 200;

  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const resp = await axios.post(url, body, {
        timeout: Number(timeoutMs) > 0 ? Number(timeoutMs) : 12000,
        validateStatus: () => true,
      });
      if (resp.status >= 200 && resp.status < 300) return resp;
      // Retry only on 5xx.
      if (resp.status >= 500 && attempt < maxRetries) {
        await sleep(delayMs * (attempt + 1));
        continue;
      }
      const err = new Error(`Upstream status ${resp.status}`);
      err.status = resp.status;
      err.responseBody = resp.data;
      throw err;
    } catch (err) {
      lastErr = err;
      const status = err && err.status;
      const shouldRetry = (status == null || status >= 500) && attempt < maxRetries;
      if (shouldRetry) {
        await sleep(delayMs * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('Upstream request failed');
}

function buildContextPrefix({ profile, recentLogs }) {
  const lines = [];
  if (profile) lines.push(`profile=${JSON.stringify(profile)}`);
  if (Array.isArray(recentLogs) && recentLogs.length) lines.push(`recent_logs=${JSON.stringify(recentLogs)}`);
  return lines.length ? `${lines.join('\n')}\n\n` : '';
}

function mockAuroraChat(query) {
  const q = String(query || '');

  if (/Task:\s*Parse\b/i.test(q)) {
    return {
      answer: JSON.stringify({
        product: {
          sku_id: 'mock_sku_1',
          name: 'Mock Parsed Product',
          brand: 'MockBrand',
          category: 'treatment',
        },
        confidence: 0.7,
        missing_info: [],
      }),
      intent: 'parse',
      cards: [],
    };
  }

  if (/Task:\s*Deep-scan\b/i.test(q)) {
    return {
      answer: JSON.stringify({
        assessment: { suitability: 'moderate', summary: 'Mock assessment.' },
        evidence: {
          science: {
            key_ingredients: ['niacinamide'],
            mechanisms: ['barrier support'],
            fit_notes: ['May help with oil control.'],
            risk_notes: ['Start slowly if sensitive.'],
          },
          social_signals: {
            platform_scores: { reddit: 0.7 },
            typical_positive: ['Helped with redness.'],
            typical_negative: ['Some stinging reported.'],
            risk_for_groups: ['Very sensitive skin'],
          },
          expert_notes: ['Patch test recommended.'],
          confidence: 0.6,
          missing_info: [],
        },
        confidence: 0.6,
        missing_info: [],
      }),
      intent: 'analyze',
      cards: [],
    };
  }

  if (/Task:\s*Compare\b/i.test(q)) {
    return {
      answer: JSON.stringify({
        tradeoffs: ['Mock tradeoff: texture difference', 'Mock tradeoff: fragrance risk'],
        evidence: {
          science: { key_ingredients: [], mechanisms: [], fit_notes: [], risk_notes: [] },
          social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
          expert_notes: [],
          confidence: 0.5,
          missing_info: [],
        },
        confidence: 0.5,
        missing_info: [],
      }),
      intent: 'dupe',
      cards: [],
    };
  }

  if (/STRUCTURED_COMMERCE_TEST/i.test(q)) {
    return {
      answer: JSON.stringify({
        recommendations: [
          {
            sku_id: 'mock_reco_sku_1',
            name: 'Mock Reco Product',
            offers: [{ purchase_route: 'affiliate_outbound', affiliate_url: 'https://example.com/mock_reco_sku_1' }],
          },
        ],
        confidence: 0.51,
      }),
      intent: 'chat',
      cards: [],
    };
  }

  if (/Task:\s*Generate skincare recommendations\b/i.test(q)) {
    return {
      answer: JSON.stringify({
        recommendations: [
          {
            sku_id: 'mock_cleanser_1',
            name: 'Mock Gentle Cleanser',
            brand: 'MockBrand',
            category: 'cleanser',
            offers: [
              {
                offer_id: 'mock_offer_1',
                purchase_route: 'affiliate_outbound',
                affiliate_url: 'https://example.com/mock_cleanser_1',
              },
            ],
          },
        ],
        evidence: {
          science: { key_ingredients: [], mechanisms: [], fit_notes: [], risk_notes: [] },
          social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
          expert_notes: [],
          confidence: 0.4,
          missing_info: ['real_offers_not_resolved'],
        },
        confidence: 0.4,
        missing_info: ['real_offers_not_resolved'],
      }),
      intent: 'reco',
      cards: [{ type: 'recommendations', payload: { recommendations: [{ sku_id: 'mock_cleanser_1' }] } }],
    };
  }

  return {
    answer: 'Mock Aurora reply.',
    intent: 'chat',
    // Always include a reco-like card so the BFF recommendation gate can be tested offline.
    cards: [{ type: 'recommendations', payload: { recommendations: [{ sku_id: 'mock_sku_generic' }] } }],
  };
}

async function auroraChat({ baseUrl, query, timeoutMs } = {}) {
  if (USE_AURORA_MOCK) return mockAuroraChat(query);
  const base = normalizeBaseUrl(baseUrl);
  if (!base) {
    const err = new Error('AURORA_DECISION_BASE_URL not configured');
    err.code = 'AURORA_NOT_CONFIGURED';
    throw err;
  }
  const url = `${base}/api/chat`;
  const resp = await postWithRetry(url, { query }, { timeoutMs, retries: 1, retryDelayMs: 250 });
  const data = resp && resp.data;
  return data && typeof data === 'object' ? data : { raw: data };
}

module.exports = {
  normalizeBaseUrl,
  buildContextPrefix,
  auroraChat,
};
