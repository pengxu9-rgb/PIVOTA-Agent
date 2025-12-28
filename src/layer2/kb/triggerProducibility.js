const zod = require('zod');
const { z } = zod;

function stableSort(list) {
  return [...list].sort((a, b) => String(a).localeCompare(String(b)));
}

function uniq(list) {
  return Array.from(new Set(list));
}

function splitTriggerKey(key) {
  const raw = String(key || '').trim();
  if (!raw) return [];
  const parts = raw.split('.').filter(Boolean);
  const out = [];
  for (const part of parts) {
    const m = String(part).match(/^(.+)\[\*\]$/);
    if (m) {
      out.push(m[1], '[*]');
      continue;
    }
    out.push(part);
  }
  return out;
}

function parseAllowlist(dictJson) {
  const parsed = z
    .object({
      schemaVersion: z.literal('v0'),
      allowUnproducibleKeys: z.array(z.string().min(1)).default([]),
    })
    .strict()
    .safeParse(dictJson);

  if (!parsed.success) return [];
  return parsed.data.allowUnproducibleKeys.map((s) => String(s).trim()).filter(Boolean);
}

function keyMatchesAllowPattern(key, pattern) {
  const k = String(key || '').trim();
  const p = String(pattern || '').trim();
  if (!k || !p) return false;
  if (p.endsWith('.*')) return k === p.slice(0, -2) || k.startsWith(p.slice(0, -1));
  return k === p;
}

function isAllowlistedKey(key, allowPatterns) {
  for (const p of Array.isArray(allowPatterns) ? allowPatterns : []) {
    if (keyMatchesAllowPattern(key, p)) return true;
  }
  return false;
}

function unwrapZod(schema, stack = new Set()) {
  let cur = schema;
  for (let i = 0; i < 20; i += 1) {
    if (!cur || typeof cur !== 'object') return cur;
    if (stack.has(cur)) return cur;
    stack.add(cur);

    const t = cur?._def?.type;
    if (t === 'optional' || t === 'nullable') {
      cur = cur._def.innerType;
      continue;
    }
    if (t === 'default' || t === 'catch' || t === 'prefault') {
      cur = cur._def.innerType;
      continue;
    }
    if (t === 'readonly' || t === 'branded') {
      cur = cur._def.innerType ?? cur._def.type;
      continue;
    }
    if (t === 'pipe') {
      cur = cur._def.in ?? cur._def.innerType;
      continue;
    }
    if (t === 'transform') {
      cur = cur._def.innerType ?? cur._def.in;
      continue;
    }
    return cur;
  }
  return cur;
}

function getObjectShape(schema) {
  if (!schema) return null;
  if (schema?._def && schema._def.type === 'object' && typeof schema._def.shape === 'object' && schema._def.shape) {
    return schema._def.shape;
  }
  return null;
}

function checkPathInSchema(schema, segments) {
  const segs = Array.isArray(segments) ? segments : [];
  const cur = unwrapZod(schema);
  if (segs.length === 0) return { ok: true };

  const t = cur?._def?.type;

  if (t === 'union') {
    const options = Array.isArray(cur._def.options) ? cur._def.options : [];
    const reasons = [];
    for (const opt of options) {
      const r = checkPathInSchema(opt, segs);
      if (r.ok) return r;
      if (r.reason) reasons.push(r.reason);
    }
    return { ok: false, reason: reasons[0] || 'not_in_union' };
  }

  if (t === 'intersection') {
    const left = checkPathInSchema(cur._def.left, segs);
    if (left.ok) return left;
    const right = checkPathInSchema(cur._def.right, segs);
    if (right.ok) return right;
    return { ok: false, reason: left.reason || right.reason || 'not_in_intersection' };
  }

  if (t === 'object') {
    const shape = getObjectShape(cur) || {};
    const head = segs[0];
    if (head === '[*]') return { ok: false, reason: 'unexpected_array_wildcard' };
    if (!Object.prototype.hasOwnProperty.call(shape, head)) return { ok: false, reason: `missing_field:${head}` };
    return checkPathInSchema(shape[head], segs.slice(1));
  }

  if (t === 'record') {
    const head = segs[0];
    if (head === '[*]') return { ok: false, reason: 'unexpected_array_wildcard' };
    return checkPathInSchema(cur._def.valueType, segs.slice(1));
  }

  if (t === 'array') {
    const head = segs[0];
    if (head !== '[*]') return { ok: false, reason: 'array_requires_[*]' };
    return checkPathInSchema(cur._def.element, segs.slice(1));
  }

  return { ok: false, reason: `non_object_at:${segs[0]}` };
}

function summarizeKeyPrefix(key) {
  const segs = splitTriggerKey(key);
  if (!segs.length) return '(empty)';
  const root = segs[0];
  if (root === 'lookSpec' && segs[1] === 'breakdown' && typeof segs[2] === 'string') {
    return `lookSpec.breakdown.${segs[2]}`;
  }
  return root;
}

function collectTriggerKeysFromCard(card) {
  const triggers = card?.triggers || {};
  const out = [];
  for (const groupKey of ['all', 'any', 'none']) {
    const list = Array.isArray(triggers[groupKey]) ? triggers[groupKey] : [];
    for (const condition of list) {
      const k = String(condition?.key || '').trim();
      if (k) out.push(k);
    }
  }
  return out;
}

function checkTriggerKeyProducible({ key, rootSchemas }) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, reason: 'empty_key' };
  if (k === 'preferenceMode') return { ok: true, reason: null };

  const segs = splitTriggerKey(k);
  const root = segs[0];
  const schemaList = rootSchemas?.[root];
  if (!Array.isArray(schemaList) || schemaList.length === 0) return { ok: false, reason: `unknown_root:${root}` };

  const pathSegs = segs.slice(1);
  for (const schema of schemaList) {
    const r = checkPathInSchema(schema, pathSegs);
    if (r.ok) return { ok: true, reason: null };
  }

  const first = checkPathInSchema(schemaList[0], pathSegs);
  return { ok: false, reason: first.reason || 'not_in_contract' };
}

function buildTriggerProducibilityReport({ market, kbCards, isTriggerKeyAllowed, allowUnproducibleKeys, rootSchemas }) {
  const cards = Array.isArray(kbCards) ? kbCards : [];
  const keyToCards = new Map();
  let cardsWithTriggers = 0;

  for (const card of cards) {
    const keys = collectTriggerKeysFromCard(card);
    if (keys.length) cardsWithTriggers += 1;
    for (const k of keys) {
      if (!keyToCards.has(k)) keyToCards.set(k, new Set());
      keyToCards.get(k).add(String(card.id));
    }
  }

  const uniqueKeys = stableSort(Array.from(keyToCards.keys()));
  const byPrefixCounts = {};
  for (const k of uniqueKeys) {
    const p = summarizeKeyPrefix(k);
    byPrefixCounts[p] = (byPrefixCounts[p] || 0) + 1;
  }

  const unproducible = [];
  const affectedCardSet = new Set();

  for (const k of uniqueKeys) {
    if (isAllowlistedKey(k, allowUnproducibleKeys)) continue;

    const allowed = typeof isTriggerKeyAllowed === 'function' ? Boolean(isTriggerKeyAllowed(k)) : true;
    if (!allowed) {
      const cs = stableSort(Array.from(keyToCards.get(k) || []));
      for (const c of cs) affectedCardSet.add(c);
      unproducible.push({ key: k, reason: 'not_whitelisted', cards: cs });
      continue;
    }

    const prod = checkTriggerKeyProducible({ key: k, rootSchemas });
    if (!prod.ok) {
      const cs = stableSort(Array.from(keyToCards.get(k) || []));
      for (const c of cs) affectedCardSet.add(c);
      unproducible.push({ key: k, reason: prod.reason || 'not_in_contract', cards: cs });
    }
  }

  const unproducibleKeys = [...unproducible].sort((a, b) => a.key.localeCompare(b.key));

  return {
    market,
    summary: {
      kbCardCount: cards.length,
      cardsWithTriggers,
      uniqueTriggerKeys: uniqueKeys.length,
      unproducibleKeysCount: unproducibleKeys.length,
      cardsAffectedCount: affectedCardSet.size,
    },
    unproducibleKeys,
    byPrefixCounts,
    notes: ['This report is about producibility from contracts, not about actual model accuracy.'],
  };
}

module.exports = {
  splitTriggerKey,
  parseAllowlist,
  isAllowlistedKey,
  checkPathInSchema,
  checkTriggerKeyProducible,
  buildTriggerProducibilityReport,
  collectTriggerKeysFromCard,
};
