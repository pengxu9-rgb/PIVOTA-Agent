const { Client } = require('pg');
const { buildCanonicalSearchQualitySql } = require('../../src/services/canonicalSearchQualitySql');
const { buildSearchQualityContract } = require('../../src/findProductsMulti/queryUnderstanding');
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
(url ? describe : describe.skip)('mixed-brand primary candidate domain in PostgreSQL', () => {
  let db;
  beforeAll(async () => { db = new Client({ connectionString: url }); await db.connect(); });
  afterAll(async () => { await db?.end(); });
  test.each(["Victoria's Secret", 'Chanel', 'Giorgio Armani'])(
    '%s brand browsing cannot spend its candidate limit on clothing', async (rawQuery) => {
      const contract = buildSearchQualityContract({ rawQuery });
      expect(contract.target_domain).toBe('beauty');
      expect(contract.query_class).toBe('brand_browse');
      const params = ['probe', '%probe%'];
      const scope = buildCanonicalSearchQualitySql({ contract, params, categoryPredicate: '', defaultWhere: 'FALSE', defaultBrandWhere: '' });
      const brand = contract.hard_constraints.brand.canonical;
      const rows = [
        ...Array.from({ length: 220 }, (_, i) => ({ id: `clothing_${i}`, title: 'Everyday Bra', brand,
          category_path: 'fashion/underwear', product_type: 'Bra', freshness: i + 10,
          product_payload: { description: 'Wear this with our signature perfume and body mist' } })),
        { id: 'perfume', title: 'Signature Eau de Parfum', brand, category_path: 'beauty/fragrance',
          product_type: 'Perfume', freshness: 1, product_payload: {} },
      ];
      params.push(JSON.stringify(rows));
      // Execute the same WHERE fragment the main service applies before its
      // candidate LIMIT. All rows tie on brand rank; new clothing would win
      // its recency tie-break if the domain predicate were missing.
      const sql = `SELECT $1::text, p.id FROM jsonb_to_recordset($${params.length}::jsonb)
        AS p(id text, title text, brand text, category_path text, product_type text, freshness integer, product_payload jsonb)
        WHERE ${scope.where} ${scope.brandWhere} ORDER BY freshness DESC LIMIT 25`;
      const result = await db.query(sql, params);
      expect(result.rows.map(row => row.id)).toEqual(['perfume']);
    });
});
