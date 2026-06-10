'use strict';

/**
 * Regression test for the cited-vs-retrieved grounding bug.
 *
 * Real prod symptom (SKU "Winona Soothing Repair Serum", query
 * "where can I buy Winona Soothing Repair Serum"):
 *   - ChatGPT/Claude's grounded ANSWER cited WinonaBeauty / Yami / Yoycart.
 *   - But the web search also RETRIEVED a tangential sephora.com page (a
 *     different "soothing" product the answer never cited).
 *   - The extractor merged the retrieved pool (web_search_call.action.sources /
 *     web_search_tool_result) into grounding_sources, so sephora.com was
 *     counted as a citation and promoted to a buyer-path controller, poisoning
 *     the recommendation ("AI leans on sephora.com").
 *
 * Invariant being enforced: grounding_sources == CITED sources only (matching
 * Gemini's groundingChunks semantics). The retrieved candidate pool goes to a
 * separate field and is NEVER counted as a citation.
 */

describe('agentCenterLlmProbe — grounding_sources are cited-only (retrieved separated)', () => {
  const { _internals } = require('../src/internal/agentCenterLlmProbe');
  const {
    extractOpenAIGroundingChunks,
    extractOpenAIRetrievedSources,
    extractAnthropicGroundingChunks,
    extractAnthropicRetrievedSources,
  } = _internals;

  const hostsOf = (sources) => sources.map((s) => s.host);

  // Shaped like the real OpenAI Responses API output for the Winona query.
  const openaiResp = {
    output: [
      {
        type: 'web_search_call',
        action: {
          sources: [
            // RETRIEVED pool — a tangential Sephora product the search returned
            // but the answer NEVER cited (titles empty, as in the real response).
            { url: 'https://www.sephora.com/product/soothing-balm-P12345', title: '' },
            { url: 'https://www.yami.com/en/p/winona-repair-serum', title: '' },
          ],
        },
      },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'Available on WinonaBeauty, Yami, and Yoycart.',
            annotations: [
              { type: 'url_citation', url: 'https://www.winonabeauty.com/products/soothing-serum', title: 'WinonaBeauty' },
              { type: 'url_citation', url: 'https://www.yami.com/en/p/winona-repair-serum', title: 'Yami' },
              { type: 'url_citation', url: 'https://www.yoycart.com/Product/winona-serum', title: 'Yoycart' },
            ],
          },
        ],
      },
    ],
  };

  test('OpenAI: grounding_sources are the CITED hosts only — no retrieved-only Sephora', () => {
    const cited = hostsOf(extractOpenAIGroundingChunks(openaiResp));
    expect(cited).toEqual(expect.arrayContaining(['winonabeauty.com', 'yami.com', 'yoycart.com']));
    expect(cited).not.toContain('sephora.com'); // the whole point of the fix
  });

  test('OpenAI: retrieved candidate pool is captured separately (incl. Sephora)', () => {
    const retrieved = hostsOf(extractOpenAIRetrievedSources(openaiResp));
    expect(retrieved).toContain('sephora.com');
    expect(retrieved).toContain('yami.com');
    // And the cited extractor must NOT include action.sources content.
    expect(hostsOf(extractOpenAIGroundingChunks(openaiResp))).not.toContain('sephora.com');
  });

  // Shaped like the real Anthropic messages API content for the same query.
  const anthropicResp = {
    content: [
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://www.sephora.com/product/soothing-balm-P12345', title: 'Soothing Balm' },
          { type: 'web_search_result', url: 'https://www.yami.com/en/p/winona-repair-serum', title: 'Yami' },
        ],
      },
      {
        type: 'text',
        text: 'Available on WinonaBeauty and Yami.',
        citations: [
          { url: 'https://www.winonabeauty.com/products/soothing-serum', title: 'WinonaBeauty' },
          { url: 'https://www.yami.com/en/p/winona-repair-serum', title: 'Yami' },
        ],
      },
    ],
  };

  test('Anthropic: grounding_sources are the CITED hosts only — no retrieved-only Sephora', () => {
    const cited = hostsOf(extractAnthropicGroundingChunks(anthropicResp));
    expect(cited).toEqual(expect.arrayContaining(['winonabeauty.com', 'yami.com']));
    expect(cited).not.toContain('sephora.com');
  });

  test('Anthropic: retrieved candidate pool captured separately (incl. Sephora)', () => {
    expect(hostsOf(extractAnthropicRetrievedSources(anthropicResp))).toContain('sephora.com');
  });

  test('empty / malformed responses -> empty cited + empty retrieved (no crash)', () => {
    for (const resp of [{}, null, { output: null }, { content: 'x' }]) {
      expect(extractOpenAIGroundingChunks(resp)).toEqual([]);
      expect(extractOpenAIRetrievedSources(resp)).toEqual([]);
      expect(extractAnthropicGroundingChunks(resp)).toEqual([]);
      expect(extractAnthropicRetrievedSources(resp)).toEqual([]);
    }
  });
});
