const {
  upsertSuggestion,
  getSuggestionByInputHash,
  __internal,
} = require('../src/auroraBff/recoLabelSuggestionStore');

describe('aurora reco prelabel cache store', () => {
  test('same input hash can be read from cache without duplicate call dependency', async () => {
    const prev = __internal.state.dbUnavailable;
    __internal.state.dbUnavailable = true;
    try {
      const saved = await upsertSuggestion({
        id: 's_cache_1',
        anchor_product_id: 'anchor_1',
        block: 'competitors',
        candidate_product_id: 'cand_1',
        suggested_label: 'relevant',
        wrong_block_target: null,
        confidence: 0.7,
        rationale_user_visible: 'Evidence aligns.',
        flags: [],
        model_name: 'gemini-2.0-flash',
        prompt_version: 'prelabel_v1',
        input_hash: 'hash_abc',
      });
      expect(saved.id).toBe('s_cache_1');
      const hit = await getSuggestionByInputHash({
        inputHash: 'hash_abc',
        modelName: 'gemini-2.0-flash',
        promptVersion: 'prelabel_v1',
        block: 'competitors',
        ttlMs: 3600000,
      });
      expect(hit).toBeTruthy();
      expect(hit.id).toBe('s_cache_1');
      expect(hit.suggested_label).toBe('relevant');
    } finally {
      __internal.state.dbUnavailable = prev;
    }
  });
});
