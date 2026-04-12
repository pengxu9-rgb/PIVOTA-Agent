describe('recoAlternativesAuthorityBackfill', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../src/db');
  });

  test('dedupes punctuated brand variants into the same backfill job key', () => {
    const backfill = require('../src/auroraBff/recoAlternativesAuthorityBackfill');
    expect(
      backfill._internals.buildBackfillJobKey({ brand: 'Supergoop!', market: 'US' }),
    ).toBe(backfill._internals.buildBackfillJobKey({ brand: 'Supergoop', market: 'US' }));
    expect(
      backfill._internals.buildBackfillJobKey({ brand: "Paula's Choice", market: 'US' }),
    ).toBe(backfill._internals.buildBackfillJobKey({ brand: 'Paulas Choice', market: 'US' }));
  });

  test('resolves source plans for punctuated brands through normalized authority lookups', async () => {
    const query = jest.fn(async (sql, params) => {
      if (sql.includes('FROM pdp_identity_listing')) {
        expect(params[0]).toContain('supergoop!');
        expect(params[1]).toContain('supergoop');
        expect(params[2]).toContain('supergoop');
        return { rows: [] };
      }
      if (sql.includes('FROM external_product_seeds')) {
        expect(params[0]).toContain('supergoop!');
        expect(params[2]).toContain('supergoop');
        expect(params[3]).toContain('supergoop');
        expect(params[1]).toBe('US');
        return {
          rows: [
            {
              domain: 'supergoop.com',
              source_role: 'primary',
              source_url: 'https://supergoop.com',
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    jest.doMock('../src/db', () => ({
      getPool: () => ({}),
      query,
    }));

    const backfill = require('../src/auroraBff/recoAlternativesAuthorityBackfill');
    const result = await backfill._internals.resolveBrandSourcePlanDefault({
      brand: 'Supergoop!',
      market: 'US',
    });

    expect(result).toMatchObject({
      ok: true,
      primaryDomain: 'https://supergoop.com',
      primaryRole: 'primary',
      fallbackDomains: [],
    });
    expect(query).toHaveBeenCalledTimes(2);
  });
});
