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

function buildContextPrefix({ profile, recentLogs, ...meta } = {}) {
  const lines = [];
  if (profile) lines.push(`profile=${JSON.stringify(profile)}`);
  if (Array.isArray(recentLogs) && recentLogs.length) lines.push(`recent_logs=${JSON.stringify(recentLogs)}`);
  const metaCompact = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (v == null) continue;
    const s = typeof v === 'string' ? v.trim() : v;
    if (typeof s === 'string' && !s) continue;
    metaCompact[k] = s;
  }
  if (Object.keys(metaCompact).length) lines.push(`meta=${JSON.stringify(metaCompact)}`);
  return lines.length ? `${lines.join('\n')}\n\n` : '';
}

function normalizeMockInput(input) {
  if (typeof input === 'string') return { query: input, anchor_product_id: null, messages: [] };
  if (!input || typeof input !== 'object') return { query: '', anchor_product_id: null, messages: [] };
  const obj = input;
  return {
    query: String(obj.query || ''),
    anchor_product_id: typeof obj.anchor_product_id === 'string' ? obj.anchor_product_id : null,
    messages: Array.isArray(obj.messages) ? obj.messages : [],
  };
}

function mockAuroraChat(input) {
  const norm = normalizeMockInput(input);
  const q = String(norm.query || '');
  const anchorId = String(norm.anchor_product_id || '').trim();

  if (/ACTION_REPLY_TEXT_TEST/.test(q)) {
    return {
      answer: 'Mock: action reply_text received.',
      intent: 'chat',
      cards: [],
    };
  }

  if (/OVERLONG_TEMPLATE_CONTEXT_TEST/i.test(q)) {
    const longAnswer = [
      'Part 1: Diagnosis 🩺',
      '- This is a long templated answer that should be collapsed when structured cards are present.',
      '',
      'Part 2: The Routine 📅',
      'AM (Protection):',
      '- Cleanser - Mock Gentle Cleanser kb:mock_reco_1',
      '- Moisturizer - Mock Barrier Cream kb:mock_reco_2',
      'PM (Treatment):',
      '- Treatment - Mock Gentle Treatment kb:mock_reco_3',
      '',
      'Part 3: Budget Analysis 💰',
      '- Price unknown for some items.',
      '',
      'Part 4: Safety Warning ⚠️',
      '- Start 2-3x/week and wear SPF.',
      '',
      'Citations:',
      'kb:mock_reco_1',
      'kb:mock_reco_2',
      'kb:mock_reco_3',
      '',
      'Notes:',
      '- (filler) '.repeat(80),
    ].join('\n');

    return {
      answer: longAnswer,
      intent: 'science',
      cards: [],
      structured: {
        schema_version: 'aurora.structured.v1',
        parse: { normalized_query: 'OVERLONG_TEMPLATE_CONTEXT_TEST', parse_confidence: 1, normalized_query_language: 'zh-CN' },
      },
      context: {
        external_verification: {
          query: 'niacinamide clinical evidence',
          citations: [
            {
              title: 'Niacinamide - mechanisms of action and its topical use in dermatology.',
              source: 'Skin pharmacology and physiology',
              year: 2014,
              url: 'https://pubmed.ncbi.nlm.nih.gov/24993939/',
              note: 'PMID:24993939',
            },
          ],
          note: 'Mock citations list.',
        },
        env_stress: {
          schema_version: 'aurora.env_stress.v1',
          ess: 53,
          tier: 'Medium',
          contributors: [
            { key: 'barrier', weight: 0.4, note: 'barrier_status=healthy' },
            { key: 'weather', weight: 0.7, note: 'scenario=snow' },
            { key: 'uv', weight: 0.65, note: 'uv=high' },
          ],
          missing_inputs: ['profile.sensitivity', 'recent_logs'],
          generated_at: new Date().toISOString(),
        },
      },
    };
  }

  if (/CONTEXT_CARDS_TEST/i.test(q)) {
    const hasAnchor = Boolean(anchorId);
    return {
      answer: 'Mock: context cards test.',
      intent: 'science',
      cards: [],
      structured: {
        schema_version: 'aurora.structured.v1',
        parse: { normalized_query: 'CONTEXT_CARDS_TEST', parse_confidence: 1, normalized_query_language: 'en-US' },
      },
      context: {
        external_verification: {
          query: 'niacinamide clinical evidence',
          citations: [
            {
              title: 'Niacinamide - mechanisms of action and its topical use in dermatology.',
              source: 'Skin pharmacology and physiology',
              year: 2014,
              url: 'https://pubmed.ncbi.nlm.nih.gov/24993939/',
              note: 'PMID:24993939',
            },
            {
              title: 'Niacinamide: A B vitamin that improves aging facial skin appearance.',
              source: 'Dermatologic surgery : official publication for American Society for Dermatologic Surgery [et al.]',
              year: 2005,
              url: 'https://pubmed.ncbi.nlm.nih.gov/16029679/',
              note: 'PMID:16029679',
            },
          ],
          note: 'Mock citations list.',
        },
        env_stress: {
          schema_version: 'aurora.env_stress.v1',
          ess: 88,
          tier: 'High',
          contributors: [
            { key: 'barrier', weight: 0.5, note: 'barrier_status=impaired' },
            { key: 'sensitivity', weight: 0.5, note: 'sensitivity=high' },
          ],
          missing_inputs: [],
          generated_at: '2026-02-04T06:00:00.000Z',
        },
        ...(hasAnchor
          ? {
            conflict_detector: {
              schema_version: 'aurora.conflicts.v1',
              safe: false,
              conflicts: [
                {
                  severity: 'warn',
                  rule_id: 'retinoid_x_acids',
                  message: '维A类 + 去角质酸（AHA/BHA/PHA）叠加更容易刺痛/爆皮；更安全的做法是错开晚用，并从低频开始逐步加量。',
                },
              ],
              summary: '需要注意：共 1 条提示（0 条为阻断级）。',
            },
          }
          : {}),
      },
    };
  }

  if (/Task:\s*Parse\b/i.test(q)) {
    const inputMatch = q.match(/Input:\s*(.+)\s*$/im);
    const input = inputMatch ? String(inputMatch[1]).trim() : 'Mock Parsed Product';
    const lower = input.toLowerCase();
    const skuId = lower.includes('dupe') || lower.includes('competitor') || lower.includes('mock_dupe')
      ? 'mock_dupe_1'
      : 'mock_sku_1';
    const brand = skuId === 'mock_dupe_1' ? 'MockDupeBrand' : 'MockBrand';
    const name = skuId === 'mock_dupe_1' ? 'Mock Dupe Product' : 'Mock Parsed Product';
    const anchorProduct = {
      product_id: skuId,
      sku_id: skuId,
      brand,
      name,
      category: skuId === 'mock_dupe_1' ? 'treatment' : 'treatment',
      display_name: `${brand} ${name}`,
      availability: ['Global'],
      price: { usd: null, cny: null, unknown: true },
    };

    const altProduct = {
      product_id: 'mock_dupe_1',
      sku_id: 'mock_dupe_1',
      brand: 'MockDupeBrand',
      name: 'Mock Dupe Product',
      category: 'treatment',
      display_name: 'MockDupeBrand Mock Dupe Product',
      availability: ['Global'],
      price: { usd: null, cny: null, unknown: true },
    };

    return {
      answer: JSON.stringify({
        product: anchorProduct,
        confidence: 0.7,
        missing_info: [],
      }),
      intent: 'product',
      cards: [],
      structured: {
        schema_version: 'aurora.structured.v1',
        parse: {
          normalized_query: input,
          parse_confidence: 0.7,
          normalized_query_language: 'en-US',
          anchor_product: anchorProduct,
        },
        analyze: {
          verdict: 'Suitable',
          confidence: 0.6,
          reasons: ['Mock: broadly compatible with most routines.'],
          science_evidence: [
            {
              key: 'niacinamide',
              in_product: true,
              mechanism: 'Barrier support; oil control.',
              targets: ['Oil control'],
              risks: ['Some tingling possible.'],
              evidence: [{ kind: 'kb', citations: ['kb:mock_parse_1'] }],
            },
          ],
          social_signals: {
            red_score: 65,
            reddit_score: 80,
            burn_rate: 0.12,
            top_keywords: ['gentle', 'oil control'],
          },
          expert_notes: { chemist_notes: 'Mock notes', citations: ['kb:mock_parse_1', 'kb:mock_parse_2'] },
          how_to_use: null,
        },
        alternatives: skuId === 'mock_dupe_1'
          ? []
          : [
            {
              product: altProduct,
              similarity_score: 82,
              tradeoffs: {
                missing_actives: ['niacinamide'],
                added_benefits: ['peptides'],
                texture_finish_differences: ['Mock: dupe has a lighter texture.'],
                price_delta_usd: null,
                availability_note: null,
              },
              evidence: { kb_citations: ['kb:mock_alt_1'] },
            },
          ],
        kb_requirements_check: { missing_fields: [], notes: [] },
      },
    };
  }

  if (/Task:\s*Deep-scan\b/i.test(q)) {
    const isDupe = anchorId === 'mock_dupe_1' || /\bmock_dupe\b/i.test(q);
    const anchorProduct = isDupe
      ? {
        product_id: 'mock_dupe_1',
        sku_id: 'mock_dupe_1',
        brand: 'MockDupeBrand',
        name: 'Mock Dupe Product',
        category: 'treatment',
        display_name: 'MockDupeBrand Mock Dupe Product',
        availability: ['Global'],
        price: { usd: null, cny: null, unknown: true },
      }
      : {
        product_id: 'mock_sku_1',
        sku_id: 'mock_sku_1',
        brand: 'MockBrand',
        name: 'Mock Parsed Product',
        category: 'treatment',
        display_name: 'MockBrand Mock Parsed Product',
        availability: ['Global'],
        price: { usd: null, cny: null, unknown: true },
      };
    return {
      answer: 'Mock deep-scan completed.',
      intent: 'product',
      cards: [],
      structured: {
        schema_version: 'aurora.structured.v1',
        parse: {
          normalized_query: 'Mock Parsed Product',
          parse_confidence: 0.8,
          normalized_query_language: 'en-US',
          anchor_product: anchorProduct,
        },
        analyze: {
          verdict: 'Suitable',
          confidence: 0.62,
          reasons: [isDupe ? 'Mock: hydrating-focused option.' : 'Mock: fits typical oily skin routines.'],
          science_evidence: [
            {
              key: isDupe ? 'hyaluronic acid' : 'niacinamide',
              in_product: true,
              mechanism: isDupe ? 'Humectant hydration support.' : 'Barrier support; oil control.',
              targets: [isDupe ? 'Hydration' : 'Oil control'],
              risks: [isDupe ? 'Low irritation risk.' : 'Start slowly if sensitive.'],
              evidence: [{ kind: 'kb', citations: [isDupe ? 'kb:mock_scan_dupe_1' : 'kb:mock_scan_1'] }],
            },
          ],
          social_signals: {
            red_score: 70,
            reddit_score: 75,
            burn_rate: 0.1,
            top_keywords: ['soothing'],
          },
          expert_notes: { sensitivity_flags: 'Patch test recommended.', citations: ['kb:mock_scan_1'] },
          how_to_use: null,
        },
        alternatives: [
          {
            product: {
              product_id: 'mock_dupe_1',
              sku_id: 'mock_dupe_1',
              brand: 'MockDupeBrand',
              name: 'Mock Dupe Product',
              category: 'treatment',
              display_name: 'MockDupeBrand Mock Dupe Product',
              availability: ['Global'],
              price: { usd: null, cny: null, unknown: true },
            },
            similarity_score: 82,
            tradeoffs: {
              missing_actives: ['niacinamide'],
              added_benefits: ['peptides'],
              texture_finish_differences: ['Mock: dupe has a lighter texture.'],
              price_delta_usd: null,
              availability_note: null,
            },
            evidence: { kb_citations: ['kb:mock_alt_1'] },
          },
        ],
        kb_requirements_check: { missing_fields: [], notes: [] },
      },
    };
  }

  if (/Task:\s*Compare\b/i.test(q)) {
    if (/COMPARE_EMPTY_TEST/i.test(q)) {
      return {
        answer: JSON.stringify({
          tradeoffs: [],
          evidence: null,
          confidence: null,
          missing_info: ['upstream_missing_or_empty'],
        }),
        intent: 'dupe',
        cards: [],
      };
    }
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

  if (/Task:\s*Generate skincare product picks\b/i.test(q)) {
    return {
      answer: JSON.stringify({
        recommendations: [
          {
            slot: 'other',
            step: 'Treatment',
            score: 68,
            sku: {
              sku_id: 'mock_reco_sku_1',
              product_id: 'mock_reco_sku_1',
              brand: 'MockBrand',
              name: 'Mock Gentle Treatment',
              category: 'treatment',
              display_name: 'MockBrand Mock Gentle Treatment',
              availability: ['Global'],
              price: { usd: null, cny: null, unknown: true },
            },
            reasons: ['Mock: gentle option that fits most oily skin routines.'],
            evidence_pack: { keyActives: ['niacinamide'], sensitivityFlags: ['low irritant'], citations: ['kb:mock_reco_1'] },
            missing_info: [],
            warnings: [],
          },
        ],
        evidence: {
          science: { key_ingredients: [], mechanisms: [], fit_notes: [], risk_notes: [] },
          social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
          expert_notes: [],
          confidence: 0.4,
          missing_info: [],
        },
        confidence: 0.4,
        missing_info: [],
        warnings: [],
      }),
      intent: 'reco',
      cards: [],
    };
  }

  if (/AM\s*\/\s*PM\s*skincare routine/i.test(q) || /recommend a simple AM\/PM skincare routine/i.test(q)) {
    return {
      answer: 'Mock routine generated.',
      intent: 'routine',
      cards: [],
      context: {
        budget: '¥500',
        routine: {
          am: [
            {
              step: 'Cleanser',
              sku: {
                sku_id: 'mock_cleanser_1',
                name: 'Mock Gentle Cleanser',
                brand: 'MockBrand',
                category: 'cleanser',
                price: 0,
                currency: 'USD',
                social_stats: { platform_scores: { Reddit: 0.8 } },
              },
              notes: ['Mock: gentle cleanse.'],
              product_id: 'mock_cleanser_1',
              evidence_pack: { keyActives: ['PHA'], pairingRules: ['Mock: avoid over-exfoliation.'], citations: ['kb:mock_routine_1'] },
              ingredients: { hero_actives: [], highlights: [] },
            },
          ],
          pm: [
            {
              step: 'Moisturizer',
              sku: {
                sku_id: 'mock_moisturizer_1',
                name: 'Mock Barrier Cream',
                brand: 'MockBrand',
                category: 'moisturizer',
                price: 0,
                currency: 'USD',
                social_stats: { platform_scores: { Reddit: 0.75 } },
              },
              notes: ['Mock: barrier support.'],
              product_id: 'mock_moisturizer_1',
              evidence_pack: { keyActives: ['ceramides'], pairingRules: [], citations: ['kb:mock_routine_2'] },
              ingredients: { hero_actives: [], highlights: [] },
            },
          ],
          total_usd: null,
          total_cny: null,
        },
      },
    };
  }

  return {
    answer: 'Mock Aurora reply.',
    intent: 'chat',
    // Always include a reco-like card so the BFF recommendation gate can be tested offline.
    cards: [{ type: 'recommendations', payload: { recommendations: [{ sku_id: 'mock_sku_generic' }] } }],
  };
}

async function auroraChat({
  baseUrl,
  query,
  timeoutMs,
  llm_provider,
  llm_model,
  anchor_product_id,
  anchor_product_url,
  messages,
  debug,
  allow_recommendations,
} = {}) {
  if (USE_AURORA_MOCK) return mockAuroraChat({ query, anchor_product_id, messages });
  const base = normalizeBaseUrl(baseUrl);
  if (!base) {
    const err = new Error('AURORA_DECISION_BASE_URL not configured');
    err.code = 'AURORA_NOT_CONFIGURED';
    throw err;
  }
  const url = `${base}/api/chat`;
  const payload = { query };
  if (llm_provider) payload.llm_provider = llm_provider;
  if (llm_model) payload.llm_model = llm_model;
  if (anchor_product_id) payload.anchor_product_id = anchor_product_id;
  if (anchor_product_url) payload.anchor_product_url = anchor_product_url;
  if (Array.isArray(messages) && messages.length) payload.messages = messages;
  if (typeof debug === 'boolean') payload.debug = debug;
  if (typeof allow_recommendations === 'boolean') payload.allow_recommendations = allow_recommendations;
  const resp = await postWithRetry(url, payload, { timeoutMs, retries: 1, retryDelayMs: 250 });
  const data = resp && resp.data;
  return data && typeof data === 'object' ? data : { raw: data };
}

module.exports = {
  normalizeBaseUrl,
  buildContextPrefix,
  auroraChat,
};
