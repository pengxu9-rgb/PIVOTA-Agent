"""Emit src/services/contentKeyUnicodeTable.js from the Python authority's own unicodedata.

WHY THIS EXISTS (issue #1916, review of PR #1938)
-------------------------------------------------
The first Node port of `catalog_identity.py` approximated two Python behaviours with
JS character classes. Both approximations were wrong, and a differential fuzz put the
disagreement at 15.9% of realistic beauty inputs:

  1. Python drops marks via `unicodedata.combining(c)` — the canonical combining
     CLASS. The port used `\\p{Mark}`, the general CATEGORY. 1,589 codepoints are
     category Mark with combining class 0: Python KEEPS them (and the following
     `[^\\w\\s\\-]` pass then turns each into a SPACE), while the port DELETED them
     with no space. Thai and Devanagari titles forked, token boundaries and all.

  2. Python's `str.strip()`/`str.split()` use Python's whitespace definition.
     The port used JS `\\s`. Six codepoints differ in both directions — notably
     U+FEFF (a UTF-8 BOM decoded into a CSV field) is JS-whitespace but not
     Python's, and U+0085/U+001C-001F are Python's but not JS's.

Neither can be expressed as a JS regex class, because JS exposes no combining-class
property and no "Python whitespace" property. So the sets are DERIVED FROM THE
AUTHORITY ITSELF and checked in as generated data — never hand-listed, and never
re-derived from a JS approximation of what Python probably means.

UNICODE VERSION IS ASSERTED, NOT PINNED
---------------------------------------
The emitted module records the Unicode version this table came from. Node ships its
own (ICU) Unicode version, which will differ, and ~9,400 recently-assigned codepoints
are letters/digits to one and unassigned to the other. Pinning ICU across two runtimes
is not worth it for codepoints no beauty catalog contains. Instead the skew is made
VISIBLE: the table declares its provenance, and tests/content_key_authority.test.js
asserts the declared version so a silent runtime upgrade cannot quietly move keys.

Run with the interpreter that matches the deployed backend:
  /path/to/pivota-backend/.venv/bin/python scripts/generate-content-key-unicode-table.py
"""

from __future__ import annotations

import sys
import unicodedata
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "src" / "services" / "contentKeyUnicodeTable.js"
MAX_CP = 0x110000


def combining_ranges() -> list[tuple[int, int]]:
    """Codepoints Python's `unicodedata.combining()` reports as nonzero, as ranges."""
    ranges: list[list[int]] = []
    for cp in range(MAX_CP):
        if unicodedata.combining(chr(cp)) == 0:
            continue
        if ranges and ranges[-1][1] == cp - 1:
            ranges[-1][1] = cp
        else:
            ranges.append([cp, cp])
    return [(a, b) for a, b in ranges]


def python_whitespace() -> list[int]:
    """Codepoints Python treats as whitespace for str.strip()/str.split()."""
    return [cp for cp in range(MAX_CP) if chr(cp).isspace()]


def js_literal(cp: int) -> str:
    return f"0x{cp:04x}"


def main() -> int:
    ranges = combining_ranges()
    ws = python_whitespace()
    covered = sum(b - a + 1 for a, b in ranges)

    range_lines = []
    for i in range(0, len(ranges), 4):
        chunk = ranges[i : i + 4]
        range_lines.append(
            "  " + " ".join(f"[{js_literal(a)},{js_literal(b)}]," for a, b in chunk)
        )

    ws_lines = []
    for i in range(0, len(ws), 8):
        ws_lines.append("  " + " ".join(f"{js_literal(cp)}," for cp in ws[i : i + 8]))

    body = f"""'use strict';
/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate with:
 *   <pivota-backend venv python> scripts/generate-content-key-unicode-table.py
 *
 * Source of truth: Python's `unicodedata`, as used by
 * pivota-backend/services/catalog_identity.py — the authority that mints
 * catalog_products.content_key. See issue #1916.
 *
 * These two sets cannot be written as JS regex classes: JS exposes no canonical
 * combining class, and no "Python whitespace" property. Approximating them with
 * \\p{{Mark}} and \\s is what made the first port of this module disagree with the
 * authority on 15.9% of realistic inputs.
 *
 * Generated from Unicode {unicodedata.unidata_version} (Python {sys.version_info.major}.{sys.version_info.minor}).
 * Node's own Unicode version will differ; that skew is asserted, not pinned —
 * see tests/content_key_authority.test.js.
 */

/** Unicode version of the Python runtime this table was derived from. */
const PYTHON_UNICODE_VERSION = '{unicodedata.unidata_version}';

/**
 * Inclusive [start, end] ranges of codepoints with a NONZERO canonical combining
 * class — exactly the set `unicodedata.combining(c) != 0` selects.
 * {covered} codepoints in {len(ranges)} ranges.
 */
const NONZERO_COMBINING_RANGES = [
{chr(10).join(range_lines)}
];

/** Codepoints Python's str.strip()/str.split() treat as whitespace ({len(ws)} total). */
const PYTHON_WHITESPACE = new Set([
{chr(10).join(ws_lines)}
]);

let COMBINING_LOOKUP = null;

/** True iff Python would report a nonzero combining class for this codepoint. */
function hasNonzeroCombiningClass(codePoint) {{
  if (!COMBINING_LOOKUP) {{
    COMBINING_LOOKUP = new Set();
    for (const [start, end] of NONZERO_COMBINING_RANGES) {{
      for (let cp = start; cp <= end; cp += 1) COMBINING_LOOKUP.add(cp);
    }}
  }}
  return COMBINING_LOOKUP.has(codePoint);
}}

/** True iff Python's str.isspace() is true for this codepoint. */
function isPythonWhitespace(codePoint) {{
  return PYTHON_WHITESPACE.has(codePoint);
}}

module.exports = {{
  PYTHON_UNICODE_VERSION,
  NONZERO_COMBINING_RANGES,
  PYTHON_WHITESPACE,
  hasNonzeroCombiningClass,
  isPythonWhitespace,
}};
"""

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(body, encoding="utf-8")
    print(
        f"wrote {OUT}\n"
        f"  unicode {unicodedata.unidata_version} (python {sys.version_info.major}.{sys.version_info.minor})\n"
        f"  nonzero-combining: {covered} codepoints in {len(ranges)} ranges\n"
        f"  python whitespace: {len(ws)} codepoints"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
