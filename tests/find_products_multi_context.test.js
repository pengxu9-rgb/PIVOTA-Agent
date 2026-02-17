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

  test('pet follow-up keeps pet mission from chat messages (breed-only follow-up)', async () => {
    const intent = extractIntentRuleBased(
      '边牧的颜色是黑白的，帮我找点颜色鲜艳的款式',
      [],
      [
        { role: 'user', content: '我想买一件狗的衣服，我家养了一只边牧' },
        { role: 'assistant', content: '我找到了几件更符合你需求的选择。' },
        { role: 'user', content: '边牧的颜色是黑白的，帮我找点颜色鲜艳的款式' },
      ],
    );
    expect(intent.primary_domain).toBe('sports_outdoor');
    expect(intent.target_object.type).toBe('pet');
    expect(intent.scenario.name).toContain('pet');
  });

  test('eye shadow brush query routes to dedicated scenario (no full-face kit)', async () => {
    const intent = extractIntentRuleBased('帮我挑一个画眼影的刷子', [], []);
    expect(intent.primary_domain).toBe('beauty');
    expect(intent.target_object.type).toBe('human');
    expect(intent.scenario.name).toBe('eye_shadow_brush');
  });

  test('eye shadow brush follow-up keeps mission from messages', async () => {
    const intent = extractIntentRuleBased('想要自然一点的晕染', [], [
      { role: 'user', content: '帮我挑一个画眼影的刷子' },
      { role: 'assistant', content: '好的，我先问你两个问题。' },
      { role: 'user', content: '想要自然一点的晕染' },
    ]);
    expect(intent.primary_domain).toBe('beauty');
    expect(intent.target_object.type).toBe('human');
    expect(intent.scenario.name).toBe('eye_shadow_brush');
  });

  test('brand/product lookup does not inherit prior beauty-tools mission', async () => {
    const intent = extractIntentRuleBased('IPSA 流金水', [], [
      { role: 'user', content: 'makeup brush set for foundation and powder' },
      { role: 'assistant', content: 'Sure—here are options.' },
      { role: 'user', content: 'IPSA 流金水' },
    ]);
    expect(intent.scenario.name).not.toBe('beauty_tools');
    expect(intent.scenario.name).not.toBe('eye_shadow_brush');
  });

  test('context query expansion avoids brush terms for brand/product lookup follow-up', async () => {
    const { intent, adjustedPayload } = await buildFindProductsMultiContext({
      payload: {
        search: { query: 'IPSA 流金水' },
        user: { recent_queries: [] },
        messages: [
          { role: 'user', content: 'makeup brush set for foundation and powder' },
          { role: 'assistant', content: 'Sure—here are options.' },
          { role: 'user', content: 'IPSA 流金水' },
        ],
      },
      metadata: {},
    });

    expect(intent.scenario.name).not.toBe('beauty_tools');
    const expanded = String(adjustedPayload?.search?.query || '');
    expect(expanded.toLowerCase()).not.toContain('makeup brush');
    expect(expanded).not.toContain('化妆刷');
  });

  test('sleepwear query routes to human apparel (not pet)', async () => {
    const intent = extractIntentRuleBased('给我推荐一个睡觉很舒服，好看的睡衣', [], []);
    expect(intent.primary_domain).toBe('human_apparel');
    expect(intent.target_object.type).toBe('human');
    expect(intent.scenario.name).toBe('sleepwear');
  });

  test('negated pet mention does not force pet intent', async () => {
    const intent = extractIntentRuleBased('女士睡衣，不是小狗的', [], [
      { role: 'user', content: '我想买一件狗的衣服，我家养了一只边牧' },
      { role: 'assistant', content: '我找到了几件更符合你需求的选择。' },
      { role: 'user', content: '女士睡衣，不是小狗的' },
    ]);
    expect(intent.primary_domain).toBe('human_apparel');
    expect(intent.target_object.type).toBe('human');
    expect(intent.scenario.name).toBe('sleepwear');
  });

  test('sleepwear follow-up keeps sleepwear mission from messages', async () => {
    const intent = extractIntentRuleBased('我要一件春秋穿的', [], [
      { role: 'user', content: '给我推荐一个睡觉很舒服，好看的睡衣' },
      { role: 'assistant', content: '好的，我先给你一些建议。' },
      { role: 'user', content: '我要一件春秋穿的' },
    ]);
    expect(intent.primary_domain).toBe('human_apparel');
    expect(intent.target_object.type).toBe('human');
    expect(intent.scenario.name).toBe('sleepwear');
  });
});
