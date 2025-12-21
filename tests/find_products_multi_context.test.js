const { buildFindProductsMultiContext } = require('../src/findProductsMulti/policy');
const { extractIntentRuleBased } = require('../src/findProductsMulti/intent');

describe('find_products_multi context building', () => {
  test('uses last user message as query when search.query is empty', async () => {
    const { intent, adjustedPayload, rawUserQuery } = await buildFindProductsMultiContext({
      payload: {
        search: { query: '' },
        user: { recent_queries: ['Labubu doll clothes'] },
        messages: [
          { role: 'assistant', content: 'Hi!' },
          {
            role: 'user',
            content:
              'Voy a ir de senderismo con mi perro este fin de semana. Va a hacer frío, por favor encuentra ropa adecuada para mi perro.',
          },
        ],
      },
      metadata: {},
    });

    expect(rawUserQuery).toContain('senderismo');
    expect(intent.language).toBe('es');
    expect(intent.target_object.type).toBe('pet');
    expect(String(adjustedPayload.search.query)).toContain('perro');
  });

  test('sexy outfit query expands to lingerie/dress (not outerwear)', async () => {
    const { intent, adjustedPayload } = await buildFindProductsMultiContext({
      payload: {
        search: { query: '当天晚上要给女朋友一个惊喜，准备一套性感的衣服送给她，推荐一些' },
        user: { recent_queries: [] },
        messages: [{ role: 'user', content: '当天晚上要给女朋友一个惊喜，准备一套性感的衣服送给她，推荐一些' }],
      },
      metadata: {},
    });

    expect(intent.target_object.type).toBe('human');
    expect(intent.primary_domain).toBe('human_apparel');
    expect(intent.scenario.name).toBe('sexy_outfit');

    const q = String(adjustedPayload.search.query || '');
    expect(q.toLowerCase()).toContain('lingerie');
    expect(q.toLowerCase()).not.toContain('outerwear');
    expect(q.toLowerCase()).not.toContain('coat jacket outerwear');
  });

  test('toy request overrides prior beauty history (no accidental cosmetic tools)', async () => {
    const intent = extractIntentRuleBased(
      'Show me some pink toys',
      [],
      [{ role: 'user', content: 'makeup brush set for foundation and powder' }],
    );
    expect(intent.primary_domain).toBe('toy_accessory');
    expect(intent.target_object.type).toBe('toy');
  });

  test('toy follow-up keeps toy mission from recent queries', async () => {
    const intent = extractIntentRuleBased(
      'I want a pajama, the color is green',
      ['Show me some pink toys'],
      [],
    );
    expect(intent.primary_domain).toBe('toy_accessory');
    expect(intent.target_object.type).toBe('toy');
  });

  test('toy follow-up prefers message mission over older recent queries', async () => {
    const intent = extractIntentRuleBased(
      'I want a pajama, the color is green',
      ['makeup brush set for foundation and powder'],
      [
        { role: 'user', content: 'Show me some pink toys' },
        { role: 'assistant', content: 'Sure—here are some options.' },
        { role: 'user', content: 'I want a pajama, the color is green' },
      ],
    );
    expect(intent.primary_domain).toBe('toy_accessory');
    expect(intent.target_object.type).toBe('toy');
  });
});
