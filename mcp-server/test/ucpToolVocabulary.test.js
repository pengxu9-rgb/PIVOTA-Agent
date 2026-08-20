// UCP dialect: the tool vocabulary a UCP platform actually sends.
//
// THE DEFECT THIS CLOSES. The canonical contract carried a `ucp` field per operation —
// `checkout.create`, `checkout.complete` — and /.well-known/ucp advertised `dev.ucp.shopping.checkout`
// on the back of it. But those dotted strings are Pivota's INTERNAL capability-operation labels. A real
// UCP platform speaks MCP JSON-RPC and sends the spec's FLAT tool names — `create_checkout`,
// `complete_checkout` — which nothing in this repo answered to. So the profile advertised a checkout
// capability whose tools could not be invoked: "advertised but not executable", the exact defect the
// contract's own comments warn about.
//
// WHERE THE NAMES COME FROM. Not a transcribed spec PDF — `src/services/ucpBuyerAgentClient.js`, which
// CALLS real UCP merchants and carries the tool names "verbatim from the live spec" in its TOOL
// constant. Those are the names platforms send us, so the contract mirrors them and this suite pins the
// two together: drift on EITHER side fails CI instead of surfacing in a partner integration.
//
// NO INVENTED NAMES. Only operations with an evidenced spec name join the UCP dialect. Guessing at
// `cancel_checkout` would re-create the same defect one layer down.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_OPERATIONS,
  UCP_DIALECT_OPERATIONS,
  UCP_TOOL_EVIDENCE,
  canonicalOpForUcpTool,
} from '../../safety-kernel/src/protocol/canonicalContract.js';
import {
  commerceToolDefinitions,
  ucpCommerceToolDefinitions,
  commerceToolDefinitionsFor,
} from '../src/commerceToolSurface.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The buyer client's TOOL constant — the in-repo authority for UCP spec tool names. */
function buyerClientToolNames() {
  const src = fs.readFileSync(
    path.join(HERE, '..', '..', 'src', 'services', 'ucpBuyerAgentClient.js'),
    'utf8',
  );
  const block = src.slice(src.indexOf('const TOOL = Object.freeze({'));
  const body = block.slice(0, block.indexOf('});'));
  return new Set([...body.matchAll(/:\s*'([a-z_]+)'/g)].map((m) => m[1]));
}

describe('UCP tool vocabulary is the one platforms actually send', () => {
  test('every mapped ucpTool is a name our own buyer client took from the live spec — or a declared vendor tool', () => {
    const spec = buyerClientToolNames();
    assert.ok(spec.size > 0, 'failed to parse the buyer client TOOL constant');
    const vendor = new Set(UCP_TOOL_EVIDENCE.vendor);
    for (const op of UCP_DIALECT_OPERATIONS) {
      if (vendor.has(op.ucpTool)) {
        // A vendor tool's evidence is Pivota's OWN hosted capability document, so it must belong to the
        // vendor capability — a dev.ucp capability may never carry a name the spec does not know.
        assert.equal(op.capability, 'insights', `${op.ucpTool} is a vendor tool but not on the vendor capability`);
        assert.ok(!spec.has(op.ucpTool), `${op.ucpTool} is declared vendor but IS a spec name — pick one`);
        continue;
      }
      assert.ok(spec.has(op.ucpTool), `${op.ucpTool} is not a spec tool name the buyer client knows`);
    }
  });

  test('the evidence record matches the contract (drift on either side fails here)', () => {
    const mapped = UCP_DIALECT_OPERATIONS.map((o) => o.ucpTool).sort();
    assert.deepEqual(mapped, [...UCP_TOOL_EVIDENCE.mapped, ...UCP_TOOL_EVIDENCE.vendor].sort());
    // The two evidence lists are disjoint: a name is spec-evidenced or vendor-evidenced, never both.
    for (const t of UCP_TOOL_EVIDENCE.vendor) assert.ok(!UCP_TOOL_EVIDENCE.mapped.includes(t), t);
  });

  test('the vendor tools are exactly the ADVERTISED insights operations, spelled like their native twins', () => {
    // Membership of `cc.pivota.insights` and presence on the UCP DIALECT are two different facts. An
    // insights op joins the dialect only when the hosted capability document describes it — until then it
    // carries no `ucpTool` and is native-/mcp-only (recommend_products is the first such op). So the vendor
    // evidence list is the ADVERTISED subset, and the un-advertised ones are asserted to be exactly that:
    // no ucpTool, hence absent from every UCP listing. Asserting over ALL insights ops would force the next
    // native-only decision-layer tool to be advertised before its document exists — the
    // advertised-but-not-executable defect this whole file guards.
    const insights = CANONICAL_OPERATIONS.filter((o) => o.capability === 'insights');
    const advertised = insights.filter((o) => o.ucpTool);
    assert.deepEqual(advertised.map((o) => o.ucpTool).sort(), [...UCP_TOOL_EVIDENCE.vendor].sort());
    for (const op of advertised) assert.equal(op.ucpTool, op.mcp, `${op.id}: one vocabulary on every door`);
    for (const op of insights.filter((o) => !o.ucpTool)) {
      assert.equal(canonicalOpForUcpTool(op.mcp), undefined, `${op.id} has no hosted document: it must not resolve on the UCP dialect`);
      assert.ok(!UCP_TOOL_EVIDENCE.vendor.includes(op.mcp), `${op.id} must not be listed as vendor evidence while unadvertised`);
    }
  });

  test('the dotted internal label is NOT what the dialect dispatches on', () => {
    assert.equal(canonicalOpForUcpTool('checkout.create'), undefined);
    assert.equal(canonicalOpForUcpTool('create_checkout').id, 'create_checkout_session');
  });

  test('spec tools with no canonical counterpart are recorded, not silently dropped', () => {
    for (const t of UCP_TOOL_EVIDENCE.unmappedSpecTools) {
      assert.equal(canonicalOpForUcpTool(t), undefined);
    }
  });

  test('no operation joins the dialect without a flat, evidenced name', () => {
    for (const op of CANONICAL_OPERATIONS) {
      if (!op.ucpTool) continue;
      assert.equal(typeof op.ucpTool, 'string');
      // A dotted value would mean an internal label leaked into the wire vocabulary.
      assert.match(op.ucpTool, /^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('the UCP dialect shares one surface and never forks the money path', () => {
  test('every UCP tool resolves to the SAME canonical operation object as its MCP twin', () => {
    const pairs = [
      ['search_catalog', 'search_catalog'],
      ['get_product', 'get_product'],
      ['create_checkout', 'create_checkout_session'],
      ['update_checkout', 'update_checkout_session'],
      ['get_checkout', 'get_checkout_session'],
      ['complete_checkout', 'complete_checkout_session'],
      ['get_alternatives', 'get_alternatives'],
      ['get_offers', 'get_offers'],
      ['get_intel', 'get_intel'],
    ];
    for (const [ucpName, mcpName] of pairs) {
      const viaUcp = canonicalOpForUcpTool(ucpName);
      const viaMcp = CANONICAL_OPERATIONS.find((o) => o.mcp === mcpName);
      // Identical object, not merely equal: a copy would be a second definition to drift.
      assert.equal(viaUcp, viaMcp, `${ucpName} and ${mcpName} must be the same operation`);
    }
  });

  test('the charging operation keeps every guard on its UCP name', () => {
    // A UCP charge reaching the kernel without requiresPaymentAuthz would be a second, weaker money
    // path — the per-ecosystem fork the canonical contract exists to prevent.
    const complete = canonicalOpForUcpTool('complete_checkout');
    assert.equal(complete.requiresPaymentAuthz, true);
    assert.equal(complete.requiresUserRef, true);
    assert.equal(complete.mutating, true);
  });

  test('UCP declarations expose spec names and never add an operation the MCP door lacks', () => {
    const ucpNames = ucpCommerceToolDefinitions.map((d) => d.name).sort();
    assert.deepEqual(ucpNames, [...UCP_TOOL_EVIDENCE.mapped, ...UCP_TOOL_EVIDENCE.vendor].sort());
    assert.ok(ucpCommerceToolDefinitions.length <= commerceToolDefinitions.length);
    for (const def of ucpCommerceToolDefinitions) {
      assert.ok(def.inputSchema, `${def.name} must carry an input schema`);
      assert.ok(def.description, `${def.name} must carry a description`);
    }
  });

  test('the default dialect is MCP, so every existing caller is untouched', () => {
    assert.equal(commerceToolDefinitionsFor(), commerceToolDefinitions);
    assert.equal(commerceToolDefinitionsFor('mcp'), commerceToolDefinitions);
    assert.equal(commerceToolDefinitionsFor('ucp'), ucpCommerceToolDefinitions);
  });
});
