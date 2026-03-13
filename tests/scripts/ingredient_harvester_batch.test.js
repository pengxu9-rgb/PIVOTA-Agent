const { exportUrl, getDefaultBaseUrl } = require('../../scripts/ingredient-harvester-batch');

describe('ingredient-harvester-batch', () => {
  test('prefers explicit harvester base URL when configured', () => {
    expect(
      getDefaultBaseUrl({
        INGREDIENT_HARVESTER_BASE_URL: 'https://harvester.example.com/api/ingredient-harvester/',
        CATALOG_INTELLIGENCE_BASE_URL: 'https://catalog.example.com/',
      }),
    ).toBe('https://harvester.example.com/api/ingredient-harvester');
  });

  test('derives harvester proxy URL from catalog-intelligence base URL', () => {
    expect(
      getDefaultBaseUrl({
        CATALOG_INTELLIGENCE_BASE_URL: 'https://catalog.example.com/',
      }),
    ).toBe('https://catalog.example.com/api/ingredient-harvester');
  });

  test('falls back to local default when no environment override is present', () => {
    expect(getDefaultBaseUrl({})).toBe('http://localhost:3001/api/ingredient-harvester');
  });

  test('builds reviewed export URL when mode is provided', () => {
    expect(
      exportUrl('imp_123', 'csv', 'https://catalog.example.com/api/ingredient-harvester', 'reviewed'),
    ).toBe('https://catalog.example.com/api/ingredient-harvester/v1/exports/imp_123?format=csv&mode=reviewed');
  });
});
