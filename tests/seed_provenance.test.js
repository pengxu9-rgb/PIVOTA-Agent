'use strict';
/* Fix Plan D · T3 — tests for structured discovery provenance. */

const p = require('../src/services/seedProvenance');

describe('inferChannelFromHost', () => {
  test.each([
    ['https://www.ulta.com/p/x', 'ulta'],
    ['https://global.oliveyoung.com/product/detail?prdtNo=1', 'olive_young'],
    ['https://oliveyoung.co.kr/store/x', 'olive_young'],
    ['https://www.sephora.com/product/y', 'sephora'],
    ['https://www.target.com/p/z', 'target'],
    ['https://www.amazon.com/dp/ABC', 'amazon'],
    ['https://cosrx.com/products/essence', ''],
    ['', ''],
  ])('inferChannelFromHost(%p) -> %p', (url, expected) => {
    expect(p.inferChannelFromHost(url)).toBe(expected);
  });
});

describe('buildDiscoveredVia', () => {
  test('explicit channel wins and stamps evidence + host + at', () => {
    const dv = p.buildDiscoveredVia({ channel: 'ulta', evidenceUrl: 'https://www.ulta.com/p/1' });
    expect(dv.channel).toBe('ulta');
    expect(dv.evidence_url).toBe('https://www.ulta.com/p/1');
    expect(dv.source_host).toBe('ulta.com');
    expect(typeof dv.at).toBe('string');
  });
  test('channel inferred from evidence URL when not given', () => {
    expect(p.buildDiscoveredVia({ evidenceUrl: 'https://global.oliveyoung.com/x' }).channel).toBe('olive_young');
  });
  test('falls back to agent_search when host is a brand site', () => {
    expect(p.buildDiscoveredVia({ evidenceUrl: 'https://cosrx.com/p/1' }).channel).toBe('agent_search');
  });
  test('honours a brand_site fallback', () => {
    expect(p.buildDiscoveredVia({ evidenceUrl: 'https://cosrx.com/p/1', fallback: 'brand_site' }).channel).toBe('brand_site');
  });
});

describe('applyDiscoveredViaToSeedData', () => {
  test('adds discovered_via to seed_data and snapshot, immutably', () => {
    const seed = { brand: 'COSRX', snapshot: { brand: 'COSRX' } };
    const dv = p.buildDiscoveredVia({ channel: 'ulta', evidenceUrl: 'https://ulta.com/p/1' });
    const out = p.applyDiscoveredViaToSeedData(seed, dv);
    expect(out.discovered_via.channel).toBe('ulta');
    expect(out.snapshot.discovered_via.channel).toBe('ulta');
    expect(seed.discovered_via).toBeUndefined(); // original untouched
  });
  test('no-op when already present (unless overwrite)', () => {
    const seed = { discovered_via: { channel: 'olive_young' } };
    const dv = p.buildDiscoveredVia({ channel: 'ulta' });
    expect(p.applyDiscoveredViaToSeedData(seed, dv).discovered_via.channel).toBe('olive_young');
    expect(p.applyDiscoveredViaToSeedData(seed, dv, { overwrite: true }).discovered_via.channel).toBe('ulta');
  });
});
