/**
 * No free-form `${{ }}` interpolated into a GitHub Actions `run:` body.
 *
 * WHY THIS EXISTS. `${{ }}` inside a `run:` is TEXTUAL SUBSTITUTION performed
 * before the shell ever parses the script, so a free-form workflow input becomes
 * executable shell.
 *
 * THE MISREADING THAT LET 105 OF THESE ACCUMULATE: double quotes look like they
 * protect. They do not. `--product-ids "${{ inputs.product_ids }}"` renders the
 * attacker's text INSIDE the quotes, and `$( )` command substitution is still
 * active inside double quotes — so no quote-breaking is needed at all.
 * Demonstrated by execution, not argued:
 *
 *     product_ids = $(echo "exfil=${DATABASE_URL}")
 *       -> args=--product-ids exfil=postgres://REAL_PROD_SECRET@db/prod
 *       -> "script completed normally"
 *
 * The run looks like a routine ops run while exfiltrating the prod database URL.
 *
 * SCOPE — deliberately narrow, so this gate cannot cry wolf (a noisy gate gets
 * deleted, which is the real failure mode):
 *   - Only `inputs.*` / `github.event.inputs.*` declared `type: string`, or
 *     declared with no `type:` at all. GitHub constrains `boolean` and `choice`
 *     to values it generates, so those cannot carry a payload.
 *   - Only `run:` bodies. `if:` and `with:` are expression contexts, evaluated
 *     rather than pasted into a shell.
 *   - But an `env.` READ inside a run body (`${{ env.X }}`) IS flagged. That is
 *     the bypass this gate's own advice invites: told to "pass it through env:",
 *     someone adds the `env:` entry and then writes `${{ env.VAR }}` in the body
 *     instead of `"$VAR"` — byte-for-byte as exploitable as the original bug.
 *
 * THE FIX IS ALWAYS THE SAME: put the value in the step's `env:` and reference
 * it as `"$VAR"`. Never quoting tricks — quoting text that has already been
 * substituted is too late.
 *
 * Deliberately dependency-free (no js-yaml): it is only a transitive dep here,
 * and a security gate should not be one `npm prune` away from not running.
 */

const fs = require('fs');
const path = require('path');

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');

const EXPR = /\$\{\{\s*([\s\S]*?)\s*\}\}/g;
const INPUT_REF = /\b(?:inputs|github\.event\.inputs)\.([A-Za-z0-9_-]+)/g;

// Laundered references — the same hazard one level of indirection away.
const LAUNDERED = [
  [/(?<![\w./'"])env\./, '`${{ env.X }}` in a run body is still textual substitution — reference it as "$X"'],
  [/\bsteps\.[A-Za-z0-9_-]+\.outputs\./, 'a step output can carry an unvalidated input — route it through env: and use "$X"'],
  [/\btoJSON\s*\(\s*(?:inputs|github\.event)\b/, 'toJSON() of an input/event context dumps every free-form value into the shell'],
  [/\binputs\s*\[/, 'index syntax reaches the same free-form inputs as inputs.x'],
];

// Contexts an outsider can influence with NO repo access at all. None exist in a
// run body in this repo today; this arm guards genuine unauthenticated RCE.
const UNTRUSTED = [
  'github.event.issue.', 'github.event.pull_request.', 'github.event.comment',
  'github.event.review', 'github.event.discussion', 'github.head_ref',
  'github.event.head_commit', 'github.event.client_payload',
];

function listWorkflows() {
  return fs.readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((f) => path.join(WORKFLOW_DIR, f));
}

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * Declared type of every dispatch/call input. Hand-rolled rather than a YAML
 * dep: we need exactly two facts (input names, their `type:`), and the shape is
 * fixed. Missing `type:` defaults to string, matching Actions itself — an input
 * with no declared type IS free-form, so that default is correctness, not
 * caution.
 */
function declaredInputTypes(text) {
  const lines = text.split('\n');
  // Track EXPLICIT declarations separately from the default. Defaulting to
  // 'string' eagerly at name-time is a real bug: the later `type: boolean` line
  // can then never overwrite it, and every boolean input reads as free-form —
  // 21 false positives on this repo's own workflows, which is exactly how a gate
  // earns being switched off.
  const explicit = {};
  const seen = new Set();
  let inInputs = false;
  let inputsIndent = -1;
  let currentName = null;
  let nameIndent = -1;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const ind = indentOf(line);
    const trimmed = line.trim();

    if (/^inputs:\s*$/.test(trimmed)) {
      inInputs = true; inputsIndent = ind; currentName = null; continue;
    }
    if (inInputs && ind <= inputsIndent) { inInputs = false; currentName = null; }
    if (!inInputs) continue;

    const nameMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*(\{.*\})?\s*$/);
    if (nameMatch && (currentName === null || ind <= nameIndent)) {
      currentName = nameMatch[1];
      nameIndent = ind;
      seen.add(currentName);
      const inline = nameMatch[2];
      const t = inline && inline.match(/type:\s*([A-Za-z]+)/);
      if (t) {
        // Weakest guarantee wins if a name is declared on both triggers.
        if (explicit[currentName] !== 'string') explicit[currentName] = t[1];
      }
      continue;
    }
    const typeMatch = trimmed.match(/^type:\s*([A-Za-z]+)\s*$/);
    if (typeMatch && currentName && ind > nameIndent) {
      if (explicit[currentName] !== 'string') explicit[currentName] = typeMatch[1];
    }
  }
  // Missing `type:` defaults to string, matching Actions itself — an input with
  // no declared type IS free-form, so this default is correctness, not caution.
  const types = {};
  for (const name of seen) types[name] = explicit[name] || 'string';
  return types;
}

/**
 * Every `run:` body — ALL of YAML's scalar forms, not just `run: |`.
 *
 * The first version matched `/run:\s*\|-?$/` only, and an adversarial review
 * showed five valid forms sailing straight through the gate: a plain one-line
 * `- run: echo ${{ inputs.x }}`, folded `>` and `>-`, a double-quoted scalar,
 * and an explicit indent indicator `|2`. This repo has 58 single-line `run:`
 * steps today, so that was not a hypothetical hole — it was the gate being blind
 * to the most common form in the tree.
 */
function runBodies(text) {
  const lines = text.split('\n');
  const bodies = [];
  for (let i = 0; i < lines.length; i += 1) {
    // `run:` possibly as a list item, then either a block indicator
    // (| > with optional +/- chomping and an optional explicit indent digit)
    // or an inline scalar on the same line.
    const m = lines[i].match(/^(\s*)(-\s+)?run:\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length + (m[2] ? m[2].length : 0);
    const rest = m[3].trim();

    const isBlock = /^[|>][+-]?\d*$/.test(rest) || /^[|>]\d*[+-]?$/.test(rest);
    if (!isBlock) {
      // Inline scalar: the value is on this line (possibly quoted). Anything
      // after `run:` is the script.
      if (rest) bodies.push({ startLine: i + 1, body: rest });
      continue;
    }
    let j = i + 1;
    const collected = [];
    for (; j < lines.length; j += 1) {
      if (!lines[j].trim()) { collected.push(lines[j]); continue; }
      if (indentOf(lines[j]) <= indent) break;
      collected.push(lines[j]);
    }
    bodies.push({ startLine: i + 1, body: collected.join('\n') });
    i = j - 1;
  }
  return bodies;
}

function scan(file) {
  const text = fs.readFileSync(file, 'utf8');
  const types = declaredInputTypes(text);
  const name = path.basename(file);
  const freeForm = [];
  const untrusted = [];

  for (const { startLine, body } of runBodies(text)) {
    EXPR.lastIndex = 0;
    let m;
    while ((m = EXPR.exec(body)) !== null) {
      const expr = m[1];
      const where = `${name} (run: block at line ~${startLine})`;

      INPUT_REF.lastIndex = 0;
      let im;
      while ((im = INPUT_REF.exec(expr)) !== null) {
        const declared = types[im[1]] || 'UNDECLARED';
        if (declared === 'string' || declared === 'UNDECLARED') {
          freeForm.push(`${where}: \${{ ${expr} }}  (inputs.${im[1]} is ${declared})`);
        }
      }
      for (const [pattern, why] of LAUNDERED) {
        if (pattern.test(expr)) freeForm.push(`${where}: \${{ ${expr} }} — ${why}`);
      }
      const lower = expr.toLowerCase();
      for (const bad of UNTRUSTED) {
        if (lower.includes(bad)) untrusted.push(`${where}: \${{ ${expr} }}`);
      }
    }
  }
  return { freeForm, untrusted };
}

describe('GitHub Actions: no free-form interpolation into run: bodies', () => {
  const files = listWorkflows();

  // A gate that silently checks nothing is worse than no gate.
  test('there are workflows to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files.map((f) => [path.basename(f), f]))(
    '%s has no free-form input in a run: body',
    (_name, file) => {
      const { freeForm } = scan(file);
      expect(freeForm).toEqual([]);
    },
  );

  test.each(files.map((f) => [path.basename(f), f]))(
    '%s has no attacker-controllable context in a run: body',
    (_name, file) => {
      const { untrusted } = scan(file);
      expect(untrusted).toEqual([]);
    },
  );

  // The parametrised tests above only ever see workflows that PASS, so on a
  // clean tree they cannot distinguish "correct" from "inert". These pin the
  // classifier against both answers.
  describe('the classifier itself', () => {
    const withInputs = (yaml) => declaredInputTypes(yaml);

    test('reads block-form types', () => {
      const t = withInputs([
        'on:', '  workflow_dispatch:', '    inputs:',
        '      free:', '        type: string',
        '      flag:', '        type: boolean',
        '      untyped:', '        description: no type key',
      ].join('\n'));
      expect(t.free).toBe('string');
      expect(t.flag).toBe('boolean');
      expect(t.untyped).toBe('string');
    });

    test('reads inline-form types', () => {
      const t = withInputs('on:\n  workflow_dispatch:\n    inputs:\n      flag: {type: boolean}\n');
      expect(t.flag).toBe('boolean');
    });

    test('detects a free-form input in a run body, and ignores a boolean one', () => {
      const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wfgate-'));
      const write = (body) => {
        const p = path.join(dir, 'w.yml');
        fs.writeFileSync(p, [
          'on:', '  workflow_dispatch:', '    inputs:',
          '      free:', '        type: string',
          '      flag:', '        type: boolean',
          'jobs:', '  j:', '    steps:', '      - run: |', `          ${body}`,
        ].join('\n'));
        return p;
      };
      expect(scan(write('echo ${{ inputs.free }}')).freeForm.length).toBe(1);
      expect(scan(write('echo ${{ inputs.flag }}')).freeForm.length).toBe(0);
      expect(scan(write('echo ${{ env.LEAK }}')).freeForm.length).toBe(1);
      expect(scan(write('echo ${{ toJSON(inputs) }}')).freeForm.length).toBe(1);
      expect(scan(write("echo ${{ inputs['free'] }}")).freeForm.length).toBe(1);
      expect(scan(write('echo ${{ github.run_id }}')).freeForm.length).toBe(0);
      expect(scan(write("echo ${{ hashFiles('.env.example') }}")).freeForm.length).toBe(0);
      expect(scan(write('echo "$IN_FREE"')).freeForm.length).toBe(0);
      expect(scan(write('echo ${{ github.event.pull_request.title }}')).untrusted.length).toBe(1);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('every YAML scalar form of run: is scanned, not just `run: |`', () => {
      // An adversarial review found FIVE forms bypassing the first version of
      // this gate. The repo has 58 single-line `run:` steps, so the plain-scalar
      // form is the most common one in the tree — the gate was blind to exactly
      // what it was most likely to meet.
      const os = require('os');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfgate-forms-'));
      const write = (runLine, extra = '') => {
        const p = path.join(dir, 'w.yml');
        fs.writeFileSync(p, [
          'on:', '  workflow_dispatch:', '    inputs:',
          '      pwn:', '        type: string',
          'jobs:', '  j:', '    steps:', `      - ${runLine}`, extra,
        ].filter(Boolean).join('\n'));
        return p;
      };
      const PAYLOAD = 'echo ${{ inputs.pwn }}';
      const forms = [
        [`run: ${PAYLOAD}`, ''],                                  // plain scalar
        ['run: |', `          ${PAYLOAD}`],                       // literal block
        ['run: |-', `          ${PAYLOAD}`],                      // literal, chomped
        ['run: >', `          ${PAYLOAD}`],                       // folded
        ['run: >-', `          ${PAYLOAD}`],                      // folded, chomped
        ['run: |2', `          ${PAYLOAD}`],                      // explicit indent
        [`run: "${PAYLOAD}"`, ''],                                // double-quoted
      ];
      for (const [runLine, extra] of forms) {
        expect({
          form: runLine,
          hits: scan(write(runLine, extra)).freeForm.length,
        }).toEqual({ form: runLine, hits: 1 });
      }
      // and a benign single-line run: must still pass
      expect(scan(write('run: npm ci')).freeForm.length).toBe(0);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
