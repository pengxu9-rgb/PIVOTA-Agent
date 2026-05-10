const {
  understandShoppingQuery,
  resolveBeautyCategoryPathPrefixFromText,
} = require('../src/findProductsMulti/queryUnderstanding');

describe('find_products_multi query understanding', () => {
  test('corrects known fragrance typos before category routing', () => {
    const out = understandShoppingQuery({ rawQuery: 'tom ford fragarance', source: 'shopping_agent' });

    expect(out.corrected_query).toBe('tom ford fragrance');
    expect(out.effective_query).toBe('tom ford fragrance');
    expect(out.category_path_prefix).toBe('beauty/fragrance/');
    expect(out.brand_candidates).toEqual(expect.arrayContaining(['tom ford']));
    expect(out.corrections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          token: 'fragarance',
          replacement: 'fragrance',
          source: 'known_beauty_category_typo',
        }),
      ]),
    );
  });

  test('binds generic category follow-ups to current conversation brand context', () => {
    const out = understandShoppingQuery({
      rawQuery: 'fragrance',
      conversationMessages: [
        { role: 'user', content: 'tom ford fragarance' },
        { role: 'assistant', content: 'I found Tom Ford fragrance options.' },
        { role: 'user', content: 'fragrance' },
      ],
      sessionRecentQueries: ['fenty lipsticks'],
    });

    expect(out.effective_query).toBe('tom ford fragrance');
    expect(out.context_scope).toBe('conversation');
    expect(out.context_binding).toEqual(
      expect.objectContaining({
        brand: 'tom ford',
        reason: 'generic_category_followup_conversation_brand',
      }),
    );
  });

  test('does not bind generic category to session recent queries', () => {
    const out = understandShoppingQuery({
      rawQuery: 'fragrance',
      conversationMessages: [],
      sessionRecentQueries: ['tom ford fragarance'],
    });

    expect(out.effective_query).toBe('fragrance');
    expect(out.context_scope).toBe('none');
    expect(out.risk_flags).toEqual(expect.arrayContaining(['session_recent_queries_ignored_for_context']));
  });

  test('binds session recent query only when continuation is explicit', () => {
    const out = understandShoppingQuery({
      rawQuery: 'continue previous search',
      conversationMessages: [],
      sessionRecentQueries: ['tom ford fragarance'],
    });

    expect(out.effective_query).toBe('tom ford fragrance');
    expect(out.context_scope).toBe('session_explicit');
    expect(out.context_binding).toEqual(
      expect.objectContaining({
        reason: 'explicit_session_previous_query',
        source_query: 'tom ford fragarance',
      }),
    );
  });

  test('keeps fragrance-free moisturizer out of fragrance routing', () => {
    const out = understandShoppingQuery({ rawQuery: 'fragrance-free barrier moisturizer' });

    expect(out.category_path_prefix).toBe('beauty/skincare/moisturize/');
    expect(out.hard_negatives.fragrance_free_skincare).toBe(true);
    expect(resolveBeautyCategoryPathPrefixFromText('fragrance-free barrier moisturizer')).toBe(
      'beauty/skincare/moisturize/',
    );
  });

  test('flags strict lipstick intent separately from lip oil or balm', () => {
    expect(understandShoppingQuery({ rawQuery: 'fenty beauty lipsticks' }).hard_negatives.strict_lipstick).toBe(true);
    expect(understandShoppingQuery({ rawQuery: 'fenty lip oil' }).hard_negatives.strict_lipstick).toBe(false);
  });

  test('binds acne recommendation follow-up skin and location slots to the prior concern', () => {
    const out = understandShoppingQuery({
      rawQuery: 'i think i am aoily skin, and i live in SF.',
      conversationMessages: [
        { role: 'user', content: 'i have acne issue, recommend some products to take care of it' },
        {
          role: 'assistant',
          content:
            'I need a bit more context before narrowing products: skin_type, environment. A skin analysis can help if you want a more precise routine, but it is not required to continue.',
        },
        { role: 'user', content: 'i think i am aoily skin, and i live in SF.' },
      ],
      source: 'shopping_agent_ui',
    });

    expect(out.corrected_query).toBe('i think i am oily skin, and i live in SF.');
    expect(out.effective_query).toBe('acne treatment serum oily skin San Francisco');
    expect(out.category_path_prefix).toBe('beauty/skincare/treat/');
    expect(out.context_scope).toBe('conversation');
    expect(out.context_binding).toEqual(
      expect.objectContaining({
        reason: 'beauty_slot_followup_conversation_context',
        source_query: 'i have acne issue, recommend some products to take care of it',
      }),
    );
    expect(out.beauty_context.bound).toEqual(
      expect.objectContaining({
        concern: 'acne',
        skin_type: 'oily',
        location: 'San Francisco',
      }),
    );
  });

  test('does not convert a profile-only skin statement into a product search without conversation concern', () => {
    const out = understandShoppingQuery({
      rawQuery: 'i think i am an oily skin, and i live in SF.',
      conversationMessages: [],
    });

    expect(out.effective_query).toBe('i think i am an oily skin, and i live in SF.');
    expect(out.context_scope).toBe('none');
  });
});
