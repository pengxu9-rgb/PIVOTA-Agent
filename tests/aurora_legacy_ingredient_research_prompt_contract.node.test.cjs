const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

test('legacy ingredient research prompt encodes strict JSON, citation allowlist, and fail-safe rules', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const prompt = __internal.buildIngredientResearchPrompts({
      query: 'azelaic acid',
      language: 'EN',
      goal: 'redness',
      sensitivity: 'high',
      profileSummary: { barrier_status: 'impaired' },
      sources: [
        { title: 'Review paper', url: 'https://example.com/review', year: 2023, source: 'Journal' },
      ],
    });

    assert.equal(prompt.promptVersion, 'ingredient_research_v2_lite_hardened');
    assert.match(prompt.systemPrompt, /Prompt version: ingredient_research_v2_lite_hardened/i);
    assert.match(prompt.systemPrompt, /single valid JSON object/i);
    assert.match(prompt.systemPrompt, /Use ONLY context\.sources for citations/i);
    assert.match(prompt.userPrompt, /\[SYSTEM_CONTRACT\]\[version=ingredient_research_v2_lite_hardened\]/i);
    assert.match(prompt.userPrompt, /schema_version MUST be "v2-lite"/i);
    assert.match(prompt.userPrompt, /top_products may be included, but if present it must use tier buckets only/i);
    assert.match(prompt.userPrompt, /Cite ONLY context\.sources entries/i);
    assert.match(prompt.userPrompt, /evidence\.citations MUST be \[\] and evidence\.grade MUST be null/i);
    assert.match(prompt.userPrompt, /use null or \[\] \(never output the literal string "unknown"\)/i);
    assert.match(prompt.userPrompt, /Fail-safe short-circuit/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('legacy ingredient lookup upstream prompt encodes compact explainer rules and uncertainty policy', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const prompt = __internal.buildIngredientLookupUpstreamPrompt({
      query: 'azelaic acid',
      language: 'EN',
    });

    assert.match(prompt, /\[PROMPT_VERSION=inline_lookup_v2\]/i);
    assert.match(prompt, /Role: compact ingredient explainer/i);
    assert.match(prompt, /1-minute ingredient report organized as benefits -> evidence strength -> usage watchouts -> risk by skin profile/i);
    assert.match(prompt, /Focus only on the named ingredient/i);
    assert.match(prompt, /do not drift into product lists, shopping advice, or generic recommendations/i);
    assert.match(prompt, /If the ingredient is ambiguous or the evidence is weak, state the uncertainty explicitly and stay conservative/i);
    assert.match(prompt, /Do not provide diagnosis, prescription-style instructions, or exaggerated efficacy claims/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('legacy ingredient research sanitizer drops citations outside the allowed source list and normalizes unknowns', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const parsed = __internal.sanitizeIngredientResearchOutput(
      {
        ingredient: {
          inci: 'Azelaic Acid',
          display_name: 'Azelaic Acid',
          aliases: ['unknown', 'Nonanedioic acid'],
          what_it_is: 'A multifunctional dicarboxylic acid.',
        },
        overview: 'Helps with post-acne marks.',
        benefits: [
          { concern: 'redness', strength: 2, what_it_means: 'Can help reduce visible redness.' },
        ],
        safety: {
          irritation_risk: 'medium',
          watchouts: [{ issue: 'Stinging', likelihood: 'common', what_to_do: 'Start slowly.' }],
        },
        usage: {
          time: 'Both',
          frequency: 'daily',
          notes: ['unknown', 'Use after cleansing.'],
        },
        confidence: 'medium',
        evidence: {
          grade: 'A',
          summary: 'Supported by multiple studies.',
          citations: [
            { title: 'Review paper', url: 'https://example.com/review', year: 2023, source: 'Journal' },
            { title: 'Invented source', url: 'https://bad.example.com/fake', year: 2025, source: 'Fake' },
          ],
        },
        top_products: ['Example Serum'],
      },
      {
        query: 'azelaic acid',
        language: 'EN',
        sources: [
          { title: 'Review paper', url: 'https://example.com/review', year: 2023, source: 'Journal' },
        ],
      },
    );

    assert.equal(parsed.schema_version, 'v2-lite');
    assert.equal(parsed.ingredient.inci, 'Azelaic Acid');
    assert.deepEqual(parsed.ingredient.aliases, ['Nonanedioic acid']);
    assert.equal(parsed.evidence.grade, 'A');
    assert.equal(parsed.evidence.citations.length, 1);
    assert.equal(parsed.evidence.citations[0].url, 'https://example.com/review');
    assert.deepEqual(parsed.usage.notes, ['Use after cleansing.']);
    assert.deepEqual(parsed.top_products.mid, ['Example Serum']);
  } finally {
    delete require.cache[moduleId];
  }
});
