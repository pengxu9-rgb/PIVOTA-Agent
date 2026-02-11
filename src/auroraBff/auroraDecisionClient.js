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

function truncateText(value, maxChars) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function normalizeResumeHistory(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const item of history) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const qid = truncateText(item.question_id, 80);
    const option = truncateText(item.option, 60);
    if (!qid || !option) continue;
    out.push({ question_id: qid, option });
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeKnownProfileFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  const out = {};

  const skinType = truncateText(fields.skinType, 40);
  if (skinType) out.skinType = skinType;

  const sensitivity = truncateText(fields.sensitivity, 40);
  if (sensitivity) out.sensitivity = sensitivity;

  const barrierStatus = truncateText(fields.barrierStatus, 40);
  if (barrierStatus) out.barrierStatus = barrierStatus;

  const budgetTier = truncateText(fields.budgetTier, 40);
  if (budgetTier) out.budgetTier = budgetTier;

  if (Array.isArray(fields.goals)) {
    const goals = [];
    for (const rawGoal of fields.goals) {
      const goal = truncateText(rawGoal, 40);
      if (!goal) continue;
      goals.push(goal);
      if (goals.length >= 5) break;
    }
    if (goals.length) out.goals = goals;
  }

  return Object.keys(out).length ? out : null;
}
function buildResumeContextPrefix(resumeContext) {
  if (!resumeContext || typeof resumeContext !== 'object' || Array.isArray(resumeContext)) return '';
  if (resumeContext.enabled === false) return '';

  const resumeText = truncateText(resumeContext.resume_user_text, 300) || '(no message)';
  const flowId = truncateText(resumeContext.flow_id, 40);
  const includeHistory = resumeContext.include_history !== false;
  const history = includeHistory ? normalizeResumeHistory(resumeContext.clarification_history) : [];
  const knownProfileFields = normalizeKnownProfileFields(resumeContext.known_profile_fields);
  const templateVersion = String(resumeContext.template_version || 'v1').trim().toLowerCase();

  let lines = null;
  if (templateVersion === 'v2') {
    lines = ['[RESUME CONTEXT — AUTHORITATIVE]'];
    if (flowId) lines.push(`Flow: ${flowId}`);
    lines.push(`Original user request (answer this): "${resumeText}"`);
    lines.push('');
    if (includeHistory) {
      if (history.length) {
        lines.push('Answered clarifications (do NOT ask again):');
        for (const item of history) {
          lines.push(`- ${item.question_id} = "${item.option}"`);
        }
      } else {
        lines.push('Answered clarifications: none listed (but if already answered via UI, do NOT ask again).');
      }
    } else {
      lines.push('Clarifications were answered via UI; do NOT ask again.');
    }
    lines.push('');
    lines.push('Profile fields now known (authoritative; use directly):');
    if (knownProfileFields) {
      if (knownProfileFields.skinType) lines.push(`- skinType = "${knownProfileFields.skinType}"`);
      if (knownProfileFields.sensitivity) lines.push(`- sensitivity = "${knownProfileFields.sensitivity}"`);
      if (knownProfileFields.barrierStatus) lines.push(`- barrierStatus = "${knownProfileFields.barrierStatus}"`);
      if (Array.isArray(knownProfileFields.goals)) {
        for (const goal of knownProfileFields.goals) {
          lines.push(`- goals = "${goal}"`);
        }
      }
      if (knownProfileFields.budgetTier) lines.push(`- budgetTier = "${knownProfileFields.budgetTier}"`);
    }
    lines.push('(If a field is not listed here, treat it as unknown.)');
    lines.push('');
    lines.push('Instruction:');
    lines.push('1) Do NOT repeat any questions above.');
    lines.push('2) Do NOT restart intake or request a full profile.');
    lines.push('3) Proceed to answer the original request now.');
    lines.push('4) If truly necessary, ask at most ONE new question, and it must NOT be something already answered/known.');
  } else {
    lines = ['[RESUME CONTEXT]'];
    if (flowId) lines.push(`Flow: ${flowId}`);
    lines.push(`Original user request: "${resumeText}"`);
    if (history.length) {
      lines.push('Clarification answers (in order):');
      for (const item of history) {
        lines.push(`- ${item.question_id}: ${item.option}`);
      }
    } else {
      lines.push('Clarifications were answered via UI; proceed without asking again.');
    }
    lines.push(
      'Instruction: Do not ask for these clarifications again. Continue answering the original request using the provided answers and profile.',
    );
  }
  return `${lines.join('\n')}\n\n`;
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

  // Test helper: allow asserting what the BFF sent upstream (prefix includes profile/recent logs/meta).
  if (/CHAT_PROFILE_PREFIX_ECHO_TEST/i.test(q)) {
    return { answer: q, intent: 'chat', cards: [] };
  }

  if (/CLARIFICATION_FLOW_V2_FREE_TEXT_CONTINUE_TEST/i.test(q)) {
    return {
      answer: 'Mock: free text after pending clarification abandon.',
      intent: 'chat',
      cards: [],
    };
  }

  if (/CLARIFICATION_FLOW_V2_TTL_TEST/i.test(q)) {
    return {
      answer: 'Mock: pending clarification TTL fallback to upstream.',
      intent: 'chat',
      cards: [],
    };
  }

  if (/CLARIFICATION_FLOW_V2_TRUNCATION_TEST/i.test(q)) {
    const questions = Array.from({ length: 8 }).map((_, i) => ({
      id: `question_${i}`,
      question: `Question ${i} ${'Q'.repeat(260)}`,
      options: Array.from({ length: 12 }).map((__, j) => `Option ${i}-${j} ${'O'.repeat(120)}`),
    }));
    return {
      answer: 'Mock: clarification truncation stress.',
      intent: 'clarify',
      cards: [],
      clarification: { questions },
    };
  }

  if (/CLARIFICATION_FLOW_V2_RESUME_ECHO_TEST/i.test(q)) {
    if (/clarification_history/i.test(q)) {
      return { answer: q, intent: 'chat', cards: [] };
    }
    return {
      answer: 'Mock: clarification flow start.',
      intent: 'clarify',
      cards: [],
      clarification: {
        questions: [
          {
            id: 'skin_type',
            question: 'Which skin type fits you best?',
            options: ['Oily', 'Dry', 'Combination', 'Not sure'],
          },
          {
            id: 'goals',
            question: 'What is your top goal now?',
            options: ['Acne control', 'Barrier repair', 'Brightening'],
          },
        ],
      },
    };
  }

  if (/CLARIFICATION_FLOW_V2_RESUME_PROBE_BAD_TEST/i.test(q)) {
    if (/clarification_history/i.test(q)) {
      return {
        answer:
          'Before I can recommend products safely, I need a quick skin profile:\n' +
          '1) What is your skin type?\n' +
          '2) Is your barrier stable or do you have stinging/redness?\n' +
          '3) What is your main goal?',
        intent: 'chat',
        cards: [],
      };
    }
    return {
      answer: 'Mock: clarification flow start.',
      intent: 'clarify',
      cards: [],
      clarification: {
        questions: [
          {
            id: 'skin_type',
            question: 'Which skin type fits you best?',
            options: ['Oily', 'Dry', 'Combination', 'Not sure'],
          },
          {
            id: 'goals',
            question: 'What is your top goal now?',
            options: ['Acne control', 'Barrier repair', 'Brightening'],
          },
        ],
      },
    };
  }

  if (/RESUME_PROBE_NON_RESUME_BAD_TEXT_TEST/i.test(q)) {
    return {
      answer:
        'Before I can recommend products safely, I need a quick skin profile:\n' +
        '1) What is your skin type?\n' +
        '2) What is your main goal?',
      intent: 'chat',
      cards: [],
    };
  }
  if (/CLARIFICATION_FLOW_V2_TWO_QUESTIONS_TEST/i.test(q)) {
    if (/clarification_history/i.test(q)) {
      return {
        answer: 'Mock: clarification flow resumed with history context.',
        intent: 'chat',
        cards: [],
      };
    }
    return {
      answer: 'Mock: clarification flow start.',
      intent: 'clarify',
      cards: [],
      clarification: {
        questions: [
          {
            id: 'skin_type',
            question: 'Which skin type fits you best?',
            options: ['Oily', 'Dry', 'Combination', 'Not sure'],
          },
          {
            id: 'goals',
            question: 'What is your top goal now?',
            options: ['Acne control', 'Barrier repair', 'Brightening'],
          },
        ],
      },
    };
  }

  if (/CLARIFICATION_FILTER_SKINTYPE_ONLY_TEST/i.test(q)) {
    return {
      answer: 'Mock: one clarification question.',
      intent: 'clarify',
      cards: [],
      clarification: {
        questions: [
          {
            id: 'skin_type',
            question: 'Which skin type fits you best?',
            options: ['Oily', 'Dry', 'Combination', 'Not sure'],
          },
        ],
        missing_fields: ['skinType'],
      },
    };
  }

  if (/CLARIFICATION_FILTER_SKINTYPE_NEXT_TEST/i.test(q)) {
    return {
      answer: 'Mock: two clarification questions.',
      intent: 'clarify',
      cards: [],
      clarification: {
        questions: [
          {
            id: 'skin_type',
            question: 'Which skin type fits you best?',
            options: ['Oily', 'Dry', 'Combination', 'Not sure'],
          },
          {
            id: 'next',
            question: 'What do you want to do next?',
            options: ['Build an AM/PM routine', 'Evaluate one product'],
          },
        ],
      },
    };
  }

  if (/CLARIFICATION_FILTER_INVALID_OPTIONS_TEST/i.test(q)) {
    return {
      answer: 'Mock: invalid clarification schema.',
      intent: 'clarify',
      cards: [],
      clarification: {
        questions: [
          {
            id: 'skin_type',
            question: 'Which skin type fits you best?',
            options: 'Oily',
          },
        ],
      },
    };
  }

  if (/DUPE_SUGGEST_TEST/i.test(q)) {
    return {
      answer: 'Mock: dupe suggest alternatives.',
      intent: 'product',
      cards: [],
      structured: {
        schema_version: 'aurora.structured.v1',
        alternatives: [
          {
            product: { sku_id: 'mock_dupe_1', brand: 'MockBrand', name: 'Mock Dupe Cleanser' },
            similarity_score: 0.92,
            tradeoffs: {
              price_delta_usd: -12,
              added_benefits: ['Niacinamide'],
              texture_finish_differences: ['More gel-like finish'],
              availability_note: 'Widely available',
            },
            reasons: ['Cheaper but close ingredient profile', 'Lower irritation risk for sensitive skin'],
            evidence: { kb_citations: ['kb:mock_dupe_1'] },
            missing_info: [],
          },
          {
            product: { sku_id: 'mock_dupe_2', brand: 'MockBrand', name: 'Mock Budget Wash' },
            similarity_score: 0.88,
            tradeoffs: {
              price_delta_usd: -7,
              missing_actives: ['Ceramides'],
              texture_finish_differences: ['Slightly foaming'],
            },
            reasons: ['Budget option with similar cleansing strength'],
            evidence: { kb_citations: ['kb:mock_dupe_2'] },
            missing_info: [],
          },
          {
            product: { sku_id: 'mock_similar_1', brand: 'MockBrand', name: 'Mock Similar Cleanser' },
            similarity_score: 0.9,
            tradeoffs: { price_delta_usd: 0, texture_finish_differences: ['More creamy texture'] },
            reasons: ['Very similar positioning and feel'],
            evidence: { kb_citations: ['kb:mock_similar_1'] },
            missing_info: [],
          },
          {
            product: { sku_id: 'mock_premium_1', brand: 'MockBrand', name: 'Mock Premium Cleanser' },
            similarity_score: 0.86,
            tradeoffs: { price_delta_usd: 9, added_benefits: ['Ceramides'], availability_note: 'Sephora / Dermstore' },
            reasons: ['Premium upgrade with added barrier support'],
            evidence: { kb_citations: ['kb:mock_premium_1'] },
            missing_info: [],
          },
        ],
      },
      context: {},
    };
  }

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

  if (/STRUCTURED_STUB_ONLY_TEST/i.test(q)) {
    const longAnswer = [
      'Part 1: Diagnosis 🩺',
      '- This is a long templated answer, but upstream did not return any renderable cards.',
      '',
      'Part 2: The Routine 📅',
      'AM (Protection):',
      '- Cleanser - Mock Gentle Cleanser',
      'PM (Treatment):',
      '- Treatment - Mock Gentle Treatment',
      '',
      'Part 3: Budget Analysis 💰',
      '- Price unknown.',
      '',
      'Part 4: Safety Warning ⚠️',
      '- Wear SPF.',
      '',
      'Notes:',
      '- (filler) '.repeat(80),
    ].join('\n');

    return {
      answer: longAnswer,
      intent: 'product',
      cards: [],
      structured: {
        schema_version: 'aurora.structured.v1',
        parse: { normalized_query: 'STRUCTURED_STUB_ONLY_TEST', parse_confidence: 1, normalized_query_language: 'zh-CN' },
        conflicts: { schema_version: 'aurora.conflicts.v1', safe: true, conflicts: [], summary: '未发现明显冲突。' },
      },
      context: {},
    };
  }

  if (/SHORT_CARDS_BELOW_STUB_TEST/i.test(q)) {
    return {
      answer: 'I summarized the key results into structured cards below.',
      intent: 'product',
      cards: [],
      structured: {
        schema_version: 'aurora.structured.v1',
        parse: { normalized_query: 'SHORT_CARDS_BELOW_STUB_TEST', parse_confidence: 1, normalized_query_language: 'zh-CN' },
        conflicts: { schema_version: 'aurora.conflicts.v1', safe: true, conflicts: [], summary: '未发现明显冲突。' },
      },
      context: {},
    };
  }

  if (/NON_GENERIC_STUB_TEST/i.test(q)) {
    return {
      answer: 'Here is a quick summary based on what I could parse.',
      intent: 'product',
      cards: [],
      structured: {
        schema_version: 'aurora.structured.v1',
        parse: { normalized_query: 'NON_GENERIC_STUB_TEST', parse_confidence: 1, normalized_query_language: 'zh-CN' },
        conflicts: { schema_version: 'aurora.conflicts.v1', safe: true, conflicts: [], summary: '未发现明显冲突。' },
      },
      context: {},
    };
  }

  if (/SHORT_CARDS_BELOW_STRIPPED_RECO_TEST/i.test(q)) {
    return {
      answer: 'I summarized the key results into structured cards below.',
      intent: 'product',
      // Include a reco-like card so the BFF strips it (non-explicit), leaving only hidden cards.
      cards: [{ type: 'recommendations', payload: { recommendations: [{ sku_id: 'mock_sku_generic' }] } }],
      structured: {
        schema_version: 'aurora.structured.v1',
        parse: { normalized_query: 'SHORT_CARDS_BELOW_STRIPPED_RECO_TEST', parse_confidence: 1, normalized_query_language: 'zh-CN' },
        conflicts: { schema_version: 'aurora.conflicts.v1', safe: true, conflicts: [], summary: '未发现明显冲突。' },
      },
      context: {},
    };
  }

  if (/ANCHOR_CONTEXT_ONLY_TEST/i.test(q)) {
    const longAnswer = [
      'Part 1: Diagnosis 🩺',
      '- This is a long templated answer, but upstream only returned parse/conflicts plus an anchor in context.',
      '',
      'Part 2: The Routine 📅',
      'AM (Protection):',
      '- Cleanser - Mock Gentle Cleanser',
      'PM (Treatment):',
      '- Treatment - Mock Gentle Treatment',
      '',
      'Part 3: Budget Analysis 💰',
      '- Price unknown.',
      '',
      'Part 4: Safety Warning ⚠️',
      '- Wear SPF.',
      '',
      'Notes:',
      '- (filler) '.repeat(80),
    ].join('\n');

    return {
      answer: longAnswer,
      intent: 'product',
      cards: [],
      structured: {
        schema_version: 'aurora.structured.v1',
        parse: { normalized_query: 'ANCHOR_CONTEXT_ONLY_TEST', parse_confidence: 1, normalized_query_language: 'zh-CN' },
        conflicts: { schema_version: 'aurora.conflicts.v1', safe: true, conflicts: [], summary: '未发现明显冲突。' },
      },
      context: {
        anchor: {
          id: 'mock_anchor_niacinamide',
          brand: 'The Ordinary',
          name: 'Niacinamide 10% + Zinc 1%',
          vetoed: false,
          score: { science: 42, social: 73, engineering: 75, total: 64, vetoed: false },
          risk_flags: ['high_irritation'],
          risk_flags_canonical: ['high_irritation'],
          kb_profile: {
            keyActives: ['Niacinamide 10%', 'Zinc PCA 1%'],
            comparisonNotes: ['Good budget option'],
            sensitivityFlags: ['high_irritation'],
            pairingRules: [],
            textureFinish: ['Texture: lotion', 'Finish: natural'],
          },
          social: {
            red_score: 65,
            reddit_score: 80,
            burn_rate: 0.1,
            top_keywords: ['oil control', 'pores', 'blemishes'],
          },
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
  resume_context,
} = {}) {
  const queryText = String(query || '');
  const resumePrefix = buildResumeContextPrefix(resume_context);
  const finalQuery = resumePrefix ? `${resumePrefix}${queryText}` : queryText;
  if (USE_AURORA_MOCK) return mockAuroraChat({ query: finalQuery, anchor_product_id, messages });
  const base = normalizeBaseUrl(baseUrl);
  if (!base) {
    const err = new Error('AURORA_DECISION_BASE_URL not configured');
    err.code = 'AURORA_NOT_CONFIGURED';
    throw err;
  }
  const url = `${base}/api/chat`;
  const payload = { query: finalQuery };
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
