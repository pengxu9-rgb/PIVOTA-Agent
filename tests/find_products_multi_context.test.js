const { buildFindProductsMultiContext } = require('../src/findProductsMulti/policy');

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
});

