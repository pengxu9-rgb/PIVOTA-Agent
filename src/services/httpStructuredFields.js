'use strict';

// RFC 8941 Structured Field Values — the subset HTTP Message Signatures (RFC 9421) needs on the way IN.
//
// Written for inbound agent-signature verification (agentSignatureVerifier.js). Signature-Input,
// Signature and Signature-Agent are Dictionaries, and RFC 9421 §2.3 defines the "@signature-params"
// line of the signature base as the SERIALIZATION of the parsed Signature-Input member — so a
// verifier needs both a parser and a byte-exact serializer, and they have to agree on types (a Token
// and a String with the same characters serialize differently: `tag=web-bot-auth` vs
// `tag="web-bot-auth"`, and only one of them is what the agent signed).
//
// Values are typed so that round trip holds: every bare item is { type, value } with type one of
// integer | decimal | string | token | bytes | boolean. Parsers THROW a SyntaxError on any input
// RFC 8941 says to fail on; callers treat that as "malformed header", never as "absent".
//
// Not a general-purpose SF library: no Lists at the top level (nothing here sends one), no Date or
// Display String (RFC 9651) types.

class StructuredFieldError extends SyntaxError {}

function fail(msg) {
  throw new StructuredFieldError(msg);
}

const LCALPHA = /[a-z]/;
const DIGIT = /[0-9]/;
const ALPHA = /[A-Za-z]/;
const KEY_CHAR = /[a-z0-9_\-.*]/;
// tchar (RFC 9110 §5.6.2) plus ":" and "/" — the characters RFC 8941 §3.3.4 allows after a token's first.
const TOKEN_CHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z:/]/;
const BASE64_CHAR = /[A-Za-z0-9+/=]/;

class Parser {
  constructor(input) {
    this.s = String(input);
    this.i = 0;
  }

  peek() {
    return this.s[this.i];
  }

  eof() {
    return this.i >= this.s.length;
  }

  discardSP() {
    while (this.s[this.i] === ' ') this.i += 1;
  }

  discardOWS() {
    while (this.s[this.i] === ' ' || this.s[this.i] === '\t') this.i += 1;
  }

  parseKey() {
    const c = this.peek();
    if (c === undefined || !(LCALPHA.test(c) || c === '*')) fail(`key must start with lcalpha or "*" at ${this.i}`);
    let out = '';
    while (!this.eof() && KEY_CHAR.test(this.peek())) {
      out += this.s[this.i];
      this.i += 1;
    }
    return out;
  }

  parseParameters() {
    const params = new Map();
    while (this.peek() === ';') {
      this.i += 1;
      this.discardSP();
      const key = this.parseKey();
      let value = { type: 'boolean', value: true };
      if (this.peek() === '=') {
        this.i += 1;
        value = this.parseBareItem();
      }
      params.set(key, value); // RFC 8941: a later duplicate key overwrites the earlier one
    }
    return params;
  }

  parseBareItem() {
    const c = this.peek();
    if (c === undefined) fail('unexpected end of input, expected an item');
    if (c === '-' || DIGIT.test(c)) return this.parseNumber();
    if (c === '"') return this.parseString();
    if (c === '*' || ALPHA.test(c)) return this.parseToken();
    if (c === ':') return this.parseByteSequence();
    if (c === '?') return this.parseBoolean();
    return fail(`unexpected character ${JSON.stringify(c)} at ${this.i}`);
  }

  parseNumber() {
    let sign = 1;
    if (this.peek() === '-') {
      sign = -1;
      this.i += 1;
    }
    if (this.eof() || !DIGIT.test(this.peek())) fail('number must have a digit');
    let num = '';
    let isDecimal = false;
    while (!this.eof()) {
      const c = this.peek();
      if (DIGIT.test(c)) {
        num += c;
      } else if (c === '.' && !isDecimal) {
        if (num.length > 12) fail('decimal integer part too long');
        num += c;
        isDecimal = true;
      } else {
        break;
      }
      this.i += 1;
      if (!isDecimal && num.length > 15) fail('integer too long');
      if (isDecimal && num.length > 16) fail('decimal too long');
    }
    if (!isDecimal) return { type: 'integer', value: sign * Number.parseInt(num, 10) };
    if (num.endsWith('.')) fail('decimal must not end with "."');
    if (num.split('.')[1].length > 3) fail('decimal has more than 3 fractional digits');
    return { type: 'decimal', value: sign * Number.parseFloat(num) };
  }

  parseString() {
    this.i += 1; // opening quote
    let out = '';
    while (!this.eof()) {
      const c = this.s[this.i];
      this.i += 1;
      if (c === '\\') {
        if (this.eof()) fail('unterminated escape');
        const next = this.s[this.i];
        this.i += 1;
        if (next !== '"' && next !== '\\') fail('invalid escape in string');
        out += next;
      } else if (c === '"') {
        return { type: 'string', value: out };
      } else {
        const code = c.charCodeAt(0);
        if (code < 0x20 || code > 0x7e) fail('string contains a non-printable or non-ASCII character');
        out += c;
      }
    }
    return fail('unterminated string');
  }

  parseToken() {
    let out = this.s[this.i];
    this.i += 1;
    while (!this.eof() && TOKEN_CHAR.test(this.peek())) {
      out += this.s[this.i];
      this.i += 1;
    }
    return { type: 'token', value: out };
  }

  parseByteSequence() {
    this.i += 1; // opening colon
    const end = this.s.indexOf(':', this.i);
    if (end === -1) fail('unterminated byte sequence');
    const b64 = this.s.slice(this.i, end);
    this.i = end + 1;
    for (const ch of b64) if (!BASE64_CHAR.test(ch)) fail('invalid base64 in byte sequence');
    return { type: 'bytes', value: Buffer.from(b64, 'base64') };
  }

  parseBoolean() {
    this.i += 1; // "?"
    const c = this.peek();
    if (c === '1' || c === '0') {
      this.i += 1;
      return { type: 'boolean', value: c === '1' };
    }
    return fail('invalid boolean');
  }

  parseItem() {
    const bare = this.parseBareItem();
    return { ...bare, params: this.parseParameters() };
  }

  parseInnerList() {
    this.i += 1; // "("
    const items = [];
    while (!this.eof()) {
      this.discardSP();
      if (this.peek() === ')') {
        this.i += 1;
        return { type: 'inner_list', value: items, params: this.parseParameters() };
      }
      items.push(this.parseItem());
      const c = this.peek();
      if (c !== ' ' && c !== ')') fail('inner list items must be separated by SP');
    }
    return fail('unterminated inner list');
  }

  parseItemOrInnerList() {
    return this.peek() === '(' ? this.parseInnerList() : this.parseItem();
  }

  parseDictionary() {
    const dict = new Map();
    while (!this.eof()) {
      const key = this.parseKey();
      let member;
      if (this.peek() === '=') {
        this.i += 1;
        member = this.parseItemOrInnerList();
      } else {
        member = { type: 'boolean', value: true, params: this.parseParameters() };
      }
      dict.set(key, member);
      this.discardOWS();
      if (this.eof()) return dict;
      if (this.peek() !== ',') fail(`expected "," at ${this.i}`);
      this.i += 1;
      this.discardOWS();
      if (this.eof()) fail('trailing comma in dictionary');
    }
    return dict;
  }
}

function prepare(input) {
  if (input == null) fail('field is absent');
  // A field sent on several lines reaches us comma-joined (Node joins unknown repeated headers with
  // ", "), which is exactly the RFC 8941 §4.2 combination rule.
  return String(Array.isArray(input) ? input.join(', ') : input).replace(/^ +| +$/g, '');
}

function parseDictionary(input) {
  const p = new Parser(prepare(input));
  const dict = p.parseDictionary();
  p.discardSP();
  if (!p.eof()) fail('trailing characters after dictionary');
  return dict;
}

function parseItem(input) {
  const p = new Parser(prepare(input));
  const item = p.parseItem();
  p.discardSP();
  if (!p.eof()) fail('trailing characters after item');
  return item;
}

// ---- serialization (RFC 8941 §4.1) ------------------------------------------------------------------

function serializeBareItem(item) {
  switch (item.type) {
    case 'integer':
      if (!Number.isInteger(item.value) || Math.abs(item.value) > 999_999_999_999_999) fail('integer out of range');
      return String(item.value);
    case 'decimal': {
      const rounded = Math.round(item.value * 1000) / 1000;
      let s = rounded.toFixed(3).replace(/0+$/, '');
      if (s.endsWith('.')) s += '0';
      return s;
    }
    case 'string': {
      let out = '"';
      for (const c of item.value) {
        const code = c.charCodeAt(0);
        if (code < 0x20 || code > 0x7e) fail('string contains a non-printable or non-ASCII character');
        out += c === '"' || c === '\\' ? `\\${c}` : c;
      }
      return `${out}"`;
    }
    case 'token':
      return item.value;
    case 'bytes':
      return `:${Buffer.from(item.value).toString('base64')}:`;
    case 'boolean':
      return item.value ? '?1' : '?0';
    default:
      return fail(`cannot serialize item of type ${item.type}`);
  }
}

function serializeParameters(params) {
  let out = '';
  for (const [key, value] of params || new Map()) {
    out += `;${key}`;
    if (!(value.type === 'boolean' && value.value === true)) out += `=${serializeBareItem(value)}`;
  }
  return out;
}

function serializeItem(item) {
  return serializeBareItem(item) + serializeParameters(item.params);
}

function serializeInnerList(list) {
  return `(${list.value.map(serializeItem).join(' ')})${serializeParameters(list.params)}`;
}

function serializeMember(member) {
  if (member.type === 'inner_list') return serializeInnerList(member);
  // RFC 8941 §4.1.2: a Boolean true member is serialized as its parameters alone.
  if (member.type === 'boolean' && member.value === true) return serializeParameters(member.params);
  return serializeItem(member);
}

/**
 * A Dictionary member's VALUE as RFC 9421 §2.1.2 needs it for a `;key` component: the member serialized
 * as an Item (or Inner List). Unlike dictionary serialization, a Boolean true member is `?1`, not empty —
 * RFC 9421's own example: `"example-dict";key="d": ?1`.
 */
function serializeMemberValue(member) {
  return member.type === 'inner_list' ? serializeInnerList(member) : serializeItem(member);
}

module.exports = {
  StructuredFieldError,
  serializeMemberValue,
  parseDictionary,
  parseItem,
  serializeItem,
  serializeInnerList,
  serializeMember,
  serializeParameters,
};
