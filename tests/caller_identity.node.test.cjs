'use strict';

// The point of caller_class is that "did anything but us call?" becomes a
// countable query. These pin the distinctions that make the count trustworthy —
// above all that OUR OWN probes never read as external traffic, which is the
// mistake the unattributable /mcp hits invited on 2026-07-31.

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyCaller, describeCaller } = require('../src/services/callerIdentity');

test('real AI agents classify as ai_agent', () => {
  for (const ua of [
    'Mozilla/5.0 AppleWebKit (compatible; ChatGPT-User/1.0; +https://openai.com/bot)',
    'OAI-SearchBot/1.0', 'PerplexityBot/1.0', 'Claude-User/1.0',
    'GPTBot/1.2', 'ClaudeBot/1.0', 'mcp-client/0.3', 'Cursor/1.0',
  ]) {
    assert.equal(classifyCaller({ userAgent: ua }), 'ai_agent', ua);
  }
});

test('our own tooling never counts as external', () => {
  for (const ua of ['curl/8.4.0', 'python-requests/2.31', 'pivota-aeo-probe/1', 'node-fetch/3']) {
    assert.equal(classifyCaller({ userAgent: ua }), 'self_tooling', ua);
  }
});

test('an agent runtime embedding a generic client still reads as ai_agent', () => {
  // Ordering guard: ai_agent is checked BEFORE self_tooling, so a UA carrying
  // both markers is not misfiled as ours and under-counted.
  assert.equal(
    classifyCaller({ userAgent: 'python-requests/2.31 langchain/0.2' }),
    'ai_agent',
  );
});

test('browsers split on Origin, and scanners are filtered by path', () => {
  assert.equal(classifyCaller({ userAgent: 'Mozilla/5.0 (Macintosh)' }), 'browser');
  assert.equal(
    classifyCaller({ userAgent: 'Mozilla/5.0 (Macintosh)', origin: 'https://agent.pivota.cc' }),
    'browser_app',
  );
  // The internet-background-noise class seen live: /.env, /wap-api/*, /xy/*
  assert.equal(classifyCaller({ userAgent: 'Mozilla/5.0', path: '/.env' }), 'scanner');
  assert.equal(classifyCaller({ userAgent: '', path: '/wap-api/banner/list' }), 'scanner');
});

test('a UA-less caller is distinguished by whether it authenticated', () => {
  assert.equal(classifyCaller({ userAgent: '' }), 'unknown');
  assert.equal(classifyCaller({ userAgent: '', hasKey: true }), 'unknown_authed');
});

test('describeCaller never logs a secret and truncates attacker-controlled text', () => {
  const req = {
    path: '/mcp',
    headers: {
      'user-agent': 'X'.repeat(500),
      origin: 'https://example.com',
      'x-pivota-internal-key': 'SUPERSECRET-do-not-log',
      authorization: 'Bearer also-secret',
    },
  };
  const out = describeCaller(req);
  const blob = JSON.stringify(out);
  assert.ok(!blob.includes('SUPERSECRET'), 'key value leaked into the log record');
  assert.ok(!blob.includes('also-secret'), 'authorization leaked into the log record');
  assert.equal(out.authed, true, 'presence of a key must still be observable');
  assert.equal(out.ua.length, 160, 'UA must be truncated');
});
