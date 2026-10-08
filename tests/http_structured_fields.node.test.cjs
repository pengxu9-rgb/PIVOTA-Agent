'use strict';

// RFC 8941 parsing and serialization for the headers inbound agent signatures carry (Signature-Input,
// Signature, Signature-Agent). The serializer is load-bearing: RFC 9421 builds "@signature-params" from
// it, so a token printed as a string (or the reverse) breaks every signature that uses that parameter.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDictionary,
  parseItem,
  serializeInnerList,
  serializeMember,
  StructuredFieldError,
} = require('../src/services/httpStructuredFields');

test('Signature-Input member round-trips byte for byte, keeping string vs token types', () => {
  const raw = 'sig1=("@authority" "signature-agent";key="sig1");created=1700000000;expires=1700011111;keyid="ba3e64==";tag="web-bot-auth"';
  const dict = parseDictionary(raw);
  const member = dict.get('sig1');
  assert.equal(member.type, 'inner_list');
  assert.equal(member.value.length, 2);
  assert.equal(member.value[1].params.get('key').value, 'sig1');
  assert.equal(member.params.get('created').type, 'integer');
  assert.equal(member.params.get('tag').type, 'string');
  assert.equal(`sig1=${serializeInnerList(member)}`, raw);
});

test('a token parameter serializes without quotes and a string with them', () => {
  const tokenTag = parseDictionary('s=();tag=web-bot-auth').get('s');
  const stringTag = parseDictionary('s=();tag="web-bot-auth"').get('s');
  assert.equal(serializeInnerList(tokenTag), '();tag=web-bot-auth');
  assert.equal(serializeInnerList(stringTag), '();tag="web-bot-auth"');
});

test('OWS around dictionary members is tolerated; a whitespace-only gap inside an inner list is canonicalised', () => {
  const dict = parseDictionary('a=("x"  "y");created=1 ,  b=:aGVsbG8=:');
  assert.equal(serializeInnerList(dict.get('a')), '("x" "y");created=1');
  assert.equal(dict.get('b').type, 'bytes');
  assert.equal(dict.get('b').value.toString('utf8'), 'hello');
});

test('Signature-Agent dictionary member with a type token, and the legacy bare-string form', () => {
  const dict = parseDictionary('sig1="https://signature-agent.test/jwks.json";type=jwks_uri');
  const m = dict.get('sig1');
  assert.equal(m.type, 'string');
  assert.equal(m.params.get('type').type, 'token');
  assert.equal(serializeMember(m), '"https://signature-agent.test/jwks.json";type=jwks_uri');
  const legacy = parseItem('"https://signer.example.com"');
  assert.equal(legacy.value, 'https://signer.example.com');
});

test('escapes in strings round-trip', () => {
  const item = parseItem('"a\\"b\\\\c"');
  assert.equal(item.value, 'a"b\\c');
  assert.equal(serializeMember(item), '"a\\"b\\\\c"');
});

test('decimals, booleans and negative integers parse and serialize per RFC 8941', () => {
  const d = parseDictionary('a=1.50, b=?0, c=-42, d');
  assert.equal(serializeMember(d.get('a')), '1.5');
  assert.equal(serializeMember(d.get('b')), '?0');
  assert.equal(serializeMember(d.get('c')), '-42');
  assert.equal(d.get('d').value, true);
});

test('malformed inputs throw instead of parsing to something else', () => {
  const bad = [
    'Sig1=()', // uppercase key — also how a "keyId" parameter fails (TAP's sample code sends one)
    's=();keyId="x"',
    's=("a")junk',
    's=("a",  "b")',
    's=("a""b")', // inner-list items must be separated by SP
    's="unterminated',
    's=:not base64!:',
    's=1,',
    's=1234567890123456',
    's=1.2345',
    's="café"',
  ];
  for (const raw of bad) {
    assert.throws(() => parseDictionary(raw), StructuredFieldError, raw);
  }
  assert.throws(() => parseDictionary(undefined), StructuredFieldError);
});
