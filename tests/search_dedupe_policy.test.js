describe('search dedupe policy', () => {
  let app;

  beforeAll(() => {
    jest.resetModules();
    app = require('../src/server');
  });

  test('beauty scenario query allows more same-title variants', () => {
    const limit = app._debug.resolveSearchDedupePerTitleLimit({
      queryText: '约会妆',
      intent: {
        primary_domain: 'beauty',
        scenario: { name: 'general' },
        query_class: 'scenario',
      },
      queryClass: 'scenario',
    });
    expect(limit).toBe(3);
  });

  test('beauty non-scenario query keeps moderate dedupe', () => {
    const limit = app._debug.resolveSearchDedupePerTitleLimit({
      queryText: '化妆刷',
      intent: {
        primary_domain: 'beauty',
        scenario: { name: 'beauty_tools' },
        query_class: 'category',
      },
      queryClass: 'category',
    });
    expect(limit).toBe(2);
  });

  test('lookup query keeps strict dedupe', () => {
    const limit = app._debug.resolveSearchDedupePerTitleLimit({
      queryText: 'ipsa',
      intent: {
        primary_domain: 'beauty',
        scenario: { name: 'general' },
        query_class: 'lookup',
      },
      queryClass: 'lookup',
    });
    expect(limit).toBe(1);
  });
});
