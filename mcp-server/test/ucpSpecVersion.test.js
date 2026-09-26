// One UCP spec version across BOTH of Pivota's UCP roles.
//
// THE DEFECT THIS CLOSES. Pivota speaks UCP from two sides and each side pinned its own version:
//   - SELLER (inbound): safety-kernel/src/protocol/ucpProfile.js builds `/.well-known/ucp`, and pinned
//     '2026-01-23' — a literal carried in by the squashed kernel-import commit with no rationale recorded
//     anywhere (no comment, no ADR, no doc, no partner constraint).
//   - BUYER (outbound): src/services/ucpBuyerAgentProfile.js pinned '2026-04-08', citing the live
//     carts-and-checkout docs published under https://ucp.dev/2026-04-08/ and a probe that verified against
//     endpoints on that line.
// #1962 then took the UCP tool vocabulary (get_product, create_checkout, …) from the buyer client's TOOL
// constant — the 2026-04-08 line — into the canonical contract that BUILDS the seller profile's capability
// list. The seller therefore advertised `ucp_version: 2026-01-23` over 2026-04-08 tool names: a platform
// negotiating one line against a vocabulary from another.
//
// WHY THE TEST LIVES HERE. It has to load an ESM module (the kernel profile) and a CommonJS module (the
// buyer profile) in one process. This directory already hosts exactly that kind of cross-boundary pin —
// ucpToolVocabulary.test.js pins the kernel contract against the buyer client's TOOL constant — and runs
// under `cd mcp-server && node --test`.
//
// WHAT IT CONSTRAINS. Not "the two strings happen to match today": that a version literal exists in exactly
// ONE file, that both published profiles carry it, and that it can never move BACKWARD past the line the
// advertised tool vocabulary came from. A one-sided bump — re-declaring a literal in either profile — fails
// here rather than in a partner's negotiation.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { buildUcpProfile } from '../../safety-kernel/src/protocol/ucpProfile.js';
import {
  UCP_SPEC_VERSION,
  UCP_SPEC_BASE,
  UCP_SCHEMA_BASE,
  UCP_SERVICE_SCHEMA_BASE,
} from '../../safety-kernel/src/protocol/ucpSpecVersion.cjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The buyer profile is CommonJS; the seller profile is ESM. Loading both here is the whole point.
const { buildUcpBuyerAgentProfile } = require('../../src/services/ucpBuyerAgentProfile.js');

const SELLER_PROFILE_SRC = path.join(HERE, '..', '..', 'safety-kernel', 'src', 'protocol', 'ucpProfile.js');
const BUYER_PROFILE_SRC = path.join(HERE, '..', '..', 'src', 'services', 'ucpBuyerAgentProfile.js');

/** The line the UCP tool vocabulary in the canonical contract was taken from (#1962, via the buyer client). */
const VOCABULARY_SPEC_LINE = '2026-04-08';

function sellerProfile() {
  return buildUcpProfile({
    baseUrl: 'https://shop.pivota.cc',
    mcpEndpoint: 'https://shop.pivota.cc/ucp/mcp',
  });
}

describe('the UCP spec version is one constant, not two pins', () => {
  test('the seller profile advertises the shared constant', () => {
    assert.equal(sellerProfile().ucp.version, UCP_SPEC_VERSION);
  });

  test('the buyer-agent profile advertises the same shared constant', () => {
    const p = buildUcpBuyerAgentProfile({ profileUrl: 'https://agent.pivota.cc/.well-known/ucp-agent' });
    assert.equal(p.ucp.version, UCP_SPEC_VERSION);
  });

  test('seller and buyer publish the SAME version (a one-sided bump fails here)', () => {
    const seller = sellerProfile().ucp.version;
    const buyer = buildUcpBuyerAgentProfile().ucp.version;
    assert.equal(seller, buyer, `seller advertises ${seller} but the buyer agent negotiates ${buyer}`);
  });

  test('every capability entry in the buyer profile carries that same version', () => {
    const { capabilities, services } = buildUcpBuyerAgentProfile().ucp;
    for (const [name, entries] of Object.entries(capabilities)) {
      for (const entry of entries) {
        assert.equal(entry.version, UCP_SPEC_VERSION, `${name} declares ${entry.version}`);
      }
    }
    for (const entry of services['dev.ucp.shopping']) {
      assert.equal(entry.version, UCP_SPEC_VERSION);
      // DOCUMENTS, not directory bases. These asserted `entry.spec === UCP_SPEC_BASE` and
      // `entry.schema === UCP_SCHEMA_BASE` — the bare `.../specification/` and `.../schemas/` prefixes —
      // which is exactly why the two dead URLs survived: the test pinned our own constant back at us instead
      // of anything a merchant could dereference. Both bare bases 404 (measured 2026-08-14).
      assert.equal(entry.spec, `${UCP_SPEC_BASE}overview`);
      assert.equal(entry.schema, `${UCP_SERVICE_SCHEMA_BASE}shopping/mcp.openrpc.json`);
      assert.notEqual(entry.spec, UCP_SPEC_BASE, 'a directory base is not a spec document');
      assert.notEqual(entry.schema, UCP_SCHEMA_BASE, 'a capability-schema base is not a service schema');
      // …and they still cannot name a line other than the pinned one.
      assert.ok(entry.spec.includes(`/${UCP_SPEC_VERSION}/`), 'spec URL must name the pinned version');
      assert.ok(entry.schema.includes(`/${UCP_SPEC_VERSION}/`), 'schema URL must name the pinned version');
    }
  });
});

describe('the shared constant cannot silently lag or be re-forked', () => {
  test('it is a well-formed calendar date', () => {
    assert.match(UCP_SPEC_VERSION, /^\d{4}-\d{2}-\d{2}$/);
    // `new Date('2026-40-08')` is Invalid; round-tripping also rejects e.g. '2026-02-31'.
    assert.equal(new Date(`${UCP_SPEC_VERSION}T00:00:00Z`).toISOString().slice(0, 10), UCP_SPEC_VERSION);
  });

  test('it never moves BACKWARD past the line our advertised tool vocabulary came from', () => {
    // This is the actual defect: the seller profile lagged behind the vocabulary it advertised. Bumping
    // forward is fine and expected; regressing to an older line than get_product/create_checkout/… were
    // taken from re-creates "negotiates one line, speaks another".
    assert.ok(
      UCP_SPEC_VERSION >= VOCABULARY_SPEC_LINE, // ISO dates compare lexicographically
      `UCP_SPEC_VERSION ${UCP_SPEC_VERSION} is older than the ${VOCABULARY_SPEC_LINE} tool vocabulary we advertise`,
    );
  });

  test('neither profile declares a version literal of its own', () => {
    // The mutant this kills: someone re-hardcodes `const DEFAULT_UCP_VERSION = '2026-01-23'` (or any other
    // date) in one profile, which would make the two profiles agree only by coincidence. A bare date in a
    // COMMENT (e.g. "fetched 2026-07-13") is not a literal and is deliberately not matched.
    const bareDateLiteral = /(['"])\d{4}-\d{2}-\d{2}\1/;
    const versionedSpecUrlLiteral = /(['"])[^'"]*ucp\.dev\/\d{4}-\d{2}-\d{2}[^'"]*\1/;
    for (const file of [SELLER_PROFILE_SRC, BUYER_PROFILE_SRC]) {
      const src = fs.readFileSync(file, 'utf8');
      assert.equal(bareDateLiteral.test(src), false, `${path.basename(file)} declares its own version literal`);
      assert.equal(
        versionedSpecUrlLiteral.test(src),
        false,
        `${path.basename(file)} hardcodes a versioned ucp.dev URL instead of deriving it`,
      );
      assert.match(src, /ucpSpecVersion\.cjs/, `${path.basename(file)} must source its version from the shared module`);
    }
  });
});
