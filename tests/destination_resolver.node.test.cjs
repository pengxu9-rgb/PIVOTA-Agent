const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveDestinationQuery } = require('../src/auroraBff/destinationResolver');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test('destination resolver keeps Greenland territory in ambiguous candidates', async () => {
  const out = await resolveDestinationQuery({
    query: 'Greenland',
    userLocale: 'EN',
    fetchImpl: async () =>
      jsonResponse({
        results: [
          {
            name: 'Greenland',
            latitude: 13.25808,
            longitude: -59.57763,
            country_code: 'BB',
            country: 'Barbados',
            admin1: 'Saint Andrew',
            timezone: 'America/Barbados',
            feature_code: 'PPLA',
            population: 623,
          },
          {
            name: 'Greenland',
            latitude: 43.0362,
            longitude: -70.83283,
            country_code: 'US',
            country: 'United States',
            admin1: 'New Hampshire',
            timezone: 'America/New_York',
            feature_code: 'PPL',
            population: 3417,
          },
          {
            name: 'Greenland',
            latitude: 72.0,
            longitude: -40.0,
            country_code: 'GL',
            country: null,
            admin1: null,
            timezone: 'America/Nuuk',
            feature_code: 'PCLD',
            population: 56025,
          },
        ],
      }),
  });

  assert.equal(out.ok, true);
  assert.equal(out.ambiguous, true);
  assert.ok(Array.isArray(out.candidates));
  assert.ok(out.candidates.some((row) => String(row.label || '').trim() === 'Greenland'));
  assert.equal(String(out.candidates[0]?.label || '').trim(), 'Greenland');
});
