const test = require('node:test');
const assert = require('node:assert/strict');

const { getTravelAlerts, __internal } = require('../src/auroraBff/travelAlertsProvider');

test('travelAlertsProvider: decodeRot13 decodes mfsession token', () => {
  assert.equal(__internal.decodeRot13('uryyb123'), 'hello123');
});

test('travelAlertsProvider: extract token from set-cookie headers and decode', () => {
  const headers = {
    getSetCookie() {
      return ['foo=bar; Path=/', 'mfsession=uryyb123; Path=/; Secure'];
    },
  };
  const token = __internal.extractMeteoFranceTokenFromHeaders(headers);
  assert.equal(token, 'hello123');
});

test('travelAlertsProvider: buildAlertsFromPayload normalizes severity/title/time window', () => {
  const warningFull = {
    comments: { text: ['Moderate flooding warning'] },
    end_validity_time: 1700007200,
    update_time: 1700000000,
    timelaps: [
      {
        phenomenon_id: '2',
        timelaps_items: [{ begin_time: 1700001000, end_time: 1700004600 }],
      },
    ],
    phenomenons_items: [{ phenomenon_id: '2', phenomenon_max_color_id: 2 }],
  };
  const dictionary = {
    phenomenons: [{ id: '2', name: 'Flood' }],
  };
  const alerts = __internal.buildAlertsFromPayload({
    warningFull,
    dictionary,
    destinationLabel: 'Paris',
    language: 'EN',
  });

  assert.equal(Array.isArray(alerts), true);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'yellow');
  assert.match(String(alerts[0].title || ''), /Flood/i);
  assert.ok(typeof alerts[0].start_at === 'string' && alerts[0].start_at.includes('T'));
  assert.ok(typeof alerts[0].end_at === 'string' && alerts[0].end_at.includes('T'));
});

test('travelAlertsProvider: buildAlertsFromPayload dedupes duplicate windows and annotates non-local summary', () => {
  const warningFull = {
    comments: { text: ['Crues importantes en cours sur la Charente et la Loire aval.'] },
    end_validity_time: 1700007200,
    update_time: 1700000000,
    timelaps: [
      {
        phenomenon_id: '2',
        timelaps_items: [{ begin_time: 1700001000, end_time: 1700004600 }],
      },
      {
        phenomenon_id: '7',
        timelaps_items: [{ begin_time: 1700001000, end_time: 1700004600 }],
      },
    ],
    phenomenons_items: [
      { phenomenon_id: '2', phenomenon_max_color_id: 3 },
      { phenomenon_id: '7', phenomenon_max_color_id: 2 },
    ],
  };
  const dictionary = {
    phenomenons: [
      { id: '2', name: 'Flood' },
      { id: '7', name: 'Avalanche' },
    ],
  };
  const alerts = __internal.buildAlertsFromPayload({
    warningFull,
    dictionary,
    destinationLabel: 'Paris',
    language: 'EN',
  });

  assert.equal(Array.isArray(alerts), true);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'orange');
  assert.match(String(alerts[0].summary || ''), /Regional alert/i);
  assert.match(String(alerts[0].action_hint || ''), /exact area in Paris/i);
});

test('travelAlertsProvider: unsupported country returns source=none without fetch', async () => {
  const result = await getTravelAlerts({
    destination: 'Tokyo',
    destinationCountry: 'JP',
    language: 'EN',
    fetchImpl: async () => {
      throw new Error('should_not_call_fetch');
    },
  });

  assert.equal(result.source, 'none');
  assert.equal(result.reason, 'unsupported_country');
  assert.equal(Array.isArray(result.alerts), true);
  assert.equal(result.alerts.length, 0);
});
