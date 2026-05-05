const assert = require('node:assert/strict');
const test = require('node:test');
const { OperationEnum } = require('../src/schema');
const { getProductEntityIndexFeed } = require('../src/services/productEntityIndexFeed');

test('ProductEntity index feed operation is accepted by invoke schema', () => {
  assert.equal(OperationEnum.safeParse('get_product_entity_index_feed').success, true);
});

test('ProductEntity index feed pages approved canonical sig mappings only', async () => {
  const calls = [];
  const result = await getProductEntityIndexFeed(
    { limit: 2, page: 1, market: 'US', tool: 'creator_agents' },
    {
      query: async (sql, params) => {
        calls.push({ sql, params });
        assert.match(sql, /external_product_seeds/);
        assert.match(sql, /pdp_identity_listing/);
        return {
          rows: [
            {
              product_entity_id: 'sig_alpha',
              source_product_id: 'ext_alpha',
              external_product_id: 'ext_alpha',
              product_name: 'Alpha Serum',
              title: 'Alpha Serum',
              brand: 'Alpha Brand',
              category: 'Serum',
              seed_data: {
                title: 'Alpha Serum',
                brand: 'Alpha Brand',
                category: 'Serum',
                description: 'A real product description.',
              },
              source_updated_at: '2026-05-01T00:00:00.000Z',
              total_rows: 3,
            },
            {
              product_entity_id: 'sig_beta',
              source_product_id: 'ext_beta',
              external_product_id: 'ext_beta',
              product_name: 'Beta Cleanser',
              title: 'Beta Cleanser',
              brand: 'Beta Brand',
              category: 'Cleanser',
              seed_data: {
                title: 'Beta Cleanser',
                brand: 'Beta Brand',
                category: 'Cleanser',
                description: 'A real product description.',
              },
              source_updated_at: '2026-05-02T00:00:00.000Z',
              total_rows: 3,
            },
          ],
        };
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [false, 'US', 'creator_agents', 2, 0]);
  assert.equal(result.status, 'success');
  assert.equal(result.products.length, 2);
  assert.equal(result.products[0].product_entity_id, 'sig_alpha');
  assert.equal(result.products[0].sellable_item_group_id, 'sig_alpha');
  assert.equal(result.products[0].product_id, 'ext_alpha');
  assert.equal(result.cursor_info.has_next_page, true);
  assert.ok(result.cursor_info.next_cursor);
});

test('ProductEntity index feed cursor advances offset', async () => {
  const first = await getProductEntityIndexFeed(
    { limit: 1 },
    {
      query: async () => ({
        rows: [
          {
            product_entity_id: 'sig_alpha',
            source_product_id: 'ext_alpha',
            title: 'Alpha Serum',
            seed_data: { title: 'Alpha Serum', brand: 'Alpha Brand' },
            total_rows: 2,
          },
        ],
      }),
    },
  );
  const offsets = [];
  await getProductEntityIndexFeed(
    { limit: 1, cursor: first.cursor_info.next_cursor },
    {
      query: async (_sql, params) => {
        offsets.push(params[4]);
        return { rows: [] };
      },
    },
  );
  assert.deepEqual(offsets, [1]);
});
