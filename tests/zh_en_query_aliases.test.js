const test = require('node:test');
const assert = require('node:assert');

const {
  expandQueryWithZhAlias,
  ZH_EN_ALIASES,
} = require('../src/findProductsMulti/zhEnQueryAliases');

test('returns input unchanged when empty', () => {
  assert.deepStrictEqual(expandQueryWithZhAlias(''), {
    query: '',
    aliases_applied: false,
    alias_terms: [],
  });
});

test('returns input unchanged for pure-ASCII queries', () => {
  const out = expandQueryWithZhAlias('lipstick under $30');
  assert.strictEqual(out.aliases_applied, false);
  assert.strictEqual(out.query, 'lipstick under $30');
  assert.deepStrictEqual(out.alias_terms, []);
});

test('returns input unchanged for CJK without dict match', () => {
  const out = expandQueryWithZhAlias('随便看看');
  assert.strictEqual(out.aliases_applied, false);
  assert.strictEqual(out.query, '随便看看');
});

test('appends EN alias for bare ZH category noun', () => {
  const out = expandQueryWithZhAlias('口红');
  assert.strictEqual(out.aliases_applied, true);
  assert.strictEqual(out.query, '口红 lipstick');
  assert.deepStrictEqual(out.alias_terms, [{ zh: '口红', en: 'lipstick' }]);
});

test('preserves descriptors around the matched ZH term', () => {
  const out = expandQueryWithZhAlias('便宜的口红');
  assert.strictEqual(out.aliases_applied, true);
  assert.strictEqual(out.query, '便宜的口红 lipstick');
});

test('multiple ZH terms — appends each alias once, longest-first', () => {
  const out = expandQueryWithZhAlias('卫衣和跑鞋');
  assert.strictEqual(out.aliases_applied, true);
  // 卫衣 → "hoodie sweatshirt", 跑鞋 → "running shoes"
  assert.strictEqual(out.query, '卫衣和跑鞋 hoodie sweatshirt running shoes');
  assert.strictEqual(out.alias_terms.length, 2);
});

test('prefers longer ZH match (气垫粉底 over 气垫 alone)', () => {
  const out = expandQueryWithZhAlias('气垫粉底');
  assert.strictEqual(out.aliases_applied, true);
  // dict has both 气垫 and 气垫粉底; longest-first should keep cushion foundation only
  // (not duplicate 'cushion foundation' twice via 气垫 + 气垫粉底)
  assert.ok(out.query.includes('cushion foundation'));
  assert.strictEqual(out.alias_terms.length, 1);
  assert.strictEqual(out.alias_terms[0].zh, '气垫粉底');
});

test('dict shape — every key maps to a non-empty EN string', () => {
  for (const [zh, en] of Object.entries(ZH_EN_ALIASES)) {
    assert.ok(typeof en === 'string' && en.trim().length > 0,
      `alias ${zh} → ${en} is empty`);
  }
});

test('dict covers the ZH probe queries that returned EMPTY in v1', () => {
  // From reports/recall_v1/recall_v1_1778046918 — every ZH query that the
  // probe flagged as EMPTY (except 防晒霜 which was already PASS) should now
  // produce an alias expansion.
  const probeFailures = [
    '推荐口红', '口红', '平价口红', '适合黄皮的口红', '哑光口红',
    '气垫粉底', '控油遮瑕粉底液',
    '睫毛膏', '防水睫毛膏',
    '精华', '面霜',
    '木质香水', '小众淡香水',
    '卫衣', '亚麻连衣裙',
    '跑鞋',
    '蓝牙耳机', '电子阅读器',
    '加湿器', '保温杯',
  ];
  for (const q of probeFailures) {
    const out = expandQueryWithZhAlias(q);
    assert.strictEqual(out.aliases_applied, true,
      `expected alias to fire for probe-failed query "${q}"`);
  }
});
