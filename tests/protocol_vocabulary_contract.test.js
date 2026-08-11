'use strict';
/**
 * Cross-repo protocol vocabulary — digest-enforced (the content_key #1696/#1942 mechanism).
 *
 * This gateway stamps `protocol_name` onto backend orders (the SPT delegated lane
 * writes DELEGATED_LANE_PROTOCOL) and pivota-backend's Tier-2 kill switch gates
 * charges on exactly that label. contracts/protocol_vocabulary_v1.json is the one
 * shared statement of the vocabulary, owned by pivota-backend and mirrored here
 * byte-identical. BOTH repos pin its sha256, so a vocabulary change anywhere
 * breaks both CIs until the mirror is consciously refreshed.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CORPUS_PATH = path.join(__dirname, '..', 'contracts', 'protocol_vocabulary_v1.json');
// Pinned in BOTH repos (pivota-backend: tests/test_protocol_vocabulary_contract.py).
const CORPUS_SHA256 = 'e4c19342d5ff149de85ed8b5c457cc429fa36eb418dd5fb7af3ab1f20463e1b0';

const EXECUTOR_PATH = path.join(
  __dirname, '..', 'safety-kernel', 'src', 'protocol', 'canonicalExecutor.js',
);

describe('protocol vocabulary is the mirrored cross-repo contract', () => {
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));

  test('the corpus is byte-for-byte the one pivota-backend owns', () => {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(CORPUS_PATH)).digest('hex');
    expect(digest).toBe(CORPUS_SHA256);
  });

  test('the delegated SPT lane writes a protocol the backend kill switch guards', () => {
    const src = fs.readFileSync(EXECUTOR_PATH, 'utf8');
    const m = src.match(/const DELEGATED_LANE_PROTOCOL = '([a-z0-9_]+)';/);
    expect(m).not.toBeNull();
    const lane = m[1];
    expect(lane).toBe(corpus.gateway_delegated_lane_protocol);
    expect(corpus.guarded_protocols).toContain(lane);
  });

  test('the guarded set is the one both repos agreed to', () => {
    // Literal allowlist: any edit to the guarded set must be a conscious,
    // mirrored change, not a drive-by.
    expect([...corpus.guarded_protocols].sort()).toEqual(['acp', 'ap2', 'ucp']);
    expect(corpus.default_protocol).toBe('pdp_direct');
    expect([...corpus.known_protocol_labels].sort()).toEqual([
      'acp_session', 'creator_token', 'mcp_session', 'pdp_direct', 'resume_order', 'ucp_session',
    ]);
  });
});
