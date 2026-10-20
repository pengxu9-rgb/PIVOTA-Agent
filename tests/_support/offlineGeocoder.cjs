'use strict';
// Destination and origin geocoding (src/auroraBff/destinationResolver.js, weatherAdapter.js)
// call Open-Meteo through `global.fetch` by default, and some chat paths reach it even with
// AURORA_TRAVEL_WEATHER_LIVE_ENABLED=false. A test that does not stub it either sends the query
// to the real geocoder (and asserts against whatever it answers that day) or, offline, sees a
// network error. This answers the geocoding host as DOWN (HTTP 503), deterministically, and
// leaves every other URL to the real fetch, which the loopback guard still polices.
//
// A test that wants a resolved place still swaps global.fetch for its own stub; this sits
// underneath and comes back when that stub is restored.

const GEOCODER_ORIGIN = 'https://geocoding-api.open-meteo.com/';

function installGeocoderDown() {
  const previous = global.fetch;
  const geocoderDownFetch = async (url, init) => {
    if (String(url && url.href ? url.href : url).startsWith(GEOCODER_ORIGIN)) {
      return new Response('{"error":true,"reason":"geocoder down (test)"}', {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    return previous(url, init);
  };
  global.fetch = geocoderDownFetch;
  return function restore() {
    if (global.fetch === geocoderDownFetch) global.fetch = previous;
  };
}

module.exports = { installGeocoderDown, GEOCODER_ORIGIN };
