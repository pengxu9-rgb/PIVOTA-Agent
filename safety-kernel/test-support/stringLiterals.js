// Every string a JavaScript source file writes: its '…' and "…" literals, and the text parts of its `…` templates (the
// parts around each ${…} joined by a space). Comments and regular-expression literals are skipped. A small lexer, not a
// parser: enough for this repository's own source, which the scan in safety-kernel/test/noEffectWordsGated.test.js reads.
// Kept OUT of test/ so `node --test` does not run it as a test file.

const REGEX_AFTER_CHAR = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await']);

/** @returns {{ text: string, line: number }[]} */
export function stringLiterals(source) {
  const out = [];
  let i = 0;
  let line = 1;
  let lastSignificant = ''; // the last non-space character outside strings and comments
  let lastWord = '';
  const n = source.length;
  const advance = (k = 1) => { for (let j = 0; j < k; j += 1) { if (source[i] === '\n') line += 1; i += 1; } };

  function readQuoted(quote) {
    const start = line;
    let text = '';
    advance(); // the opening quote
    while (i < n && source[i] !== quote) {
      if (source[i] === '\\') { text += source.slice(i, i + 2); advance(2); continue; }
      if (source[i] === '\n') break; // an unterminated literal: stop at the line
      text += source[i]; advance();
    }
    advance(); // the closing quote
    out.push({ text: unescape(text), line: start });
  }

  // A template literal: its text parts, joined by a space where each ${…} stood. Nested templates inside ${…} are read
  // as literals of their own.
  function readTemplate() {
    const start = line;
    const parts = [];
    let text = '';
    advance(); // `
    while (i < n && source[i] !== '`') {
      if (source[i] === '\\') { text += source.slice(i, i + 2); advance(2); continue; }
      if (source[i] === '$' && source[i + 1] === '{') {
        parts.push(text); text = '';
        advance(2);
        readCode('}');
        advance(); // }
        continue;
      }
      text += source[i]; advance();
    }
    advance(); // `
    parts.push(text);
    out.push({ text: unescape(parts.join(' ')), line: start });
  }

  function readRegex() {
    advance(); // /
    let inClass = false;
    while (i < n) {
      const c = source[i];
      if (c === '\\') { advance(2); continue; }
      if (c === '\n') break;
      if (inClass) { if (c === ']') inClass = false; } else if (c === '[') inClass = true; else if (c === '/') { advance(); break; }
      advance();
    }
    while (i < n && /[a-z]/i.test(source[i])) advance(); // flags
  }

  // Code up to `until` (a closing brace of a ${…}) or the end; braces nest.
  function readCode(until) {
    let depth = 0;
    while (i < n) {
      const c = source[i];
      if (until && c === until && depth === 0) return;
      if (c === '/' && source[i + 1] === '/') { while (i < n && source[i] !== '\n') advance(); continue; }
      if (c === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); advance((end < 0 ? n : end + 2) - i); continue; }
      if (c === '\'' || c === '"') { readQuoted(c); lastSignificant = 'x'; lastWord = ''; continue; }
      if (c === '`') { readTemplate(); lastSignificant = 'x'; lastWord = ''; continue; }
      if (c === '/') {
        if (lastSignificant === '' || REGEX_AFTER_CHAR.has(lastSignificant) || REGEX_AFTER_WORD.has(lastWord)) { readRegex(); lastSignificant = 'x'; lastWord = ''; continue; }
      }
      if (c === '{') depth += 1;
      if (c === '}') depth -= 1;
      if (/\s/.test(c)) { advance(); continue; }
      if (/[A-Za-z0-9_$]/.test(c)) {
        let word = '';
        while (i < n && /[A-Za-z0-9_$]/.test(source[i])) { word += source[i]; advance(); }
        lastWord = word; lastSignificant = 'x';
        continue;
      }
      lastSignificant = c; lastWord = '';
      advance();
    }
  }

  readCode(null);
  return out;
}

function unescape(text) {
  return text.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n');
}
